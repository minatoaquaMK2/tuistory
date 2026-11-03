import { z } from 'zod'

const dimensions = {
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
}

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attach'), session: z.string().min(1), protocol: z.unknown().optional(), ...dimensions }),
  z.object({ type: z.literal('resize'), ...dimensions }),
  z.object({ type: z.literal('kill') }),
  z.object({ type: z.literal('input'), data: z.string() }),
])

const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attached'), protocol: z.literal(2) }),
  z.object({ type: z.literal('data'), data: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number(), signal: z.number() }),
  z.object({ type: z.literal('closing'), reason: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

export type AttachServerMessage = z.infer<typeof serverMessageSchema>

export function decodeAttachClientMessage(raw: string) {
  try {
    const value: unknown = JSON.parse(raw)
    return clientMessageSchema.safeParse(value).data
  } catch { return undefined }
}

export function decodeAttachServerMessage(raw: string) {
  try {
    const value: unknown = JSON.parse(raw)
    return serverMessageSchema.safeParse(value).data
  } catch { return undefined }
}
