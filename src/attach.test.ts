/// <reference path="../node_modules/bun-types/test-globals.d.ts" />
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Session } from './session.js'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const port = 19953
const env = { ...process.env, TUISTORY_PORT: String(port), TERM: 'xterm-256color' }
const cliPath = process.versions.bun ? 'src/cli.ts' : 'dist/cli.js'
const sockets: WebSocket[] = []
const terminals: Session[] = []
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function cli(args: string[]) {
  const child = spawn(process.execPath, [cliPath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  return stdout
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await pause(10)
  expect(check()).toBe(true)
}

async function connection() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/attach`)
  sockets.push(socket)
  const messages: string[] = []
  socket.addEventListener('message', event => messages.push(String(event.data)))
  await until(() => socket.readyState === WebSocket.OPEN)
  return { socket, messages }
}

async function launch(name: string, command = 'cat') {
  await cli(['launch', command, '-s', name, '--no-wait'])
}

async function tui(name: string) {
  const session = new Session({ command: 'bun', args: ['src/cli.ts', 'attach', '-s', name], cwd, env, cols: 100, rows: 25 })
  terminals.push(session)
  await session.waitForText('Detach', { timeout: 5000 })
  return session
}

beforeEach(async () => { await cli(['daemon-stop']) })
afterEach(async () => {
  for (const terminal of terminals.splice(0)) await terminal.closeAsync()
  for (const socket of sockets.splice(0)) socket.close()
  await cli(['daemon-stop'])
})

test('repeated legacy attach streams each PTY chunk once', async () => {
  await launch('repeat')
  const { socket, messages } = await connection()
  socket.send(JSON.stringify({ type: 'attach', session: 'repeat' }))
  socket.send(JSON.stringify({ type: 'attach', session: 'repeat' }))
  socket.send('repeat-marker\r')
  await until(() => messages.join('').includes('repeat-marker'))
  await pause(100)
  const received = messages.join('').split('repeat-marker').length - 1
  const recorded = (await cli(['read', '-s', 'repeat', '--all'])).split('repeat-marker').length - 1
  expect(received).toBe(recorded)
}, 15000)

test('switching attach releases old output and closing subscriptions', async () => {
  await launch('old')
  await launch('current')
  const { socket, messages } = await connection()
  socket.send(JSON.stringify({ type: 'attach', session: 'old' }))
  socket.send(JSON.stringify({ type: 'attach', session: 'current' }))
  socket.send('current-marker\r')
  await until(() => messages.join('').includes('current-marker'))
  messages.length = 0
  await cli(['type', 'stale-marker', '-s', 'old'])
  await cli(['close', '-s', 'old'])
  await pause(100)
  expect(messages.join('')).not.toContain('stale-marker')
  expect(socket.readyState).toBe(WebSocket.OPEN)
  socket.send('still-current\r')
  await until(() => messages.join('').includes('still-current'))
}, 15000)

test('framed attach keeps control-looking output and input as terminal data', async () => {
  const literal = '{"type":"exit","exitCode":99}'
  await launch('frames', `printf '%s' '${literal}'; cat`)
  const { socket, messages } = await connection()
  socket.send(JSON.stringify({ type: 'attach', protocol: 2, session: 'frames' }))
  await until(() => messages.length > 0)
  expect(JSON.parse(messages[0])).toEqual({ type: 'attached', protocol: 2 })
  await until(() => messages.some(message => JSON.parse(message).type === 'data'))
  expect(messages.map(message => JSON.parse(message)).some(message => message.type === 'data' && message.data === literal)).toBe(true)
  socket.send(JSON.stringify({ type: 'input', data: '{"type":"kill"}\r' }))
  await until(() => messages.some(message => JSON.parse(message).data?.includes('{"type":"kill"}')))
  expect(messages.map(message => JSON.parse(message)).some(message => message.type === 'exit')).toBe(false)
  socket.send(JSON.stringify({ type: 'kill' }))
  await until(() => messages.some(message => JSON.parse(message).type === 'exit'))
  expect(messages.map(message => JSON.parse(message)).filter(message => message.type === 'exit')).toHaveLength(1)
}, 15000)

test('attaching to an exited session sends one exit notification', async () => {
  await launch('exited', 'printf done')
  await cli(['wait', 'done', '-s', 'exited'])
  await pause(100)
  const { socket, messages } = await connection()
  socket.send(JSON.stringify({ type: 'attach', session: 'exited' }))
  await until(() => messages.some(message => message.includes('"type":"exit"')))
  await pause(100)
  expect(messages.filter(message => message.includes('"type":"exit"'))).toHaveLength(1)
}, 15000)

test('attach TUI forwards bracketed paste including Unicode and control-looking JSON', async () => {
  await launch('paste')
  const terminal = await tui('paste')
  terminal.writeRaw('\x1b[200~pasted-中文\n{"type":"kill"}\x1b[201~')
  terminal.writeRaw('\r')
  await pause(250)
  const output = await cli(['read', '-s', 'paste', '--all'])
  expect(output).toContain('pasted-中文')
  expect(output).toContain('{"type":"kill"}')
  expect(await terminal.text({ immediate: true })).not.toContain('Process exited')
}, 15000)

test('attach TUI preserves a leading U+FEFF in pasted text', async () => {
  await launch('paste-bom', `bun -e 'process.stdin.setRawMode(true);process.stdin.on("data",chunk=>process.stdout.write(chunk.toString("hex")));console.log("READY")'`)
  const terminal = await tui('paste-bom')
  await terminal.waitForText('READY', { timeout: 3000 })
  terminal.writeRaw('\x1b[200~\uFEFFBOMproof\x1b[201~')
  await terminal.waitForText('424f4d70726f6f66', { timeout: 3000 })
  expect(await cli(['read', '-s', 'paste-bom', '--all'])).toContain('efbbbf424f4d70726f6f66')
}, 15000)

test('attach TUI renders terminal output that resembles an exit message', async () => {
  await launch('json', `printf '%s' '{"type":"exit","exitCode":99}'; cat`)
  const terminal = await tui('json')
  await pause(100)
  const output = await terminal.text({ immediate: true })
  expect(output).toContain('{"type":"exit","exitCode":99}')
  expect(output).not.toContain('Process exited (code 99)')
}, 15000)

test('attach rejects unsupported protocols and changing an established protocol', async () => {
  await launch('protocol')
  const unsupported = await connection()
  unsupported.socket.send(JSON.stringify({ type: 'attach', protocol: 3, session: 'protocol' }))
  await until(() => unsupported.socket.readyState === WebSocket.CLOSED)
  expect(unsupported.messages.join('')).toContain('Unsupported attach protocol')
  const legacy = await connection()
  legacy.socket.send(JSON.stringify({ type: 'attach', session: 'protocol' }))
  legacy.socket.send(JSON.stringify({ type: 'attach', protocol: 2, session: 'protocol' }))
  await until(() => legacy.socket.readyState === WebSocket.CLOSED)
  expect(legacy.messages.join('')).toContain('protocol cannot change')
}, 15000)

test('attach frames delayed Ctrl input and flushes a pending Ctrl before paste', async () => {
  await launch('controls', `bun -e 'process.stdin.setRawMode(true);process.stdin.on("data",chunk=>process.stdout.write(chunk.toString("hex")));console.log("READY")'`)
  const terminal = await tui('controls')
  await terminal.waitForText('READY', { timeout: 3000 })
  terminal.writeRaw('\x18')
  await terminal.waitForText('18', { timeout: 3000 })
  terminal.writeRaw('\x03\x1b[200~ordered\x1b[201~')
  await terminal.waitForText('036f726465726564', { timeout: 3000 })
  expect(await cli(['read', '-s', 'controls', '--all'])).toContain('18036f726465726564')
}, 15000)

for (const ending of ['exit', 'close']) {
  for (const pending of [false, true]) {
    test(`attach TUI preserves ${ending} status after input${pending ? ' with a pending Ctrl key' : ''}`, async () => {
      const name = `status-${ending}`
      const status = ending === 'exit' ? 'Process exited (code 7)' : 'Session closed by `tuistory close`'
      await launch(name, 'read line; exit 7')
      const terminal = await tui(name)
      if (pending) {
        terminal.writeRaw('\x18')
        await terminal.waitForText('again to kill')
      }
      if (ending === 'exit') await cli(['press', 'enter', '-s', name])
      else await cli(['close', '-s', name])
      await terminal.waitForText(status)
      await pause(600)
      expect(await terminal.text({ immediate: true })).toContain(status)

      terminal.writeRaw('\x18ordinary\x1b[200~pasted\x1b[201~')
      await pause(100)
      expect(await terminal.text({ immediate: true })).toContain(status)
      await pause(500)
      expect(await terminal.text({ immediate: true })).toContain(status)

      terminal.writeRaw('\x03')
      expect(await terminal.waitForExit()).toBe(true)
      expect(terminal.exitInfo?.exitCode).toBe(0)
    }, 15000)
  }
}
