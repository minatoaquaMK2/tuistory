/// <reference path="../node_modules/bun-types/test-globals.d.ts" />
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { killPortProcess } from 'kill-port-process'

const port = 19952
const root = fileURLToPath(new URL('..', import.meta.url))
const version: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const cliPath = path.join(root, process.versions.bun ? 'src/cli.ts' : 'dist/cli.js')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-lifecycle-'))
const relayDirectory = path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'tuistory')
const pidFile = path.join(relayDirectory, `relay-${port}.pid`)
const legacyLock = path.join(relayDirectory, `restart-${port}.lock`)
const children = new Set<ChildProcess>()
const env = { ...process.env, TUISTORY_PORT: String(port), TUISTORY_LOG_FILE_PATH: path.join(directory, 'relay.log') }

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: 'pipe' })
  children.add(child)
  child.stdin.end()
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => { stderr += value })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
  return { child, done }
}

const cli = (...args: string[]) => run([cliPath, ...args])
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function canBind(host: string): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ host, port: 0, ipv6Only: true }, () => server.close(() => resolve(true)))
  })
}

const extraListeners = await Promise.all(['::1', '127.0.0.2'].map(async host => ({ host, available: await canBind(host) })))

async function until(predicate: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(20)
  }
  throw new Error('Condition timed out')
}

function portOccupied(): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => server.close(() => resolve(false)))
    server.listen(port, '127.0.0.1')
  })
}

async function clean() {
  await Promise.all(Array.from(children, child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('close', () => resolve())
    if (process.platform !== 'win32') child.kill('SIGCONT')
    child.kill('SIGKILL')
  })))
  children.clear()
  if (await portOccupied()) await killPortProcess(port, { signal: 'SIGKILL', silent: true }).catch(() => {})
  await until(async () => !await portOccupied())
  for (const filename of [pidFile, legacyLock]) fs.rmSync(filename, { force: true })
}

beforeEach(clean)
afterEach(clean)
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

async function versionFixture(body: string, holdShutdown = false) {
  const marker = path.join(directory, `fixture-${Math.random()}`)
  const fixture = run(['--input-type=module', '-e', `
    import fs from 'node:fs';
    import http from 'node:http';
    const marker = process.env.FIXTURE_MARKER;
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/cli' ? JSON.stringify({ stdout: 'fixture command', stderr: '', exitCode: 0 }) : process.env.FIXTURE_BODY);
    });
    server.listen(${port}, '127.0.0.1', () => fs.writeFileSync(marker, 'ready'));
    process.on('SIGTERM', () => {
      fs.appendFileSync(marker + '.term', 'term\\n');
      const shutdown = () => { server.close(); server.closeAllConnections(); };
      if (process.env.FIXTURE_HOLD === 'yes') {
        const timer = setInterval(() => {
          if (fs.existsSync(marker + '.release')) { clearInterval(timer); shutdown(); }
        }, 20);
      } else shutdown();
    });
  `], { FIXTURE_BODY: body, FIXTURE_MARKER: marker, FIXTURE_HOLD: holdShutdown ? 'yes' : 'no' })
  await until(() => fs.existsSync(marker))
  return { ...fixture, marker }
}

test.each(['{}', 'null', '[]', '{"version":4}', '{"version":"banana"}', '{"version":"0.12.0-01"}', 'not JSON'])(
  'malformed version response %s is replaced without crashing the client', async body => {
  await versionFixture(body)
  const result = await cli('sessions').done
  expect(result).toMatchObject({ code: 0 })
  expect(result.stderr).not.toContain('split')
}, 15000)

test.each(['99.0.0-beta.1', '99.0.0+build', '99.0.0-beta.1+build', `${version}+build`])(
  'an equal or newer semver daemon %s is reused', async version => {
    const fixture = await versionFixture(JSON.stringify({ version }))
    expect(await cli('sessions').done).toMatchObject({ code: 0, stdout: 'fixture command\n' })
    expect(fixture.child.exitCode).toBeNull()
    expect(fixture.child.signalCode).toBeNull()
    expect(fs.existsSync(fixture.marker + '.term')).toBe(false)
  }, 10000,
)

test('a prerelease of the current stable version is replaced', async () => {
  const fixture = await versionFixture(JSON.stringify({ version: `${version}-beta.1` }))
  const result = await cli('sessions').done
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('No active sessions')
  expect(fs.existsSync(fixture.marker + '.term')).toBe(true)
}, 15000)

test('daemon-stop preserves an unrelated process named by a stale PID file', async () => {
  expect(await cli('sessions').done).toMatchObject({ code: 0 })
  const unrelated = run(['-e', 'setInterval(() => {}, 1000)'])
  fs.writeFileSync(pidFile, String(unrelated.child.pid))
  expect(await cli('daemon-stop').done).toMatchObject({ code: 0 })
  expect(unrelated.child.exitCode).toBeNull()
  expect(unrelated.child.signalCode).toBeNull()
  expect(await portOccupied()).toBe(false)
}, 15000)

test('daemon-stop works without lsof on PATH', async () => {
  expect(await cli('sessions').done).toMatchObject({ code: 0 })
  const result = await run([cliPath, 'daemon-stop'], { PATH: directory }).done
  expect(result).toMatchObject({ code: 0, stdout: 'Daemon stopped\n' })
  expect(await portOccupied()).toBe(false)
}, 15000)

for (const { host, available } of extraListeners) {
  test.skipIf(!available)(`daemon-stop preserves an unrelated ${host} listener on the same port`, async () => {
    const marker = path.join(directory, `socket-${Math.random()}`)
    const unrelated = run(['--input-type=module', '-e', `
      import fs from 'node:fs';
      import net from 'node:net';
      const server = net.createServer();
      server.listen({ host: process.env.FIXTURE_HOST, port: ${port}, ipv6Only: true }, () => fs.writeFileSync(process.env.FIXTURE_MARKER, 'ready'));
      process.on('SIGTERM', () => {
        fs.writeFileSync(process.env.FIXTURE_MARKER + '.term', 'term');
        server.close();
      });
    `], { FIXTURE_HOST: host, FIXTURE_MARKER: marker })
    await until(() => fs.existsSync(marker))
    expect(await cli('sessions').done).toMatchObject({ code: 0 })
    expect(await cli('daemon-stop').done).toMatchObject({ code: 0, stdout: 'Daemon stopped\n' })
    expect(fs.existsSync(marker + '.term')).toBe(false)
    expect(unrelated.child.exitCode).toBeNull()
    expect(unrelated.child.signalCode).toBeNull()
    expect(await portOccupied()).toBe(false)
  }, 15000)
}

test('an empty legacy restart file cannot block the new lifecycle protocol', async () => {
  fs.mkdirSync(relayDirectory, { recursive: true })
  fs.writeFileSync(legacyLock, '')
  expect(await cli('sessions').done).toMatchObject({ code: 0 })
  expect(fs.readFileSync(legacyLock, 'utf8')).toBe('')
}, 20000)

test('healthy daemon reuse preserves its PID and live sessions', async () => {
  expect(await cli('launch', 'cat', '-s', 'survivor', '--no-wait').done).toMatchObject({ code: 0 })
  const originalPid = fs.readFileSync(pidFile, 'utf8')
  for (const result of await Promise.all(Array.from({ length: 4 }, () => cli('sessions').done))) {
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('survivor')
  }
  expect(fs.readFileSync(pidFile, 'utf8')).toBe(originalPid)
}, 15000)

test('daemon-stop waits for an in-progress restart and then stops its replacement', async () => {
  const fixture = await versionFixture('{"version":"0.0.0"}', true)
  const start = cli('sessions')
  await until(() => fs.existsSync(fixture.marker + '.term'))
  const stop = cli('daemon-stop')
  await sleep(300)
  expect(stop.child.exitCode).toBeNull()
  expect(fs.readFileSync(fixture.marker + '.term', 'utf8')).toBe('term\n')
  fs.writeFileSync(fixture.marker + '.release', '')
  await start.done
  expect(await stop.done).toMatchObject({ code: 0, stdout: 'Daemon stopped\n' })
  expect(await portOccupied()).toBe(false)
}, 15000)

test('a restart waits for daemon-stop and re-probes after the listener exits', async () => {
  const fixture = await versionFixture('{"version":"0.0.0"}', true)
  const stop = cli('daemon-stop')
  await until(() => fs.existsSync(fixture.marker + '.term'))
  const start = cli('sessions')
  await sleep(300)
  expect(start.child.exitCode).toBeNull()
  expect(fs.readFileSync(fixture.marker + '.term', 'utf8')).toBe('term\n')
  fs.writeFileSync(fixture.marker + '.release', '')
  expect(await stop.done).toMatchObject({ code: 0 })
  expect(await start.done).toMatchObject({ code: 0 })
  expect(await portOccupied()).toBe(true)
}, 15000)

const posixTest = process.platform === 'win32' ? test.skip : test

posixTest('a suspended restart cannot be overtaken after ten seconds or destroy the waiting launch', async () => {
  const fixture = await versionFixture('{"version":"0.0.0"}', true)
  const owner = cli('sessions')
  await until(() => fs.existsSync(fixture.marker + '.term'))
  owner.child.kill('SIGSTOP')
  await sleep(10500)
  const waiter = cli('launch', 'cat', '-s', 'paused-owner-survivor', '--no-wait')
  const lockDirectory = path.join(relayDirectory, `lifecycle-${port}`)
  await until(() => fs.readdirSync(lockDirectory).length === 2)
  await sleep(150)
  expect(waiter.child.exitCode).toBeNull()
  expect(fs.readFileSync(fixture.marker + '.term', 'utf8')).toBe('term\n')
  fs.writeFileSync(fixture.marker + '.release', '')
  await fixture.done
  owner.child.kill('SIGCONT')
  expect(await owner.done).toMatchObject({ code: 0 })
  expect(await waiter.done).toMatchObject({ code: 0 })
  const pid = fs.readFileSync(pidFile, 'utf8')
  const sessions = await cli('sessions').done
  expect(sessions.code).toBe(0)
  expect(sessions.stdout).toContain('paused-owner-survivor')
  expect(fs.readFileSync(pidFile, 'utf8')).toBe(pid)
}, 25000)
