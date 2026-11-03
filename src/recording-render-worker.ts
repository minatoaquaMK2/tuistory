import { parentPort, workerData } from 'node:worker_threads'
import type { TerminalData } from 'ghostty-opentui'
import { z } from 'zod'
import { initializeRenderer, renderWorkerOutput, renderProfileSchema } from './recording.js'
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
const profile = renderProfileSchema.parse(workerData)
await initializeRenderer()
port.on('message', async (message: unknown) => {
  try {
    const { id, data } = requestSchema.parse(message)
    const pixels = await renderWorkerOutput(data, profile)
    port.postMessage({ kind: 'frame', id, width: profile.layout.pixelWidth, height: profile.layout.pixelHeight, pixels }, [pixels.buffer])
  } catch (error) {
    port.postMessage({ kind: 'error', message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) })
  }
})
port.postMessage({ kind: 'ready' })
