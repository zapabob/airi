import type { Message } from '@xsai/shared-chat'

import type { StreamEvent, StreamOptions } from '@proj-airi/core-agent'

/**
 * Bridge that drives the Hermes Agent gateway's `/v1/runs` agent endpoint from
 * AIRI's chat pipeline, fusing AIRI's lightweight chat surface (B side) with the
 * Hermes core's long-term memory + tool/skill execution (A side).
 *
 * Unlike the default `@proj-airi/core-agent` `streamFrom` path (which talks
 * OpenAI-compatible `/v1/chat/completions` directly and is stateless), this
 * bridge starts a full agent run on the gateway and consumes its structured
 * Server-Sent-Events lifecycle. That run is what gives the conversation access
 * to Honcho-scoped long-term memory and the gateway's tool/skill set.
 *
 * Call stack:
 *
 * chat.ts: streamWithStageAdapters (activeProvider === 'hermes')
 *   -> {@link streamHermesRun}
 *     -> POST /v1/runs              (returns { run_id } in body)
 *       -> GET  /v1/runs/{run_id}/events (SSE)
 *         -> mapRunEventToStreamEvent -> onStreamEvent(StreamEvent)
 *
 * Gateway SSE wire format
 * -----------------------
 * Each SSE frame is `data: ["<event_name>", { ...payload }]\n\n` — a JSON
 * 2-tuple of (event name, payload object). The event names emitted by the
 * gateway are:
 *   - `assistant.delta`     { message_id, delta }
 *   - `tool.started`        { message_id, tool_name, preview, args }
 *   - `tool.completed`      { message_id, tool_name, preview, args }
 *   - `tool.failed`         { message_id, tool_name, preview, args }
 *   - `assistant.completed` { message_id, content, ... }
 *   - `run.completed`       { message_id, ... }
 *   - `error`               { message }
 *   - `done`                {}
 */

export interface HermesRunBridgeOptions {
  /** Gateway base URL, e.g. `http://localhost:8642/v1/`. */
  baseUrl: string
  /** API server key; required for Honcho long-term memory scoping. */
  apiKey?: string
  /** Virtual model name advertised by the gateway (usually `hermes-agent`). */
  model: string
  /**
   * Stable per-channel memory scope. Persists across transcripts so the gateway
   * can scope Honcho long-term memory correctly. Sent as `X-Hermes-Session-Key`.
   */
  sessionKey?: string
  /**
   * Optional explicit transcript/session id. When supplied, the gateway loads
   * history from its state store instead of relying solely on the request body.
   * Sent as `X-Hermes-Session-Id`.
   */
  sessionId?: string
  /** Full message history (roles + content) for the run. */
  messages: Message[]
  /** Stream options forwarded from the chat orchestrator. */
  options?: StreamOptions
  /** Called for every normalized stream event so callers can render/store it. */
  onStreamEvent?: (event: StreamEvent) => void | Promise<void>
  /** Called once when the run lifecycle ends (success, error, or abort). */
  onDone?: (info: { ok: boolean, error?: unknown }) => void
  /** Abort signal to cancel the in-flight run. */
  abortSignal?: AbortSignal
}

/** Raw gateway SSE event: a 2-tuple of [eventName, payload]. */
type RunEvent = [string, Record<string, any>]

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * Maps a gateway `/v1/runs` SSE event onto AIRI's {@link StreamEvent} shape so
 * the existing chat stream store can consume it unchanged.
 */
export function mapRunEventToStreamEvent(event: RunEvent): StreamEvent | null {
  const [name, payload] = event
  switch (name) {
    case 'assistant.delta':
      if (typeof payload?.delta === 'string' && payload.delta.length > 0)
        return { type: 'text-delta', text: payload.delta }
      return null

    case 'tool.started':
      return {
        type: 'tool-call',
        toolCallId: payload?.message_id || '',
        name: payload?.tool_name || 'unknown',
        arguments: parseArguments(payload?.args),
      } as unknown as Extract<StreamEvent, { type: 'tool-call' }>

    case 'tool.completed':
      return {
        type: 'tool-result',
        toolCallId: payload?.message_id || '',
        result: typeof payload?.preview === 'string' ? payload.preview : undefined,
      } as unknown as Extract<StreamEvent, { type: 'tool-result' }>

    case 'tool.failed':
      return {
        type: 'tool-error',
        toolCallId: payload?.message_id || '',
        args: {},
        toolName: payload?.tool_name || 'unknown',
        result: typeof payload?.preview === 'string' ? payload.preview : 'tool failed',
        isError: true,
      } as unknown as Extract<StreamEvent, { type: 'tool-error' }>

    case 'assistant.completed':
    case 'run.completed':
      return { type: 'finish' } as unknown as Extract<StreamEvent, { type: 'finish' }>

    default:
      return null
  }
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0)
    return raw
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<RunEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted)
        break

      const { done, value } = await reader.read()
      if (done)
        break

      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line.
      let separatorIndex: number
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)

        let dataLine = ''
        for (const line of frame.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('data:'))
            dataLine += trimmed.slice(5).trimStart()
        }
        if (!dataLine || dataLine.startsWith(':'))
          continue

        try {
          const parsed = JSON.parse(dataLine)
          // Gateway emits a 2-tuple: [eventName, payload].
          if (Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[0] === 'string')
            yield [parsed[0], parsed[1] && typeof parsed[1] === 'object' ? parsed[1] : {}]
          // Tolerate a plain object with `event` (defensive; not the real format).
          else if (parsed && typeof parsed.event === 'string')
            yield [parsed.event, parsed]
        }
        catch {
          // Ignore malformed frames (keep-alive comments are already skipped).
        }
      }
    }
  }
  finally {
    try {
      await reader.cancel()
    }
    catch {
      // ignore
    }
  }
}

/**
 * Starts a Hermes Agent run and streams its lifecycle as AIRI {@link StreamEvent}s.
 *
 * The function resolves once the SSE stream closes (run finished or aborted).
 */
export async function streamHermesRun(options: HermesRunBridgeOptions): Promise<void> {
  const {
    baseUrl,
    apiKey,
    model,
    sessionKey,
    sessionId,
    messages,
    options: streamOptions,
    onStreamEvent,
    onDone,
    abortSignal,
  } = options

  const normalizedBase = normalizeBaseUrl(baseUrl)
  const history = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: extractText(m.content) }))
    .filter(m => m.content.length > 0)

  // The last user message is the run `input`; earlier messages become history.
  const lastUser = [...history].reverse().find(m => m.role === 'user')
  const userMessage = lastUser?.content ?? ''
  const conversationHistory = history.filter(m => m !== lastUser)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`
  if (sessionKey)
    headers['X-Hermes-Session-Key'] = sessionKey
  if (sessionId)
    headers['X-Hermes-Session-Id'] = sessionId

  // Merge any caller-supplied headers (e.g. analytics correlation headers).
  if (streamOptions?.headers) {
    for (const [k, v] of Object.entries(streamOptions.headers))
      headers[k] = v
  }

  const settle = (info: { ok: boolean, error?: unknown }) => {
    try {
      onDone?.(info)
    }
    catch {
      // never let a callback error escape the bridge
    }
  }

  try {
    const startResp = await fetch(`${normalizedBase}v1/runs`, {
      method: 'POST',
      headers,
      signal: abortSignal,
      body: JSON.stringify({
        input: userMessage,
        model: model || 'hermes-agent',
        conversation_history: conversationHistory,
        session_id: sessionId,
      }),
    })

    if (!startResp.ok) {
      const text = await startResp.text().catch(() => '')
      throw new Error(`Hermes /v1/runs failed (${startResp.status}): ${text.slice(0, 500)}`)
    }

    const startJson = await startResp.json() as { run_id?: string }
    const runId = startJson.run_id
    if (!runId)
      throw new Error('Hermes /v1/runs did not return a run_id')

    const eventsResp = await fetch(`${normalizedBase}v1/runs/${runId}/events`, {
      method: 'GET',
      headers,
      signal: abortSignal,
    })

    if (!eventsResp.ok || !eventsResp.body) {
      throw new Error(`Hermes run events stream failed (${eventsResp.status})`)
    }

    for await (const runEvent of readSseEvents(eventsResp.body, abortSignal)) {
      const streamEvent = mapRunEventToStreamEvent(runEvent)
      if (streamEvent)
        await onStreamEvent?.(streamEvent)
    }

    settle({ ok: true })
  }
  catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      settle({ ok: true, error })
      return
    }
    // Surface the failure as an error stream event so the UI can render it.
    await onStreamEvent?.({ type: 'error', error } as unknown as Extract<StreamEvent, { type: 'error' }>)
    settle({ ok: false, error })
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string')
          return part
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string')
            return p.text
        }
        return ''
      })
      .join('')
  }
  return ''
}
