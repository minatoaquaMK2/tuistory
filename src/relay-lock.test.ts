/// <reference path="../node_modules/bun-types/test-globals.d.ts" />
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const lockModule = pathToFileURL(path.join(root, process.versions.bun ? 'src/relay-lock.ts' : 'dist/relay-lock.js')).href
const fixtures: Array<{ directory: string; children: ChildProcess[] }> = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error('Condition timed out')
}

function fixture() {
  const state: { directory: string; children: ChildProcess[] } = {
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-lock-')),
    children: [],
  }
  fixtures.push(state)
  const directory = path.join(state.directory, 'contenders')
  const run = (name: string, { choosing = false, rounds = 1, timeoutMs = 15000 } = {}) => {
    const marker = path.join(state.directory, name)
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import path from 'node:path';
      import { randomBytes } from 'node:crypto';
      import { setTimeout as sleep } from 'node:timers/promises';
      import { withRelayLifecycleLock } from ${JSON.stringify(lockModule)};
      const directory = process.env.LOCK_DIRECTORY;
      const marker = process.env.LOCK_MARKER;
      const root = path.dirname(marker);
      if (${choosing}) {
        fs.mkdirSync(directory, { recursive: true });
        const contender = path.join(directory, process.pid + '-' + randomBytes(16).toString('hex'));
        fs.mkdirSync(contender);
        fs.writeFileSync(marker + '.choosing', contender);
        setInterval(() => {}, 1000);
      } else {
        fs.writeFileSync(marker + '.ready', '');
        while (!fs.existsSync(root + '/start')) await sleep(10);
        for (let round = 0; round < ${rounds}; round++) {
          await withRelayLifecycleLock({ directory, timeoutMs: ${timeoutMs} }, async () => {
            fs.mkdirSync(root + '/critical');
            fs.appendFileSync(root + '/events', 'enter ' + process.pid + '\\n');
            fs.writeFileSync(marker + '.entered', '');
            if (${rounds} === 1) {
              while (!fs.existsSync(marker + '.release')) await sleep(10);
            } else await sleep(10);
            fs.appendFileSync(root + '/events', 'exit ' + process.pid + '\\n');
            fs.rmSync(root + '/critical', { recursive: true });
          });
        }
      }
    `], { env: { ...process.env, LOCK_DIRECTORY: directory, LOCK_MARKER: marker }, stdio: 'pipe' })
    child.stdin.end()
    child.stdout.resume()
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    state.children.push(child)
    const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve({ code, stderr }))
    })
    return { child, marker, done }
  }
  return { directory, run, start: () => fs.writeFileSync(path.join(state.directory, 'start'), ''), root: state.directory }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await Promise.all(fixture.children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('close', () => resolve())
      if (process.platform !== 'win32') child.kill('SIGCONT')
      child.kill('SIGKILL')
    })))
    fs.rmSync(fixture.directory, { recursive: true, force: true })
  }
})

const posixTest = process.platform === 'win32' ? test.skip : test

posixTest('a paused live owner keeps exclusivity beyond the former ten second lease', async () => {
  const lock = fixture()
  lock.start()
  const owner = lock.run('owner')
  await until(() => fs.existsSync(owner.marker + '.entered'))
  owner.child.kill('SIGSTOP')
  await sleep(10500)
  const waiter = lock.run('waiter')
  await until(() => fs.readdirSync(lock.directory).length === 2)
  await sleep(150)
  expect(fs.existsSync(waiter.marker + '.entered')).toBe(false)
  owner.child.kill('SIGCONT')
  fs.writeFileSync(owner.marker + '.release', '')
  expect(await owner.done).toMatchObject({ code: 0 })
  await until(() => fs.existsSync(waiter.marker + '.entered'))
  fs.writeFileSync(waiter.marker + '.release', '')
  expect(await waiter.done).toMatchObject({ code: 0 })
}, 20000)

posixTest('a pending waiter recovers when the owner dies', async () => {
  const lock = fixture()
  lock.start()
  const owner = lock.run('owner')
  await until(() => fs.existsSync(owner.marker + '.entered'))
  const waiter = lock.run('waiter')
  await until(() => fs.readdirSync(lock.directory).length === 2)
  owner.child.kill('SIGSTOP')
  fs.rmSync(path.join(lock.root, 'critical'), { recursive: true })
  owner.child.kill('SIGKILL')
  await owner.done
  await until(() => fs.existsSync(waiter.marker + '.entered'))
  fs.writeFileSync(waiter.marker + '.release', '')
  expect(await waiter.done).toMatchObject({ code: 0 })
  expect(fs.readdirSync(lock.directory)).toEqual([])
}, 10000)

posixTest('a crash before ticket publication leaves a recoverable choosing record', async () => {
  const lock = fixture()
  lock.start()
  const owner = lock.run('owner', { choosing: true })
  await until(() => fs.existsSync(owner.marker + '.choosing'))
  const waiter = lock.run('waiter')
  await until(() => fs.readdirSync(lock.directory).length === 2)
  expect(fs.existsSync(waiter.marker + '.entered')).toBe(false)
  owner.child.kill('SIGKILL')
  await owner.done
  await until(() => fs.existsSync(waiter.marker + '.entered'))
  fs.writeFileSync(waiter.marker + '.release', '')
  expect(await waiter.done).toMatchObject({ code: 0 })
  expect(fs.readdirSync(lock.directory)).toEqual([])
}, 10000)

test('concurrent processes never overlap their critical sections', async () => {
  const lock = fixture()
  const contenders = Array.from({ length: 8 }, (_, i) => lock.run(`worker-${i}`, { rounds: 8 }))
  await until(() => contenders.every(contender => fs.existsSync(contender.marker + '.ready')))
  lock.start()
  for (const result of await Promise.all(contenders.map(contender => contender.done))) {
    expect(result).toMatchObject({ code: 0 })
  }
  const events = fs.readFileSync(path.join(lock.root, 'events'), 'utf8').trim().split('\n')
  expect(events).toHaveLength(128)
  for (let i = 0; i < events.length; i += 2) {
    expect(events[i + 1]).toBe(events[i].replace('enter', 'exit'))
  }
  expect(fs.readdirSync(lock.directory)).toEqual([])
}, 15000)

test('a timed out waiter removes only its own record', async () => {
  const lock = fixture()
  lock.start()
  const owner = lock.run('owner')
  await until(() => fs.existsSync(owner.marker + '.entered'))
  const original = fs.readdirSync(lock.directory)
  const waiter = lock.run('waiter', { timeoutMs: 100 })
  const result = await waiter.done
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Timed out waiting for relay lifecycle lock')
  expect(fs.readdirSync(lock.directory)).toEqual(original)
  fs.writeFileSync(owner.marker + '.release', '')
  expect(await owner.done).toMatchObject({ code: 0 })
}, 10000)
