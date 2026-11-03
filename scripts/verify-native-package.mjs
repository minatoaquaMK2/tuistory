import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const require = createRequire(join(process.cwd(), 'package.json'))
const { renderTerminalImage, exportRecording } = await import(pathToFileURL(require.resolve('tuistory')))
const { PersistentTerminal } = await import(pathToFileURL(require.resolve('ghostty-opentui')))
const term = new PersistentTerminal({ cols: 40, rows: 6 })
const output = `native-${process.versions.bun ? 'bun' : 'node'}`
const text = '\x1b[?25l╭── Native renderer ──╮\r\n│ é € 中文 😀 🚀 │\r\n╰────────────────────╯'
try {
  term.feed(text)
  const png = await renderTerminalImage(term.getJson(), { width: 336, height: 126 })
  assert.equal(png.readUInt32BE(16), 336)
  assert.equal(png.readUInt32BE(20), 126)
  await writeFile(`${output}.png`, png)
  await writeFile(`${output}.cast`, [
    { version: 3, term: { cols: 40, rows: 6 } }, [0, 'o', text], [0.2, 'm', 'end'],
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const video = await exportRecording({ inputPath: `${output}.cast`, outputPath: `${output}.mp4`, fps: 5 })
  assert.equal(video.frames, 2)
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,width,height', '-of', 'json', video.path])
  assert.equal(probe.status, 0, probe.stderr.toString())
  assert.deepEqual(JSON.parse(probe.stdout.toString()).streams[0], { width: 336, height: 126, nb_frames: '2' })
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, runtime: process.versions.bun ? 'bun' : 'node', passed: true }))
} finally { term.destroy() }
