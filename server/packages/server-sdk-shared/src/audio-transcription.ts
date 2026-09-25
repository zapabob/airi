import type { InferOutput } from 'valibot'

import { boolean, literal, number, strictObject, string, variant } from 'valibot'

/** Control frames sent by a client during one ASR WebSocket session. */
export type AudioTranscriptionClientControlMessage
  = | { event: 'start', model: 'auto', format: 'pcm', sample_rate: 16000 }
    | { event: 'stop' }
    | { event: 'cancel' }

/** Frames sent by the server during one ASR WebSocket session. */
export const AudioTranscriptionServerMessageSchema = variant('event', [
  strictObject({ event: literal('session.started') }),
  strictObject({ event: literal('transcript.text.delta'), delta: string() }),
  strictObject({ event: literal('transcript.text.snapshot'), text: string(), isFinal: boolean(), durationMilliseconds: number() }),
  strictObject({ event: literal('transcript.text.done') }),
  strictObject({ event: literal('session.finished') }),
  strictObject({ event: literal('error'), code: string(), message: string() }),
])

export type AudioTranscriptionServerMessage = InferOutput<typeof AudioTranscriptionServerMessageSchema>
