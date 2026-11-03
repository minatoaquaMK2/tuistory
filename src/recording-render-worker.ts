import { parentPort, workerData } from 'node:worker_threads'
import type { TerminalData } from 'ghostty-opentui'
import { z } from 'zod'
import { initializeRenderer, renderFrame, renderTerminalPng } from './recording.js'

const profileSchema = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(), png: z.boolean().optional(),
  imageOptions: z.object({
    width: z.number().positive().optional(), height: z.number().positive().optional(),
    fontSize: z.number().positive().optional(), lineHeight: z.number().positive().optional(),
    paddingX: z.number().nonnegative().optional(), paddingY: z.number().nonnegative().optional(),
    devicePixelRatio: z.number().positive().optional(), frameColor: z.string().optional(),
    theme: z.object({ background: z.string(), text: z.string() }).optional(),
  }).optional(),
})
const cursorStyles = {
  default: 'default', block: 'block', bar: 'bar', underline: 'underline', block_hollow: 'block_hollow',
} satisfies { [Style in TerminalData['cursorStyle']]: Style }
const terminalDataSchema = z.object({
  cols: z.number().int().positive(), rows: z.number().int().positive(),
  cursor: z.tuple([z.number(), z.number()]), cursorVisible: z.boolean(),
  cursorStyle: z.enum(cursorStyles),
  offset: z.number(), totalLines: z.number(),
  lines: z.array(z.object({ spans: z.array(z.object({
    text: z.string(), fg: z.string().nullable(), bg: z.string().nullable(), flags: z.number(), width: z.number(),
  })) })),
}) satisfies z.ZodType<TerminalData>
const requestSchema = z.object({
  id: z.number().int().nonnegative(),
  data: terminalDataSchema,
})
const port = parentPort
if (!port) throw new Error('Render worker requires a parent port')
const profile = profileSchema.parse(workerData)
if (profile.width * profile.height > 4_000_000) throw new Error('Render worker canvas exceeds limit')
await initializeRenderer()
port.on('message', async (message: unknown) => {
  try {
    const { id, data } = requestSchema.parse(message)
    const pixels = profile.png ? await renderTerminalPng(data, profile.imageOptions) : await renderFrame(data, profile)
    port.postMessage({ kind: 'frame', id, ...profile, pixels }, [pixels.buffer])
  } catch (error) {
    port.postMessage({ kind: 'error', message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) })
  }
})
port.postMessage({ kind: 'ready' })
