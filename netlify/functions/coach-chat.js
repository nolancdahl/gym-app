// Netlify function: calls Claude (Sonnet 4.6) on behalf of the Arnold chat.
//
// Why server-side: the Anthropic API key must never ship to the browser. The frontend POSTs the
// chat history + a snapshot of the user's gym profile here; we build a system prompt and call Claude.
//
// Prompt caching: the system prompt (persona + user context) is marked with cache_control so
// follow-up turns in the same chat hit cache. Sonnet 4.6's minimum cacheable prefix is 2048
// tokens — short prompts silently skip caching, which is fine (no cost, no error).
import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-6'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
}

const formatUserContext = (ctx) => {
  const parts = []
  const p = (ctx && ctx.profile && typeof ctx.profile === 'object') ? ctx.profile : {}

  if (p.name && String(p.name).trim()) parts.push(`Name: ${String(p.name).trim()}`)

  const stats = []
  if (p.age && String(p.age).trim()) stats.push(`age ${String(p.age).trim()}`)
  if (p.height && String(p.height).trim()) stats.push(`height ${String(p.height).trim()}`)
  if (p.weight && String(p.weight).trim()) stats.push(`weight ${String(p.weight).trim()}`)
  if (p.rhr && String(p.rhr).trim()) stats.push(`resting HR ${String(p.rhr).trim()}`)
  if (stats.length > 0) parts.push(`Stats: ${stats.join(', ')}.`)

  if (p.goals && String(p.goals).trim()) {
    parts.push(`Goals & focus (their own words):\n${String(p.goals).trim()}`)
  }
  if (p.injuries && String(p.injuries).trim()) {
    parts.push(`Injuries & movement limits (avoid programming around these):\n${String(p.injuries).trim()}`)
  }

  // Optional: current program location, if the frontend sends it
  if (ctx && ctx.currentWeek && ctx.currentDay) {
    parts.push(`Currently on Week ${ctx.currentWeek}, day "${ctx.currentDay}" of their program.`)
  }

  return parts.length > 0
    ? parts.join('\n\n')
    : '(No profile data saved yet — keep advice general and nudge them to fill in stats, goals, and injuries on the Profile tab so you can tailor future answers.)'
}

const buildSystemPrompt = (userContext = {}) => [
  'You are Arnold — a direct, no-nonsense strength coach inside the "Nolán\'s Gym" workout tracking app.',
  '',
  'PERSONALITY',
  '- Veteran coach voice: confident, plain-spoken, motivating without being a hypeman.',
  '- Concise (2–4 short paragraphs unless they explicitly ask for depth).',
  '- Practical, grounded in real programming: progressive overload, recovery, fundamentals.',
  '- Honest. If a question reveals a bad idea (ego-lifting, ignoring an injury, undereating), call it out and explain why.',
  '- Reference their actual profile data silently when relevant — do not list it back at them.',
  '',
  'EXPERTISE',
  '- Strength training: squat / bench / deadlift / overhead press mechanics, accessory selection, programming structures (linear progression, periodization, deloads).',
  '- Hypertrophy, conditioning, mobility, and how to balance them with strength work.',
  '- Recovery: sleep, protein, soreness vs. injury, deload timing, HR / HRV interpretation.',
  '- Respect any injuries / movement limits the user has saved on their profile.',
  '',
  'FORMATTING (the chat UI renders plain text only — no markdown)',
  '- Do NOT use ** for bold or _ for italics. They appear as literal characters in the bubble.',
  '- For emphasis, use CAPS sparingly.',
  '- For section breaks, use a dashed line: --------',
  '- For lists, use plain bullets with leading "- " (or "• ").',
  '- Keep paragraphs short. Blank lines between paragraphs are fine.',
  '',
  'USER PROFILE',
  '',
  formatUserContext(userContext),
  ...(userContext.crossApp ? ['', '--------', '', userContext.crossApp] : []),
  '',
  'Address the user directly. Use their stats, goals, and injuries to ground advice when relevant. If they have not filled something in, do not invent values — work with what is there and nudge them to fill it in.',
].join('\n')

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in Netlify environment variables.' }),
    }
  }

  let payload
  try { payload = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) } }

  const { messages = [], userContext = {} } = payload

  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'messages must be a non-empty array' }) }
  }

  // Normalize messages: frontend uses { role: 'user' | 'coach', text }; the API wants
  // { role: 'user' | 'assistant', content }. Drop empties to avoid API 400s.
  const apiMessages = messages
    .map((m) => {
      const role = (m.role === 'coach' || m.role === 'arnold' || m.role === 'assistant') ? 'assistant' : 'user'
      const text = (m.text ?? m.content ?? '').toString().trim()
      return text ? { role, content: text } : null
    })
    .filter(Boolean)

  if (apiMessages.length === 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'No non-empty messages provided' }) }
  }
  if (apiMessages[0].role !== 'user') {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'First message must be from the user' }) }
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const systemPrompt = buildSystemPrompt(userContext)

  try {
    // Sonnet 4.6 default effort is "high" — too slow for interactive chat. Drop to "low" with
    // thinking disabled; per Sonnet 4.6 chat guidance this matches or beats older no-thinking
    // performance while keeping latency tight.
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: apiMessages,
    })

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        text,
        usage: response.usage,
        stop_reason: response.stop_reason,
      }),
    }
  } catch (e) {
    console.error('coach-chat error:', e && (e.message || e))
    const status = (e && typeof e.status === 'number' && e.status >= 400 && e.status < 600) ? e.status : 500
    return {
      statusCode: status,
      headers: corsHeaders,
      body: JSON.stringify({ error: (e && e.message) || 'Arnold could not respond right now.' }),
    }
  }
}
