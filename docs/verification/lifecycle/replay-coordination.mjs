#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const sourcePath = path.join(repository, 'src/relay-lock.ts')
const original = fs.readFileSync(sourcePath, 'utf8')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-coordination-replay-'))
const errore = import.meta.resolve('errore')
const legacySource = execFileSync('git', ['show', '2bc5b367bda0ab0da8009e0141d2345317c8f78e:src/cli.ts'], { cwd: repository, encoding: 'utf8' })
const begin = legacySource.indexOf('const RESTART_LOCK_STALE_MS = 10000')
const end = legacySource.indexOf('\nfunction ensureTuistoryDir()', begin)
assert(begin >= 0 && end > begin, 'Legacy source anchors changed')
const legacy = `import fs from 'node:fs'\nimport * as errore from ${JSON.stringify(errore)}\nconst RESTART_LOCK_FILE = process.env.REPLAY_LOCK_FILE\nfunction ensureTuistoryDir() {}\n${legacySource.slice(begin, end)}\nexport { acquireRestartLock, releaseRestartLock }\n`
const scanBegin = original.indexOf('      const blocked = contenders(directory).some(contender => {')
const scanEnd = original.indexOf('      if (!blocked)', scanBegin)
assert(scanBegin >= 0 && scanEnd > scanBegin, 'Current source anchors changed')
const mutant = original.slice(0, scanBegin) + '      const blocked = false\n' + original.slice(scanEnd)
fs.writeFileSync(path.join(scratch, 'legacy.ts'), legacy)
fs.writeFileSync(path.join(scratch, 'current.ts'), original)
fs.writeFileSync(path.join(scratch, 'no-post-scan.ts'), mutant)
const worker = path.join(scratch, 'worker.mjs')
fs.writeFileSync(worker, `
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
const [moduleUrl, directory, name, kind] = process.argv.slice(2)
if (!moduleUrl || !directory || !name || !kind) throw new Error('Missing worker arguments')
const lock = await import(moduleUrl)
const marker = suffix => path.join(directory, name + '.' + suffix)
async function action() {
  fs.writeFileSync(marker('inside'), String(process.pid))
  while (!fs.existsSync(marker('release'))) await sleep(5)
  fs.unlinkSync(marker('inside'))
}
try {
  if (kind === 'legacy') {
    if (!lock.acquireRestartLock()) throw new Error('Legacy acquire failed')
    try { await action() } finally { lock.releaseRestartLock() }
  } else {
    await lock.withRelayLifecycleLock({ directory: path.join(directory, 'lock'), timeoutMs: name === 'A' ? 5000 : 250 }, action)
  }
  fs.writeFileSync(marker('result'), 'completed')
} catch (error) {
  fs.writeFileSync(marker('result'), String(error))
}
`)

async function until(predicate, description) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert(Date.now() < deadline, 'Timed out: ' + description)
    await sleep(5)
  }
}

async function scenario(moduleName, kind, expectedOverlap) {
  const directory = path.join(scratch, moduleName)
  fs.mkdirSync(directory)
  const children = []
  const marker = (name, suffix) => path.join(directory, name + '.' + suffix)
  const start = name => {
    const child = spawn(process.execPath, [worker, pathToFileURL(path.join(scratch, moduleName + '.ts')).href, directory, name, kind], {
      env: { ...process.env, REPLAY_LOCK_FILE: path.join(directory, 'legacy.lock') },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    children.push(child)
    return child
  }
  try {
    const first = start('A')
    await until(() => fs.existsSync(marker('A', 'inside')), 'A enters callback')
    if (kind === 'legacy') {
      const lockFile = path.join(directory, 'legacy.lock')
      const [pid] = fs.readFileSync(lockFile, 'utf8').split(':')
      fs.writeFileSync(lockFile, pid + ':' + (Date.now() - 10001))
    }
    start('B')
    await until(() => fs.existsSync(marker('B', 'inside')) || fs.existsSync(marker('B', 'result')), 'B enters or times out')
    assert(first.pid && first.exitCode === null && first.signalCode === null, 'A is still a live process')
    process.kill(first.pid, 0)
    const overlap = fs.existsSync(marker('A', 'inside')) && fs.existsSync(marker('B', 'inside'))
    assert.equal(overlap, expectedOverlap, moduleName + ' callback ownership')
    if (!expectedOverlap) assert.match(fs.readFileSync(marker('B', 'result'), 'utf8'), /Timed out waiting for relay lifecycle lock/)
    console.log(moduleName + ': ' + (overlap ? 'overlap reproduced' : 'B timed out while A retained ownership'))
  } finally {
    for (const name of ['A', 'B']) fs.writeFileSync(marker(name, 'release'), '')
    try {
      await until(() => children.every(child => child.exitCode !== null || child.signalCode !== null), 'worker cleanup')
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))))
    }
  }
}

try {
  await scenario('legacy', 'legacy', true)
  await scenario('current', 'current', false)
  await scenario('no-post-scan', 'current', true)
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original, 'Production source unchanged')
  console.log('Source copies and markers: ' + scratch)
} catch (error) {
  console.error('Replay artifacts: ' + scratch)
  throw error
}
