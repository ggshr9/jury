/**
 * Reviewer adapters for Experiment 0.
 *
 * Each adapter wraps one model behind a uniform `review(context)` interface.
 * The point here is NOT to be production-ready — we want the simplest thing
 * that produces a comparable Finding[] from each model so we can measure
 * the consensus lift.
 *
 * Design notes:
 * - All reviewers use the same system prompt (role: general-correctness)
 *   for the baseline run. Role-specialization is deferred to after
 *   Experiment 0 proves the core hypothesis.
 * - All reviewers are asked to output strict JSON with a schema. Parse
 *   failures → single self-repair retry → regex extraction → fail.
 * - Timeouts are 180s per reviewer. A reviewer that dies doesn't break
 *   the run — its findings come back as an empty list with an error.
 */

import type { Finding, Severity, Category } from './types'

export interface ReviewContext {
    bugId: string
    diff: string           // unified diff of the bug-introducing commit
    touchedFiles: string[] // paths from diff header, for prompt framing
}

export interface Reviewer {
    name: string           // short key; used in metrics
    model: string          // for display
    review(context: ReviewContext): Promise<Finding[]>
}

// ─── shared prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a code review expert. You will be shown a unified git diff that introduces a bug. Your job is to identify the bug.

Output JSON ONLY. No prose, no code fences, no markdown. Exactly this structure:

{
  "findings": [
    {
      "file": "relative/path/to/file.ts",
      "line": 42,
      "severity": "critical" | "important" | "minor",
      "category": "logic-error" | "null-deref" | "off-by-one" | "auth" | "injection" | "race-condition" | "data-integrity" | "performance" | "naming" | "other",
      "title": "short one-line summary",
      "description": "2-3 sentences explaining the bug and why it matters"
    }
  ]
}

Rules:
- Focus on real bugs (correctness, security, concurrency, data integrity). Skip style nits unless they indicate a bug.
- Up to 10 findings. Rank by severity.
- If the diff looks clean, output {"findings": []}.
- Use the exact file paths shown in the diff header, no prefix.`

const USER_TEMPLATE = (diff: string) =>
    `Review this diff for bugs. Output JSON only.

\`\`\`diff
${diff}
\`\`\``

// ─── parsing ────────────────────────────────────────────────────

function tryExtractJson(text: string): unknown | null {
    // Strip markdown code fences if present
    const cleaned = text
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim()

    try { return JSON.parse(cleaned) } catch {}

    // Find first { to matching }
    const firstBrace = cleaned.indexOf('{')
    if (firstBrace < 0) return null
    let depth = 0
    for (let i = firstBrace; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++
        else if (cleaned[i] === '}') {
            depth--
            if (depth === 0) {
                try { return JSON.parse(cleaned.slice(firstBrace, i + 1)) }
                catch { return null }
            }
        }
    }
    return null
}

function normalizeFindings(raw: unknown, reviewerName: string): Finding[] {
    if (!raw || typeof raw !== 'object') return []
    const findingsRaw = (raw as Record<string, unknown>).findings
    if (!Array.isArray(findingsRaw)) return []

    const out: Finding[] = []
    for (const f of findingsRaw) {
        if (!f || typeof f !== 'object') continue
        const o = f as Record<string, unknown>
        const file = typeof o.file === 'string' ? o.file : ''
        const line = typeof o.line === 'number' ? o.line : undefined
        const severity = normalizeSeverity(o.severity)
        const category = normalizeCategory(o.category)
        const title = typeof o.title === 'string' ? o.title : ''
        const description = typeof o.description === 'string' ? o.description : ''
        if (!file || !title) continue
        out.push({ file, line, severity, category, title, description, reviewer: reviewerName })
    }
    return out
}

function normalizeSeverity(x: unknown): Severity {
    if (x === 'critical' || x === 'important' || x === 'minor' || x === 'info') return x
    // map high/medium/low aliases
    if (x === 'high') return 'critical'
    if (x === 'medium') return 'important'
    if (x === 'low') return 'minor'
    return 'minor'
}

function normalizeCategory(x: unknown): Category {
    const KNOWN: Category[] = [
        'logic-error', 'off-by-one', 'null-deref', 'type-mismatch',
        'auth', 'injection', 'secret-leak', 'crypto', 'ssrf', 'csrf', 'xss',
        'race-condition', 'deadlock', 'async-invariant', 'channel-hygiene',
        'data-integrity', 'migration-unsafe', 'constraint-violation', 'encoding',
        'quadratic', 'n-plus-one', 'memory-leak', 'blocking-io',
        'naming', 'style', 'doc-formatting', 'dead-code', 'duplication', 'complexity',
        'coverage-gap', 'flaky-test', 'weak-assertion', 'other',
    ]
    if (typeof x === 'string' && KNOWN.includes(x as Category)) return x as Category
    return 'other'
}

// ─── OpenAI-compatible chat completion caller ────────────────────

interface ChatCompletionOpts {
    baseUrl: string
    apiKey: string
    model: string
    systemPrompt: string
    userPrompt: string
    temperature?: number
    timeoutMs?: number
    maxTokens?: number
    jsonMode?: boolean
    /** Forwarded as request body `chat_template_kwargs`. Needed for Kimi
     *  K2.5 to disable its verbose chain-of-thought: `{ thinking: false }`. */
    chatTemplateKwargs?: Record<string, unknown>
}

async function callChatCompletion(opts: ChatCompletionOpts): Promise<string> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000)

    try {
        const body: Record<string, unknown> = {
            model: opts.model,
            messages: [
                { role: 'system', content: opts.systemPrompt },
                { role: 'user', content: opts.userPrompt },
            ],
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 4096,
        }
        if (opts.jsonMode) body.response_format = { type: 'json_object' }
        if (opts.chatTemplateKwargs) body.chat_template_kwargs = opts.chatTemplateKwargs

        const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        })
        if (!res.ok) {
            const text = await res.text()
            throw new Error(`${opts.model} HTTP ${res.status}: ${text.slice(0, 200)}`)
        }
        // Some reasoning-capable models (Kimi K2.5, DeepSeek Reasoner) return
        // `content: null` when the thinking trace was not stopped early, and
        // put the visible answer under `reasoning_content`. We accept either
        // — downstream parser handles JSON-in-noise anyway.
        const json = await res.json() as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string } }> }
        const msg = json.choices?.[0]?.message
        return (msg?.content ?? msg?.reasoning_content ?? '').toString()
    } finally {
        clearTimeout(t)
    }
}

async function reviewViaChatApi(
    opts: Omit<ChatCompletionOpts, 'systemPrompt' | 'userPrompt'>,
    ctx: ReviewContext,
    reviewerName: string,
): Promise<Finding[]> {
    const raw = await callChatCompletion({
        ...opts,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: USER_TEMPLATE(ctx.diff),
    })
    // Stash raw output for debugging — the runner will save it alongside findings.
    ;(globalThis as Record<string, unknown>).__jury_last_raw = raw
    let parsed = tryExtractJson(raw)
    if (!parsed) {
        // self-repair: ask the model to fix its own JSON
        const repair = await callChatCompletion({
            ...opts,
            systemPrompt: 'You output valid JSON only. No prose.',
            userPrompt: `The following should be JSON matching {"findings": [...]} but failed to parse. Output JUST the corrected JSON:\n\n${raw}`,
            timeoutMs: 60_000,
        }).catch(() => '')
        parsed = tryExtractJson(repair)
    }
    return normalizeFindings(parsed, reviewerName)
}

// ─── concrete reviewers ─────────────────────────────────────────

export class AnthropicReviewer implements Reviewer {
    name = 'claude-sonnet'
    model: string
    constructor(model = 'claude-sonnet-4-6') { this.model = model }

    async review(ctx: ReviewContext): Promise<Finding[]> {
        const key = requireEnv('ANTHROPIC_API_KEY')
        // Anthropic uses its own messages API (not OpenAI-compatible chat).
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 180_000)
        try {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: this.model,
                    max_tokens: 2048,
                    system: SYSTEM_PROMPT,
                    messages: [{ role: 'user', content: USER_TEMPLATE(ctx.diff) }],
                    temperature: 0.2,
                }),
                signal: ctrl.signal,
            })
            if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
            const json = await res.json() as { content?: Array<{ type?: string; text?: string }> }
            const text = (json.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
            const parsed = tryExtractJson(text)
            return normalizeFindings(parsed, this.name)
        } finally {
            clearTimeout(t)
        }
    }
}

export class DeepSeekReviewer implements Reviewer {
    name = 'deepseek'
    model = 'deepseek-chat'
    async review(ctx: ReviewContext): Promise<Finding[]> {
        return reviewViaChatApi({
            baseUrl: 'https://api.deepseek.com',
            apiKey: requireEnv('DEEPSEEK_API_KEY'),
            model: this.model,
            jsonMode: true,
        }, ctx, this.name)
    }
}

export class KimiOnPremReviewer implements Reviewer {
    name = 'kimi'
    model = '/data/models/Kimi-K2.5'
    async review(ctx: ReviewContext): Promise<Finding[]> {
        return reviewViaChatApi({
            baseUrl: process.env.KIMI_BASE_URL ?? 'http://10.84.10.22:8003',
            apiKey: requireEnv('COMPASS_LLM_ONPREM_KEY'),
            model: this.model,
            // Kimi K2.5 auto-reasons; disable to get a direct JSON answer
            // matching compass/llm's production config.
            chatTemplateKwargs: { thinking: false },
            // Thinking-off still generates longer replies than base chat.
            maxTokens: 4096,
            // Kimi on-prem is slower than API services; give it room.
            timeoutMs: 240_000,
        }, ctx, this.name)
    }
}

/** ZenMux aggregator — can serve Gemini, GPT-4/5, Claude, etc. Routing
 *  determined by the `model` field we pass. Useful for structurally
 *  diverse models with a single key. */
export class ZenMuxReviewer implements Reviewer {
    name: string
    model: string
    constructor(name: string, model: string) {
        this.name = name
        this.model = model
    }
    async review(ctx: ReviewContext): Promise<Finding[]> {
        return reviewViaChatApi({
            baseUrl: 'https://zenmux.ai/api',
            apiKey: requireEnv('ZENMUX_API_KEY'),
            model: this.model,
        }, ctx, this.name)
    }
}

/** Internal Shanghai-Electric gateway exposing 8+ models (Qwen3, MiniMax,
 *  GLM, DeepSeek-R1, Gemma-4, etc.) behind one OpenAI-compatible API.
 *  See NEBULA_API_KEY in .env; company-internal network only. */
export class NebulaReviewer implements Reviewer {
    name: string
    model: string
    constructor(name: string, model: string) {
        this.name = name
        this.model = model
    }
    async review(ctx: ReviewContext): Promise<Finding[]> {
        // Reasoning models (R1, MiniMax, some Qwen variants) may route their
        // answer to reasoning_content instead of content — the shared adapter
        // already handles that fallback.
        return reviewViaChatApi({
            baseUrl: 'https://ai.nebula-starlink.shanghai-electric.com',
            apiKey: requireEnv('NEBULA_API_KEY'),
            model: this.model,
            // MiniMax burns a lot of tokens on reasoning trace before
            // producing the JSON answer; 4K was not enough and left content
            // empty. 8K gives headroom for ~500-line diffs.
            maxTokens: 8192,
            // MiniMax/R1 reason a lot, need more time
            timeoutMs: 300_000,
        }, ctx, this.name)
    }
}

/** GPT-5.4 via Codex CLI. Spawns `codex task --model gpt-5.4 …` and
 *  expects JSON on stdout. TODO if we end up using this — for v0 we'll
 *  stick with the direct API path via ZenMux or OpenAI. */
// export class CodexReviewer implements Reviewer { ... }

function requireEnv(name: string): string {
    const v = process.env[name]
    if (!v) throw new Error(`env ${name} is not set`)
    return v
}
