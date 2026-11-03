/// <reference path="../node_modules/bun-types/test-globals.d.ts" />
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Session } from './session.js'

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('PTY fixture did not settle')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function mouseFixture(output: string, run: (session: Session, input: () => string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-mouse-'))
  const destination = path.join(directory, 'input')
  fs.writeFileSync(destination, '')
  const session = new Session({
    command: process.execPath,
    args: ['-e', `
      process.stdin.setRawMode(true)
      process.stdin.on('data', data => require('node:fs').appendFileSync(${JSON.stringify(destination)}, data))
      process.stdout.write(${JSON.stringify(output)})
    `],
    cols: 40, rows: 3, idleDelayMs: 10,
  })
  try {
    await session.waitForText('TARGET')
    await run(session, () => fs.readFileSync(destination, 'utf8'))
  } finally {
    await session.closeAsync()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

for (const [name, output] of [
  ['wide characters', '界TARGET'],
  ['combining marks', 'e\u0301TARGET'],
  ['emoji', '😀TARGET'],
  ['joined emoji', '👩‍💻TARGET'],
  ['styled prefix', '\x1b[31m界\x1b[0mTARGET'],
] satisfies [string, string][]) {
  test(`click measures terminal cells after ${name}`, async () => {
    await mouseFixture(output, async (session, input) => {
      const column = session.getVisibleTerminalData().cursor[0] - 'TARGET'.length + 1
      await session.click('TARGET')
      await until(() => input().endsWith('m'))
      expect(input()).toBe(`\x1b[<0;${column};1M\x1b[<0;${column};1m`)
    })
  })
}

for (const [name, output, pattern, column] of [
  ['combining mark', 'e\u0301TARGET', '\u0301', 1],
  ['joined emoji component', '👩‍💻TARGET', '💻', 3],
] satisfies [string, string, string, number][]) {
  test(`click locates a ${name} inside terminal text`, async () => {
    await mouseFixture(output, async (session, input) => {
      await session.click(pattern)
      await until(() => input().endsWith('m'))
      expect(input()).toBe(`\x1b[<0;${column};1M\x1b[<0;${column};1m`)
    })
  })
}

test('click uses the visible row after scrollback', async () => {
  await mouseFixture('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nTARGET', async (session, input) => {
    await session.click('TARGET')
    await until(() => input().endsWith('m'))
    expect(input()).toBe('\x1b[<0;1;3M\x1b[<0;1;3m')
  })
})

test('click ignores a matching line that has scrolled out of view', async () => {
  await mouseFixture('TARGET\r\ntwo\r\nthree\r\nfour\r\nfive\r\nTARGET', async (session, input) => {
    await session.click('TARGET')
    await until(() => input().endsWith('m'))
    expect(input()).toBe('\x1b[<0;1;3M\x1b[<0;1;3m')
  })
})

test('zero-width click matches complete without blocking the event loop', async () => {
  const modulePath = fileURLToPath(new URL(process.versions.bun ? './session.ts' : '../dist/session.js', import.meta.url))
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { Session } from ${JSON.stringify(modulePath)}
    const session = new Session({ command: 'sh', args: ['-c', 'printf TARGET'], idleDelayMs: 10 })
    try {
      await session.waitForText('TARGET')
      await session.waitForExit()
      try {
        await session.click(/^/, { timeout: 50, first: true })
        process.exitCode = 2
      } catch (error) {
        if (!String(error).includes('pattern not found')) throw error
        process.stdout.write('completed')
      }
    } finally { await session.closeAsync() }
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    expect({ ...result, stdout, stderr }).toEqual({ code: 0, signal: null, stdout: 'completed', stderr: '' })
  } finally { clearTimeout(timer); child.kill('SIGKILL') }
})

test('waitForText can reuse stateful regexes without mutating them', async () => {
  const session = new Session({ command: 'sh', args: ['-c', 'printf READY'] })
  try {
    await session.waitForExit()
    for (const regex of [/READY/g, /^\nREADY/y]) {
      const first = await session.waitForText(regex)
      expect(regex.lastIndex).toBe(0)
      expect(await session.waitForText(regex)).toBe(first)
      regex.lastIndex = 50
      expect(await session.waitForText(regex)).toBe(first)
      expect(regex.lastIndex).toBe(50)
    }
  } finally { await session.closeAsync() }
})

test('completed idle timeouts release their callbacks during continuous output', async () => {
  const session = new Session({
    command: process.execPath,
    args: ['-e', "setInterval(() => process.stdout.write('.\\r'), 5)"],
    idleDelayMs: 1000,
  })
  try {
    await session.waitForData()
    for (let index = 0; index < 30; index++) await session.waitIdle({ timeout: 1 })
    const retained: unknown = Reflect.get(session, 'idleResolvers')
    expect(retained).toHaveLength(0)
  } finally { await session.closeAsync() }
})

test('onExit subscriptions can be removed independently', async () => {
  const session = new Session({ command: process.execPath, args: ['-e', 'process.stdin.resume()'] })
  const observed: number[] = []
  try {
    const unsubscribe = session.onExit(() => observed.push(1))
    const duplicate = () => observed.push(2)
    session.onExit(duplicate)
    const unsubscribeDuplicate = session.onExit(duplicate)
    unsubscribeDuplicate()
    unsubscribeDuplicate()
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
    unsubscribe()
    session.killProcess()
    expect(await session.waitForExit()).toBe(true)
    expect(observed).toEqual([2])
    const unsubscribeLate = session.onExit(() => observed.push(3))
    unsubscribeLate()
    expect(observed).toEqual([2, 3])
  } finally { await session.closeAsync() }
})
