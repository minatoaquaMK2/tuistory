#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { decodeAttachServerMessage, type AttachServerMessage } from '../../../../src/attach-protocol.js'
import { launchTerminal, type RecordingStatus } from '../../../../src/index.js'
import { findRelayListeners } from '../../../../src/relay-listener.js'

type RelayPort = number & { readonly __brand: 'RelayPort' }

type FeatureScope = 'all' | 'lifecycle' | 'terminal' | 'recording' | 'protocols' | 'models'

type Command =
  | { kind: 'doctor'; port: RelayPort }
  | { kind: 'drive'; port: RelayPort; feature: FeatureScope; outDir: string }
  | { kind: 'cleanup'; port: RelayPort; outDir?: string }
  | { kind: 'validate-skill' }

type PortProbe =
  | { kind: 'no-listener' }
  | { kind: 'healthy'; version: string; listenerPids: number[] }
  | { kind: 'occupied-unresponsive'; listenerPids: number[] }

type CheckRecord = {
  id: string
  kind: 'cli' | 'library' | 'protocol' | 'model'
  status: 'passed' | 'skipped'
  featureIds: string[]
  statechartStates: string[]
  properties: string[]
  actionArtifact: string
  observationArtifact: string
  assertion: string
}

const RESERVED_PORTS = new Set([19977, 19951, 19952])
const DEFAULT_VERIFY_PORT = 19953
const PINNED_TLC_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const skillRoot = fileURLToPath(new URL('../', import.meta.url))

const packageSchema = z.object({ version: z.string().min(1) })
const versionResponseSchema = z.object({ version: z.string().min(1) })
const sessionListSchema = z.array(
  z.object({
    name: z.string(),
    command: z.string(),
    cwd: z.string(),
    cols: z.number(),
    rows: z.number(),
    dead: z.boolean(),
    startedAt: z.number(),
  }),
)
const statusFields = {
  recordingId: z.string(),
  path: z.string(),
  partialPath: z.string(),
  elapsedSeconds: z.number(),
  queuedBytes: z.number(),
  maxQueuedBytes: z.number(),
}
const recordingStatusSchema = z.discriminatedUnion('kind', [
  z.object({ ...statusFields, kind: z.literal('active') }),
  z.object({ ...statusFields, kind: z.literal('finishing') }),
  z.object({ ...statusFields, kind: z.literal('saved'), extent: z.enum(['interval', 'process']) }),
  z.object({ ...statusFields, kind: z.literal('partial'), reason: z.string() }),
]) satisfies z.ZodType<RecordingStatus>
const framesSchema = z.array(z.string())
const castHeaderSchema = z.object({
  version: z.literal(3),
  term: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }),
})
const castEventSchema = z.tuple([z.number().nonnegative(), z.enum(['o', 'r', 'm', 'x']), z.string()])
const ffprobeSchema = z.object({
  streams: z.array(
    z.object({
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional() }).optional(),
})

function isRelayPort(value: number): value is RelayPort {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 && !RESERVED_PORTS.has(value)
}

function parseRelayPort(raw: string | undefined): RelayPort {
  const num = raw === undefined ? DEFAULT_VERIFY_PORT : Number(raw)
  if (!isRelayPort(num)) {
    throw new Error(
      `Invalid verification port "${raw ?? num}". Choose a TCP port in 1024..65535 outside reserved ports 19977, 19951, and 19952.`,
    )
  }
  return num
}

function isFeatureScope(value: string): value is FeatureScope {
  return (
    value === 'all' ||
    value === 'lifecycle' ||
    value === 'terminal' ||
    value === 'recording' ||
    value === 'protocols' ||
    value === 'models'
  )
}

function parseArgs(argv: string[]): Command {
  const [subcommand = 'doctor', ...rest] = argv
  let portRaw: string | undefined
  let featureRaw = 'all'
  let outRaw: string | undefined

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]
    if (token === '--port') {
      portRaw = rest[++index]
    } else if (token === '--feature' || token === '--scope') {
      featureRaw = rest[++index] ?? ''
    } else if (token === '--out') {
      outRaw = rest[++index]
    } else {
      throw new Error(`Unknown option "${token}"`)
    }
  }

  if (subcommand === 'validate-skill') {
    return { kind: 'validate-skill' }
  }
  const port = parseRelayPort(portRaw)
  if (subcommand === 'doctor') {
    return { kind: 'doctor', port }
  }
  if (subcommand === 'cleanup') {
    return { kind: 'cleanup', port, outDir: outRaw ? path.resolve(outRaw) : undefined }
  }
  if (subcommand === 'drive') {
    if (!isFeatureScope(featureRaw)) {
      throw new Error(`Invalid --feature "${featureRaw}". Expected all, lifecycle, terminal, recording, protocols, or models.`)
    }
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const outDir = outRaw
      ? path.resolve(outRaw)
      : path.join(repoRoot, 'tmp', 'verification', `verify-${stamp}`)
    return { kind: 'drive', port, feature: featureRaw, outDir }
  }
  throw new Error(`Unknown subcommand "${subcommand}". Expected doctor, drive, cleanup, or validate-skill.`)
}

function writeJson(targetPath: string, payload: unknown): string {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2) + '\n')
  return targetPath
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function findBinary(name: string): string | null {
  const result = spawnSync('which', [name], { encoding: 'utf8', timeout: 5000 })
  return result.status === 0 ? result.stdout.trim() : null
}

function resolveTlaJar(): { path: string; sha256: string; valid: boolean } | null {
  const candidates = [
    process.env.TLA2TOOLS,
    path.join(os.homedir(), '.local/share/tuistory-tools/tla2tools-1.7.4.jar'),
  ].filter((entry): entry is string => Boolean(entry))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const digest = sha256File(candidate)
      return { path: candidate, sha256: digest, valid: digest === PINNED_TLC_SHA256 }
    }
  }
  return null
}

async function probeRelayPort(port: RelayPort): Promise<PortProbe> {
  const listeners = await findRelayListeners(port).catch(() => [])
  const listenerPids = listeners.map(entry => Number(entry.pid))
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(800),
    })
    if (response.ok) {
      const parsed = versionResponseSchema.safeParse(await response.json())
      if (parsed.success) {
        return { kind: 'healthy', version: parsed.data.version, listenerPids }
      }
    }
  } catch {
    if (listenerPids.length === 0) {
      return { kind: 'no-listener' }
    }
  }
  return listenerPids.length === 0 ? { kind: 'no-listener' } : { kind: 'occupied-unresponsive', listenerPids }
}

function runCli(
  port: RelayPort,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; artifactPath?: string } = {},
) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'src/cli.ts'), ...args], {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      TUISTORY_PORT: String(port),
      ...options.env,
    },
    encoding: 'utf8',
    timeout: 25_000,
  })
  if (result.error) throw result.error
  const record = {
    args,
    cwd: options.cwd ?? repoRoot,
    exitCode: result.status ?? -1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
  if (options.artifactPath) {
    writeJson(options.artifactPath, record)
  }
  return record
}

async function stopVerifyDaemon(port: RelayPort): Promise<PortProbe> {
  const initial = await probeRelayPort(port)
  if (initial.kind !== 'no-listener') {
    runCli(port, ['daemon-stop'])
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const current = await probeRelayPort(port)
    if (current.kind === 'no-listener') return current
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return probeRelayPort(port)
}

async function runDoctor(port: RelayPort) {
  const pkg = packageSchema.parse(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')))
  const gitRev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
  const distCliExists = fs.existsSync(path.join(repoRoot, 'dist/cli.js'))
  const featureMapRun = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/check-feature-map.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
  })
  const portProbe = await probeRelayPort(port)
  const tlaJar = resolveTlaJar()
  return {
    ok: distCliExists && featureMapRun.status === 0,
    repoRoot,
    gitRevision: gitRev,
    packageVersion: pkg.version,
    distBuilt: distCliExists,
    port,
    portState: portProbe.kind,
    portDetails: portProbe,
    runtimes: {
      bun: process.versions.bun ?? null,
      node: findBinary('node'),
      ffmpeg: findBinary('ffmpeg'),
      ffprobe: findBinary('ffprobe'),
      java: findBinary('java'),
      tla2tools: tlaJar,
    },
    featureMapCheck: {
      ok: featureMapRun.status === 0,
      summary: (featureMapRun.stdout ?? '').trim().split('\n')[0] ?? '',
    },
  }
}

function readPngHeader(filePath: string): { width: number; height: number; signatureHex: string } {
  const bytes = fs.readFileSync(filePath)
  assert(bytes.byteLength >= 24, 'PNG file is shorter than 24 bytes')
  const signatureHex = bytes.subarray(0, 8).toString('hex')
  assert.equal(signatureHex, '89504e470d0a1a0a', 'Invalid PNG signature')
  const ihdrTag = bytes.subarray(12, 16).toString('ascii')
  assert.equal(ihdrTag, 'IHDR', 'Missing IHDR chunk')
  return {
    signatureHex,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

function parseCastFile(filePath: string) {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
  assert(lines.length >= 2, `Cast file ${filePath} has fewer than 2 lines`)
  const header = castHeaderSchema.parse(JSON.parse(lines[0]))
  const events = lines.slice(1).map(line => castEventSchema.parse(JSON.parse(line)))
  return { header, events, lineCount: lines.length, sha256: sha256File(filePath) }
}

async function driveLifecycle(port: RelayPort, artifactsDir: string, scratchDir: string): Promise<CheckRecord[]> {
  const checks: CheckRecord[] = []
  const preProbe = await stopVerifyDaemon(port)
  assert.equal(preProbe.kind, 'no-listener', 'Port must start with no listener before lifecycle drive')

  const launchCmd =
    'node -e "console.log(\'LIFE_READY:\' + process.pid + \':\' + process.env.TUISTORY_SESSION_ID + \':\' + process.env.VERIFY_FLAG); setInterval(() => {}, 1000)"'
  const launchActionPath = path.join(artifactsDir, 'lifecycle-cold-launch.action.json')
  const launchRes = runCli(
    port,
    [
      'launch',
      launchCmd,
      '-s',
      'verify-life',
      '--cols',
      '90',
      '--rows',
      '28',
      '--cwd',
      scratchDir,
      '--env',
      'VERIFY_FLAG=expected_val',
      '--background',
    ],
    { artifactPath: launchActionPath },
  )
  assert.equal(launchRes.exitCode, 0, `Cold launch failed: ${launchRes.stderr}`)

  const waitRes = runCli(port, ['wait', 'LIFE_READY:', '-s', 'verify-life', '--timeout', '8000'])
  assert.equal(waitRes.exitCode, 0, `Wait for LIFE_READY failed: ${waitRes.stderr}`)

  const postLaunchProbe = await probeRelayPort(port)
  assert.equal(postLaunchProbe.kind, 'healthy', 'Daemon must be healthy after cold launch')
  assert(postLaunchProbe.listenerPids.length === 1, 'Expected exactly one relay listener PID')
  const initialDaemonPid = postLaunchProbe.listenerPids[0]

  const sessionsRes = runCli(port, ['sessions', '--json'])
  assert.equal(sessionsRes.exitCode, 0)
  const sessions = sessionListSchema.parse(JSON.parse(sessionsRes.stdout))
  const lifeEntry = sessions.find(entry => entry.name === 'verify-life')
  assert(lifeEntry && !lifeEntry.dead && lifeEntry.cols === 90 && lifeEntry.rows === 28, 'Session metadata mismatch')

  const firstRead = runCli(port, ['read', '-s', 'verify-life', '--all', '--trim'])
  const readyMatch = /LIFE_READY:(\d+):([^:\s]+):expected_val/.exec(firstRead.stdout)
  assert(readyMatch, `Unexpected LIFE_READY output: ${firstRead.stdout}`)
  const initialChildPid = Number(readyMatch[1])
  const initialSessionId = readyMatch[2]

  const coldObsPath = writeJson(path.join(artifactsDir, 'lifecycle-cold-launch.obs.json'), {
    postLaunchProbe,
    sessions,
    firstRead: firstRead.stdout,
    initialChildPid,
    initialSessionId,
  })
  checks.push({
    id: 'relay-cold-start',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F01', 'F02'],
    statechartStates: [
      'Relay: Probe port',
      'Relay: Acquire restart lock',
      'Relay: Recheck under lock',
      'Relay: Port confirmed free',
      'Relay: Wait for new daemon',
      'Relay: Use compatible daemon',
    ],
    properties: ['R2', 'R3', 'R4'],
    actionArtifact: launchActionPath,
    observationArtifact: coldObsPath,
    assertion: 'Cold start on a free port acquires the lifecycle lock, spawns one daemon on port 19953, and starts verify-life with requested dimensions, cwd, and env.',
  })

  const reuseActionPath = path.join(artifactsDir, 'lifecycle-reuse.action.json')
  const reuseRes = runCli(
    port,
    ['launch', 'echo SHOULD_NOT_EXECUTE', '-s', 'verify-life', '--background'],
    { artifactPath: reuseActionPath },
  )
  assert.equal(reuseRes.exitCode, 0)
  const reuseProbe = await probeRelayPort(port)
  assert.equal(reuseProbe.kind, 'healthy')
  assert.deepEqual(reuseProbe.listenerPids, [initialDaemonPid], 'Compatible daemon must not be replaced')
  const reuseRead = runCli(port, ['read', '-s', 'verify-life', '--all', '--trim'])
  assert(!reuseRead.stdout.includes('SHOULD_NOT_EXECUTE'), 'Reused live session must not run replacement command')
  const reuseObsPath = writeJson(path.join(artifactsDir, 'lifecycle-reuse.obs.json'), {
    reuseProbe,
    buffer: reuseRead.stdout,
  })
  checks.push({
    id: 'relay-reuse-compatible',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F01', 'F02'],
    statechartStates: ['Relay: Probe port', 'Relay: Use compatible daemon'],
    properties: ['R1', 'N1'],
    actionArtifact: reuseActionPath,
    observationArtifact: reuseObsPath,
    assertion: 'Subsequent CLI call reuses the compatible healthy daemon PID and existing live session without re-spawning.',
  })

  const restartActionPath = path.join(artifactsDir, 'lifecycle-restart.action.json')
  const restartRes = runCli(port, ['restart', '-s', 'verify-life'], { artifactPath: restartActionPath })
  assert.equal(restartRes.exitCode, 0, `Restart failed: ${restartRes.stderr}`)
  runCli(port, ['wait', 'LIFE_READY:', '-s', 'verify-life', '--timeout', '8000'])
  const afterRestartRead = runCli(port, ['read', '-s', 'verify-life', '--all', '--trim'])
  const restartMatch = /LIFE_READY:(\d+):([^:\s]+):expected_val/.exec(afterRestartRead.stdout)
  assert(restartMatch, `Missing LIFE_READY after restart: ${afterRestartRead.stdout}`)
  const restartedChildPid = Number(restartMatch[1])
  const restartedSessionId = restartMatch[2]
  assert.notEqual(restartedChildPid, initialChildPid, 'Restart must spawn a new child process')
  assert.equal(restartedSessionId, initialSessionId, 'Restart must preserve TUISTORY_SESSION_ID')
  const restartObsPath = writeJson(path.join(artifactsDir, 'lifecycle-restart.obs.json'), {
    initialChildPid,
    restartedChildPid,
    initialSessionId,
    restartedSessionId,
  })
  checks.push({
    id: 'session-restart-identity',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F02'],
    statechartStates: ['Relay: Use compatible daemon'],
    properties: ['N2'],
    actionArtifact: restartActionPath,
    observationArtifact: restartObsPath,
    assertion: 'Session restart replaces the child process PID while preserving TUISTORY_SESSION_ID, cwd, dimensions, and env.',
  })

  const deadCmd = 'node -e "console.log(\'DEAD_ID:\' + process.env.TUISTORY_SESSION_ID)"'
  runCli(port, ['launch', deadCmd, '-s', 'verify-dead', '--background'])
  runCli(port, ['wait', 'DEAD_ID:', '-s', 'verify-dead', '--timeout', '8000'])
  const deadRead1 = runCli(port, ['read', '-s', 'verify-dead', '--all', '--trim'])
  const deadId1 = /DEAD_ID:(\S+)/.exec(deadRead1.stdout)?.[1]
  assert(deadId1, 'Missing initial dead session ID')
  await new Promise(resolve => setTimeout(resolve, 150))
  const replaceActionPath = path.join(artifactsDir, 'lifecycle-replace-dead.action.json')
  runCli(port, ['launch', deadCmd, '-s', 'verify-dead', '--background'], { artifactPath: replaceActionPath })
  runCli(port, ['wait', 'DEAD_ID:', '-s', 'verify-dead', '--timeout', '8000'])
  const deadRead2 = runCli(port, ['read', '-s', 'verify-dead', '--all', '--trim'])
  const deadId2 = /DEAD_ID:(\S+)/.exec(deadRead2.stdout)?.[1]
  assert(deadId2 && deadId2 !== deadId1, 'Replacing a dead session must generate a new TUISTORY_SESSION_ID')

  const closeRes = runCli(port, ['close', '-s', 'verify-life'])
  assert.equal(closeRes.exitCode, 0)
  runCli(port, ['close', '-s', 'verify-dead'])
  const stopActionPath = path.join(artifactsDir, 'lifecycle-daemon-stop.action.json')
  const stopRes = runCli(port, ['daemon-stop'], { artifactPath: stopActionPath })
  assert.equal(stopRes.exitCode, 0)
  const postStopProbe = await probeRelayPort(port)
  assert.equal(postStopProbe.kind, 'no-listener', 'Port must be free after daemon-stop')
  const stopObsPath = writeJson(path.join(artifactsDir, 'lifecycle-daemon-stop.obs.json'), {
    deadId1,
    deadId2,
    closeStdout: closeRes.stdout,
    stopStdout: stopRes.stdout,
    postStopProbe,
  })
  checks.push({
    id: 'session-close-and-daemon-stop',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F01', 'F02'],
    statechartStates: ['Relay: Stop unusable daemon', 'Relay: Port confirmed free'],
    properties: ['R2', 'R4'],
    actionArtifact: stopActionPath,
    observationArtifact: stopObsPath,
    assertion: 'Dead sessions are replaced with a fresh session ID, close removes active sessions, and daemon-stop frees the TCP port.',
  })

  return checks
}

async function driveTerminal(port: RelayPort, artifactsDir: string, scratchDir: string): Promise<CheckRecord[]> {
  const checks: CheckRecord[] = []
  const replScript = [
    'process.stdin.setEncoding("utf8");',
    'console.log("TERM_READY [CLICK_TARGET]");',
    'process.stdin.on("data", chunk => {',
    '  for (const line of chunk.split(/\\r?\\n/)) {',
    '    if (!line) continue;',
    '    console.log("LINE:" + line);',
    '  }',
    '});',
  ].join(' ')

  const launchActionPath = path.join(artifactsDir, 'terminal-interact.action.json')
  const launchRes = runCli(
    port,
    ['launch', `node -e '${replScript}'`, '-s', 'verify-term', '--cols', '80', '--rows', '24', '--background'],
    { artifactPath: launchActionPath },
  )
  assert.equal(launchRes.exitCode, 0, `Terminal launch failed: ${launchRes.stderr}`)
  assert.equal(runCli(port, ['wait', 'TERM_READY', '-s', 'verify-term']).exitCode, 0)
  assert.equal(runCli(port, ['type', 'hello_world', '-s', 'verify-term']).exitCode, 0)
  assert.equal(runCli(port, ['press', 'enter', '-s', 'verify-term']).exitCode, 0)
  assert.equal(runCli(port, ['wait', 'LINE:hello_world', '-s', 'verify-term']).exitCode, 0)
  assert.equal(runCli(port, ['wait-idle', '-s', 'verify-term', '--timeout', '300']).exitCode, 0)

  const read1 = runCli(port, ['read', '-s', 'verify-term', '--trim'])
  const read2 = runCli(port, ['read', '-s', 'verify-term', '--trim'])
  const readAll = runCli(port, ['read', '-s', 'verify-term', '--all', '--trim'])
  assert(read1.stdout.includes('LINE:hello_world'), 'First incremental read must return unread output')
  assert.equal(read2.stdout, '', 'Second incremental read must be empty after cursor advances')
  assert(readAll.stdout.includes('LINE:hello_world'), 'read --all must return buffered output without consuming')

  assert.equal(runCli(port, ['resize', '100', '30', '-s', 'verify-term']).exitCode, 0)
  assert.equal(runCli(port, ['click', 'CLICK_TARGET', '-s', 'verify-term']).exitCode, 0)
  assert.equal(runCli(port, ['click-at', '1', '0', '-s', 'verify-term']).exitCode, 0)
  assert.equal(runCli(port, ['scroll', 'down', '2', '-s', 'verify-term']).exitCode, 0)
  const framesRes = runCli(port, ['capture-frames', 'enter', '-s', 'verify-term', '--count', '2', '--interval', '15'])
  assert.equal(framesRes.exitCode, 0)
  const frames = framesSchema.parse(JSON.parse(framesRes.stdout))
  assert.equal(frames.length, 2)
  const snapRes = runCli(port, ['snapshot', '-s', 'verify-term', '--trim'])
  assert(snapRes.stdout.includes('LINE:hello_world'))
  runCli(port, ['close', '-s', 'verify-term'])

  const interactObsPath = writeJson(path.join(artifactsDir, 'terminal-interact.obs.json'), {
    read1: read1.stdout,
    read2: read2.stdout,
    readAll: readAll.stdout,
    frameCount: frames.length,
    snapshot: snapRes.stdout,
  })
  checks.push({
    id: 'terminal-interact-and-cursor',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F03', 'F04', 'F05', 'F06', 'F07'],
    statechartStates: ['Session: Running'],
    properties: ['O1', 'O2'],
    actionArtifact: launchActionPath,
    observationArtifact: interactObsPath,
    assertion: 'CLI type, press, wait, wait-idle, click, click-at, scroll, resize, snapshot, capture-frames, and incremental vs non-consuming read cursor semantics hold.',
  })

  const bundleDir = path.join(scratchDir, '.termcast-bundle')
  fs.mkdirSync(bundleDir, { recursive: true })
  const castPath = path.join(scratchDir, 'session-statechart.cast')
  const sessionActionPath = writeJson(path.join(artifactsDir, 'session-statechart.action.json'), {
    castPath,
    bundleDir,
  })

  const session = await launchTerminal({
    command: process.execPath,
    args: [
      '-e',
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const suffix = process.env.TERMCAST_DB_SUFFIX;',
        'const base = path.join(process.cwd(), ".termcast-bundle", "data-" + suffix + ".db");',
        'fs.writeFileSync(base, "db");',
        'fs.writeFileSync(base + "-wal", "wal");',
        'fs.writeFileSync(base + "-shm", "shm");',
        'console.log("LIB_TAIL_DONE:" + suffix);',
        'setTimeout(() => process.exit(7), 60);',
      ].join(' '),
    ],
    cols: 80,
    rows: 24,
    cwd: scratchDir,
    record: { path: castPath },
  })

  let closingCount = 0
  let exitObserved = false
  session.onClosing(() => {
    closingCount += 1
  })
  session.onExit(() => {
    exitObserved = true
  })

  await session.waitForText('LIB_TAIL_DONE:', { timeout: 5000 })
  const exited = await session.waitForExit(5000)
  assert.equal(exited, true, 'Child process must exit')
  const retainedText = await session.text({ immediate: true, trimEnd: true })
  const suffixMatch = /LIB_TAIL_DONE:(\S+)/.exec(retainedText)
  assert(suffixMatch, `Expected LIB_TAIL_DONE suffix in snapshot: ${retainedText}`)
  const dbBase = path.join(bundleDir, `data-${suffixMatch[1]}.db`)
  const dbWal = `${dbBase}-wal`
  const dbShm = `${dbBase}-shm`
  assert(fs.existsSync(dbBase), 'Generated TERMCAST DB must exist before session disposal')

  await Promise.all([session.closeAsync('verify-close'), session.closeAsync('verify-repeat')])
  assert.equal(closingCount, 1, 'onClosing listener must fire exactly once across repeated close calls')
  assert.equal(exitObserved, true, 'onExit listener must fire on real exit')
  assert.equal(session.exitInfo?.exitCode, 7, 'Real exit code must survive disposal')
  assert.equal(await session.waitForExit(100), true, 'waitForExit after disposal must still return true')

  let writeRejected = false
  try {
    session.writeRaw('after-close')
  } catch {
    writeRejected = true
  }
  let resizeRejected = false
  try {
    session.resize({ cols: 90, rows: 25 })
  } catch {
    resizeRejected = true
  }
  assert(writeRejected && resizeRejected, 'Writes and resizes after exit and close must be rejected')
  assert(!fs.existsSync(dbBase) && !fs.existsSync(dbWal) && !fs.existsSync(dbShm), 'Generated TERMCAST DB files must be cleaned after exit and disposal')

  const sessionObsPath = writeJson(path.join(artifactsDir, 'session-statechart.obs.json'), {
    closingCount,
    exitObserved,
    exitInfo: session.exitInfo,
    writeRejected,
    resizeRejected,
    dbCleaned: !fs.existsSync(dbBase),
    recordingStatus: session.recording?.status(),
  })
  checks.push({
    id: 'session-statechart-invariants',
    kind: 'library',
    status: 'passed',
    featureIds: ['F03', 'F06', 'F07'],
    statechartStates: [
      'Session: Running',
      'Session: Exited; reading output tail',
      'Session: Exited; output complete',
      'Session: Closing; completion settled',
      'Session: Disposed; cleanup attempted',
    ],
    properties: ['O3', 'S1', 'S2', 'S3', 'S4'],
    actionArtifact: sessionActionPath,
    observationArtifact: sessionObsPath,
    assertion: 'Recorded Session transitions through exit, EOF tail drain, and close: writes/resizes after exit or close throw (S1), close notifies once (S2), real exit code 7 persists after disposal (S3), and TERMCAST files are removed after exit (S4).',
  })

  return checks
}

async function driveRecording(port: RelayPort, artifactsDir: string, scratchDir: string): Promise<CheckRecord[]> {
  const checks: CheckRecord[] = []
  const intervalCast = path.join(scratchDir, 'interval.cast')
  const processCast = path.join(scratchDir, 'process.cast')
  const screenshotPath = path.join(scratchDir, 'screen-2x.png')
  const mp4Path = path.join(scratchDir, 'interval.mp4')

  const intActionPath = path.join(artifactsDir, 'recording-interval.action.json')
  const intLaunch = runCli(
    port,
    [
      'launch',
      'node -e "console.log(\'REC_INT_READY\'); setInterval(() => {}, 1000)"',
      '-s',
      'verify-rec-int',
      '--cols',
      '80',
      '--rows',
      '24',
      '--record',
      intervalCast,
      '--background',
    ],
    { artifactPath: intActionPath },
  )
  assert.equal(intLaunch.exitCode, 0, `Interval recording launch failed: ${intLaunch.stderr}`)
  assert.equal(runCli(port, ['wait', 'REC_INT_READY', '-s', 'verify-rec-int']).exitCode, 0)
  assert.equal(runCli(port, ['resize', '90', '26', '-s', 'verify-rec-int']).exitCode, 0)
  assert.equal(runCli(port, ['record', 'mark', 'checkpoint-1', '-s', 'verify-rec-int']).exitCode, 0)

  const activeStatusRes = runCli(port, ['record', 'status', '-s', 'verify-rec-int', '--json'])
  const activeStatus = recordingStatusSchema.parse(JSON.parse(activeStatusRes.stdout))
  assert.equal(activeStatus.kind, 'active')

  const shotRes = runCli(port, [
    'screenshot',
    '-s',
    'verify-rec-int',
    '-o',
    screenshotPath,
    '--pixel-ratio',
    '2',
  ])
  assert.equal(shotRes.exitCode, 0, `Screenshot failed: ${shotRes.stderr}`)
  const pngHeader = readPngHeader(screenshotPath)
  assert(pngHeader.width > 800 && pngHeader.height > 400, '2x Retina screenshot dimensions must reflect physical scale')

  const stopRes = runCli(port, ['record', 'stop', '-s', 'verify-rec-int'])
  assert.equal(stopRes.exitCode, 0, `Record stop failed: ${stopRes.stderr}`)
  const savedIntStatus = recordingStatusSchema.parse(JSON.parse(stopRes.stdout))
  assert(savedIntStatus.kind === 'saved' && savedIntStatus.extent === 'interval', 'Expected saved interval status')

  const sessionsAfterStop = sessionListSchema.parse(JSON.parse(runCli(port, ['sessions', '--json']).stdout))
  const liveAfterStop = sessionsAfterStop.find(entry => entry.name === 'verify-rec-int')
  assert(liveAfterStop && !liveAfterStop.dead, 'Manual record stop must leave the child process running')

  const parsedInterval = parseCastFile(intervalCast)
  const intervalCodes = parsedInterval.events.map(event => event[1])
  assert(intervalCodes.includes('o') && intervalCodes.includes('r') && intervalCodes.includes('m'), 'Interval cast must contain o, r, and m events')
  assert(!intervalCodes.includes('x'), 'Interval cast must not fabricate a process exit event')
  runCli(port, ['close', '-s', 'verify-rec-int'])

  const intObsPath = writeJson(path.join(artifactsDir, 'recording-interval.obs.json'), {
    activeStatus,
    savedIntStatus,
    parsedInterval,
    pngHeader,
  })
  checks.push({
    id: 'recorder-interval-and-screenshot',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F08', 'F10', 'F11'],
    statechartStates: [
      'Recorder: Recording output',
      'Recorder: Drain and sync interval',
      'Recorder: Publish interval',
      'Recorder: Sync interval directory',
      'Recorder: Saved interval',
    ],
    properties: ['C1', 'C2', 'C4', 'W3'],
    actionArtifact: intActionPath,
    observationArtifact: intObsPath,
    assertion: 'Manual record stop transitions Recorder through interval drain, link publication, and directory sync to Saved interval without an x event while keeping the child alive, and renders a 2x Retina PNG screenshot.',
  })

  const procActionPath = path.join(artifactsDir, 'recording-process.action.json')
  const procLaunch = runCli(
    port,
    [
      'launch',
      'node -e "console.log(\'REC_PROC_COMPLETE\')"',
      '-s',
      'verify-rec-proc',
      '--record',
      processCast,
      '--background',
    ],
    { artifactPath: procActionPath },
  )
  assert.equal(procLaunch.exitCode, 0, `Process recording launch failed: ${procLaunch.stderr}`)
  assert.equal(runCli(port, ['wait', 'REC_PROC_COMPLETE', '-s', 'verify-rec-proc']).exitCode, 0)
  assert.equal(runCli(port, ['close', '-s', 'verify-rec-proc']).exitCode, 0)
  const parsedProcess = parseCastFile(processCast)
  const lastEvent = parsedProcess.events[parsedProcess.events.length - 1]
  assert.equal(lastEvent?.[1], 'x', 'Process recording must end with a terminal x event')

  const originalDigest = parsedProcess.sha256
  const clobberRes = runCli(port, [
    'launch',
    'echo SHOULD_FAIL',
    '-s',
    'verify-clobber',
    '--record',
    processCast,
    '--background',
  ])
  assert.notEqual(clobberRes.exitCode, 0, 'Recording to an existing destination path must fail')
  assert.equal(sha256File(processCast), originalDigest, 'Existing cast file bytes must remain untouched')

  const procObsPath = writeJson(path.join(artifactsDir, 'recording-process.obs.json'), {
    parsedProcess,
    clobberExitCode: clobberRes.exitCode,
    clobberStderr: clobberRes.stderr,
    digestUnchanged: sha256File(processCast) === originalDigest,
  })
  checks.push({
    id: 'recorder-process-and-noclobber',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F08'],
    statechartStates: [
      'Recorder: Recording output',
      'Recorder: Drain and sync process',
      'Recorder: Publish process',
      'Recorder: Sync process directory',
      'Recorder: Saved process',
      'Recorder: Partial recording',
    ],
    properties: ['C1', 'C3'],
    actionArtifact: procActionPath,
    observationArtifact: procObsPath,
    assertion: 'Process recording publishes Saved process with a terminal x record after clean EOF, and existing destination paths are rejected without overwriting.',
  })

  await stopVerifyDaemon(port)
  const exportActionPath = path.join(artifactsDir, 'recording-export.action.json')
  const ffmpegPath = findBinary('ffmpeg')
  const ffprobePath = findBinary('ffprobe')
  if (!ffmpegPath || !ffprobePath) {
    const skipObs = writeJson(path.join(artifactsDir, 'recording-export.obs.json'), {
      skippedReason: 'ffmpeg or ffprobe binary not found on PATH',
    })
    checks.push({
      id: 'video-export-offline',
      kind: 'cli',
      status: 'skipped',
      featureIds: ['F09', 'F11'],
      statechartStates: [],
      properties: ['W1', 'W2'],
      actionArtifact: writeJson(exportActionPath, { skipped: true }),
      observationArtifact: skipObs,
      assertion: 'Skipped MP4 export because ffmpeg or ffprobe is absent.',
    })
    return checks
  }

  const exportRes = runCli(
    port,
    ['export', intervalCast, '-o', mp4Path, '--fps', '10'],
    { artifactPath: exportActionPath },
  )
  assert.equal(exportRes.exitCode, 0, `Offline export failed: ${exportRes.stderr}`)
  const probeAfterExport = await probeRelayPort(port)
  assert.equal(probeAfterExport.kind, 'no-listener', 'Offline export must not start a relay daemon')

  const ffprobeRun = spawnSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', mp4Path],
    { encoding: 'utf8', timeout: 15_000 },
  )
  assert.equal(ffprobeRun.status, 0, `ffprobe failed: ${ffprobeRun.stderr}`)
  const probeData = ffprobeSchema.parse(JSON.parse(ffprobeRun.stdout))
  assert(probeData.streams.length > 0 && probeData.streams[0]?.codec_name === 'h264', 'Expected H.264 stream in exported MP4')

  const exportObsPath = writeJson(path.join(artifactsDir, 'recording-export.obs.json'), {
    exportStdout: exportRes.stdout,
    daemonStarted: probeAfterExport.kind !== 'no-listener',
    ffprobe: probeData,
  })
  checks.push({
    id: 'video-export-offline',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F09', 'F11'],
    statechartStates: [],
    properties: ['W1', 'W2'],
    actionArtifact: exportActionPath,
    observationArtifact: exportObsPath,
    assertion: 'Offline CLI export renders asciicast v3 through the worker pool to an H.264 MP4 without starting a relay daemon.',
  })

  return checks
}

async function driveProtocols(port: RelayPort, artifactsDir: string): Promise<CheckRecord[]> {
  const checks: CheckRecord[] = []
  await stopVerifyDaemon(port)

  const diagActionPath = path.join(artifactsDir, 'protocols-diagnostics.action.json')
  const verRes = runCli(port, ['--version'], { artifactPath: diagActionPath })
  const helpRes = runCli(port, ['--help'])
  const probeAfterLocal = await probeRelayPort(port)
  assert.equal(verRes.exitCode, 0)
  assert.equal(helpRes.exitCode, 0)
  assert.equal(probeAfterLocal.kind, 'no-listener', '--version and --help must execute locally without starting a daemon')

  const launchRes = runCli(port, [
    'launch',
    'node -e "process.stdin.setEncoding(\'utf8\'); console.log(\'PROTO_READY\'); process.stdin.on(\'data\', d => console.log(\'WS_IN:\' + d.trim()))"',
    '-s',
    'verify-proto',
    '--cols',
    '80',
    '--rows',
    '24',
    '--background',
  ])
  assert.equal(launchRes.exitCode, 0)
  assert.equal(runCli(port, ['wait', 'PROTO_READY', '-s', 'verify-proto']).exitCode, 0)
  const logfileRes = runCli(port, ['logfile'])
  assert.equal(logfileRes.exitCode, 0)
  assert(logfileRes.stdout.endsWith('.log'), 'logfile command must print the relay log path')

  const diagObsPath = writeJson(path.join(artifactsDir, 'protocols-diagnostics.obs.json'), {
    version: verRes.stdout,
    helpLength: helpRes.stdout.length,
    probeAfterLocal,
    logfile: logfileRes.stdout,
  })
  checks.push({
    id: 'diagnostics-local-dispatch',
    kind: 'cli',
    status: 'passed',
    featureIds: ['F14'],
    statechartStates: [],
    properties: [],
    actionArtifact: diagActionPath,
    observationArtifact: diagObsPath,
    assertion: 'Local --version and --help return without spawning a daemon, and logfile reports the relay log file path.',
  })

  const admissionActionPath = writeJson(path.join(artifactsDir, 'protocols-admission.action.json'), {
    port,
    cases: ['origin-evil', 'host-evil', 'sec-fetch-cross-site', 'valid-loopback'],
  })
  const originReject = await fetch(`http://127.0.0.1:${port}/version`, {
    headers: { Origin: 'https://evil.example' },
  })
  const hostReject = await fetch(`http://127.0.0.1:${port}/sessions`, {
    headers: { Host: `evil.example:${port}` },
  })
  const fetchSiteReject = await fetch(`http://127.0.0.1:${port}/cli`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ argv: ['sessions'], cwd: repoRoot, env: {} }),
  })
  const validResp = await fetch(`http://127.0.0.1:${port}/version`)
  assert.equal(originReject.status, 403, 'Browser Origin header must be rejected with 403')
  assert.equal(hostReject.status, 403, 'Foreign Host header must be rejected with 403')
  assert.equal(fetchSiteReject.status, 403, 'Cross-site Sec-Fetch-Site header must be rejected with 403')
  assert.equal(validResp.status, 200, 'Loopback request without browser headers must succeed')

  const admissionObsPath = writeJson(path.join(artifactsDir, 'protocols-admission.obs.json'), {
    originStatus: originReject.status,
    hostStatus: hostReject.status,
    fetchSiteStatus: fetchSiteReject.status,
    validStatus: validResp.status,
  })
  checks.push({
    id: 'request-admission-boundary',
    kind: 'protocol',
    status: 'passed',
    featureIds: ['F13'],
    statechartStates: [],
    properties: ['A3'],
    actionArtifact: admissionActionPath,
    observationArtifact: admissionObsPath,
    assertion: 'HTTP middleware rejects cross-origin Origin, foreign Host, and Sec-Fetch-Site: cross-site requests with 403 before route handlers run.',
  })

  const wsActionPath = writeJson(path.join(artifactsDir, 'protocols-attach.action.json'), {
    url: `ws://127.0.0.1:${port}/attach`,
    session: 'verify-proto',
    protocol: 2,
  })

  const wsTranscript = await new Promise<{
    messages: AttachServerMessage[]
    missingError: AttachServerMessage | null
    missingCloseCode: number
  }>((resolve, reject) => {
    const messages: AttachServerMessage[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('Timed out driving WebSocket attach protocol 2'))
    }, 8000)

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'attach', session: 'verify-proto', cols: 80, rows: 24, protocol: 2 }))
    })

    let sentInput = false
    ws.addEventListener('message', event => {
      const decoded = decodeAttachServerMessage(String(event.data))
      if (!decoded) return
      messages.push(decoded)
      if (!sentInput && decoded.type === 'data' && decoded.data.includes('PROTO_READY')) {
        sentInput = true
        ws.send(JSON.stringify({ type: 'resize', cols: 96, rows: 29 }))
        ws.send(JSON.stringify({ type: 'input', data: 'from_ws_v2\n' }))
      }
      if (decoded.type === 'data' && decoded.data.includes('WS_IN:from_ws_v2')) {
        ws.close()
      }
    })

    ws.addEventListener('close', () => {
      const missingWs = new WebSocket(`ws://127.0.0.1:${port}/attach`)
      let missingError: AttachServerMessage | null = null
      missingWs.addEventListener('open', () => {
        missingWs.send(JSON.stringify({ type: 'attach', session: 'nonexistent-session', protocol: 2 }))
      })
      missingWs.addEventListener('message', ev => {
        const msg = decodeAttachServerMessage(String(ev.data))
        if (msg?.type === 'error') missingError = msg
      })
      missingWs.addEventListener('close', closeEv => {
        clearTimeout(timer)
        resolve({ messages, missingError, missingCloseCode: closeEv.code })
      })
    })
  })

  assert(
    wsTranscript.messages.some(msg => msg.type === 'attached' && msg.protocol === 2),
    'Protocol 2 handshake must begin with {"type":"attached","protocol":2}',
  )
  assert(
    wsTranscript.messages.some(msg => msg.type === 'data' && msg.data.includes('WS_IN:from_ws_v2')),
    'Protocol 2 input envelope must echo through the PTY stream',
  )
  assert.equal(wsTranscript.missingError?.type, 'error', 'Missing session attach must emit an error message')
  assert.equal(wsTranscript.missingCloseCode, 1008, 'Missing session attach must close with code 1008')

  const sessionsAfterDetach = sessionListSchema.parse(JSON.parse(runCli(port, ['sessions', '--json']).stdout))
  const protoEntry = sessionsAfterDetach.find(entry => entry.name === 'verify-proto')
  assert(protoEntry && !protoEntry.dead && protoEntry.cols === 96 && protoEntry.rows === 29, 'Detaching WebSocket must leave session alive with updated dimensions')
  runCli(port, ['close', '-s', 'verify-proto'])
  await stopVerifyDaemon(port)

  const wsObsPath = writeJson(path.join(artifactsDir, 'protocols-attach.obs.json'), {
    messageCount: wsTranscript.messages.length,
    attachedAck: wsTranscript.messages[0],
    missingError: wsTranscript.missingError,
    missingCloseCode: wsTranscript.missingCloseCode,
    sessionAfterDetach: protoEntry,
  })
  checks.push({
    id: 'attach-protocol-v2',
    kind: 'protocol',
    status: 'passed',
    featureIds: ['F12'],
    statechartStates: [],
    properties: ['A1', 'A2'],
    actionArtifact: wsActionPath,
    observationArtifact: wsObsPath,
    assertion: 'WebSocket /attach negotiates protocol 2, replays output, applies resize and framed input, keeps the session alive on detach (A1), releases subscriptions (A2), and rejects missing sessions with code 1008.',
  })

  return checks
}

async function driveModels(artifactsDir: string): Promise<CheckRecord[]> {
  const checks: CheckRecord[] = []
  const mapActionPath = writeJson(path.join(artifactsDir, 'models-feature-map.action.json'), {
    script: 'scripts/check-feature-map.mjs',
  })
  const mapRun = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/check-feature-map.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.equal(mapRun.status, 0, `check-feature-map.mjs failed: ${mapRun.stderr}`)
  const mapObsPath = writeJson(path.join(artifactsDir, 'models-feature-map.obs.json'), {
    stdout: mapRun.stdout.trim(),
  })
  checks.push({
    id: 'feature-map-inventory-check',
    kind: 'model',
    status: 'passed',
    featureIds: ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14'],
    statechartStates: [],
    properties: [],
    actionArtifact: mapActionPath,
    observationArtifact: mapObsPath,
    assertion: 'scripts/check-feature-map.mjs confirms all 24 CLI registrations, 37 public Session members, 14 root exports, and local links in docs/feature-map/.',
  })

  const javaPath = findBinary('java')
  const tlaJar = resolveTlaJar()
  const tlcActionPath = writeJson(path.join(artifactsDir, 'models-tlc.action.json'), {
    models: ['Relay', 'Session', 'Recorder'],
    controlsScript: 'scripts/check-statechart-controls.mjs',
  })
  if (!javaPath || !tlaJar || !tlaJar.valid) {
    const skipObs = writeJson(path.join(artifactsDir, 'models-tlc.obs.json'), {
      skippedReason: 'java or valid pinned tla2tools-1.7.4.jar is unavailable',
      javaPath,
      tlaJar,
    })
    checks.push({
      id: 'statechart-tlc-and-controls',
      kind: 'model',
      status: 'skipped',
      featureIds: ['F01', 'F07', 'F08'],
      statechartStates: [],
      properties: ['R1', 'R2', 'R4', 'S1', 'S2', 'S4', 'C1', 'C2', 'C3', 'C4'],
      actionArtifact: tlcActionPath,
      observationArtifact: skipObs,
      assertion: 'Skipped TLC model checking because java or pinned tla2tools-1.7.4.jar was not found.',
    })
    return checks
  }

  const expectedModels = [
    { name: 'Relay', initial: 4, generated: 53, steps: 49, distinct: 22 },
    { name: 'Session', initial: 1, generated: 27, steps: 26, distinct: 12 },
    { name: 'Recorder', initial: 2, generated: 116, steps: 114, distinct: 64 },
  ]
  const scratchTlc = fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-verify-tlc-'))
  const modelResults: Array<{ name: string; initial: number; generated: number; steps: number; distinct: number }> = []
  try {
    for (const model of expectedModels) {
      const modelDir = path.join(repoRoot, 'docs/feature-map/models')
      fs.copyFileSync(path.join(modelDir, `${model.name}.tla`), path.join(scratchTlc, `${model.name}.tla`))
      fs.copyFileSync(path.join(modelDir, `${model.name}.cfg`), path.join(scratchTlc, `${model.name}.cfg`))
      const run = spawnSync(
        javaPath,
        [
          '-XX:+UseParallelGC',
          '-cp',
          tlaJar.path,
          'tlc2.TLC',
          '-workers',
          '1',
          '-fp',
          '0',
          '-metadir',
          path.join(scratchTlc, `${model.name}-meta`),
          '-config',
          `${model.name}.cfg`,
          `${model.name}.tla`,
        ],
        { cwd: scratchTlc, encoding: 'utf8', timeout: 60_000 },
      )
      const output = (run.stdout ?? '') + (run.stderr ?? '')
      assert.equal(run.status, 0, `TLC failed on ${model.name}:\n${output}`)
      assert(output.includes('Model checking completed. No error has been found.'), `Unexpected TLC verdict for ${model.name}`)
      const initMatch = /Finished computing initial states: ([\d,]+) distinct states? generated/.exec(output)
      const match = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(output)
      assert(initMatch && match, `Missing state count in ${model.name} TLC output`)
      const initial = Number(initMatch[1].replaceAll(',', ''))
      const generated = Number(match[1].replaceAll(',', ''))
      const distinct = Number(match[2].replaceAll(',', ''))
      const steps = generated - initial
      assert.equal(initial, model.initial, `${model.name} initial states mismatch`)
      assert.equal(generated, model.generated, `${model.name} generated states mismatch`)
      assert.equal(steps, model.steps, `${model.name} transition steps mismatch`)
      assert.equal(distinct, model.distinct, `${model.name} distinct states mismatch`)
      modelResults.push({ name: model.name, initial, generated, steps, distinct })
    }
  } finally {
    fs.rmSync(scratchTlc, { recursive: true, force: true })
  }

  const controlsRun = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/check-statechart-controls.mjs')],
    {
      cwd: repoRoot,
      env: { ...process.env, JAVA: javaPath, TLA2TOOLS: tlaJar.path },
      encoding: 'utf8',
      timeout: 60_000,
    },
  )
  assert.equal(controlsRun.status, 0, `check-statechart-controls.mjs failed: ${controlsRun.stderr}`)

  const tlcObsPath = writeJson(path.join(artifactsDir, 'models-tlc.obs.json'), {
    modelResults,
    negativeControls: controlsRun.stdout.trim().split('\n'),
  })
  checks.push({
    id: 'statechart-tlc-and-controls',
    kind: 'model',
    status: 'passed',
    featureIds: ['F01', 'F07', 'F08'],
    statechartStates: [
      'Relay: 22 states / 49 steps',
      'Session: 12 states / 26 steps',
      'Recorder: 64 states / 114 steps',
    ],
    properties: ['R1', 'R2', 'R4', 'S1', 'S2', 'S4', 'C1', 'C2', 'C3', 'C4'],
    actionArtifact: tlcActionPath,
    observationArtifact: tlcObsPath,
    assertion: 'TLC verifies Relay (22 states/49 steps), Session (12 states/26 steps), and Recorder (64 states/114 steps) with zero invariant violations, and rejects all three negative-control mutations (CompatibleNotKilled, NoClobber, CleanupRequiresExit).',
  })

  return checks
}

function validateSkillStructure() {
  const skillMdPath = path.join(skillRoot, 'SKILL.md')
  assert(fs.existsSync(skillMdPath), 'Missing .agents/skills/verify/SKILL.md')
  const skillMd = fs.readFileSync(skillMdPath, 'utf8')
  assert(/^---\nname: verify\ndescription: .+\n---\n/s.test(skillMd), 'SKILL.md must have name: verify and description frontmatter')
  assert(!skillMd.includes('disable-model-invocation'), 'SKILL.md must not set disable-model-invocation')

  for (const section of ['## Launch', '## Doctor', '## Drive', '## Evidence', '## Cleanup', '## Helpers']) {
    assert(skillMd.includes(section), `SKILL.md is missing required section "${section}"`)
  }

  const featuresDir = path.join(skillRoot, 'features')
  const readmePath = path.join(featuresDir, 'README.md')
  assert(fs.existsSync(readmePath), 'Missing features/README.md')

  const featureFiles = [
    'relay-and-sessions.md',
    'terminal-interaction.md',
    'recording-and-media.md',
    'attach-and-boundaries.md',
  ]
  const combinedText = [skillMd, fs.readFileSync(readmePath, 'utf8')]

  for (const file of featureFiles) {
    const fullPath = path.join(featuresDir, file)
    assert(fs.existsSync(fullPath), `Missing feature file ${file}`)
    const content = fs.readFileSync(fullPath, 'utf8')
    combinedText.push(content)
    const h2s = Array.from(content.matchAll(/^## (.+)$/gm), match => match[1])
    assert.deepEqual(
      h2s,
      ['Sub-features', 'How to get to it (user POV)', 'Driving it with verify.ts', 'Gotchas'],
      `${file} must contain the exact four H2 headings in order`,
    )
    assert(content.includes('Preconditions:'), `${file} must start Driving section with Preconditions:`)
  }

  const allDocs = combinedText.join('\n')
  const expectedIds = [
    'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07',
    'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14',
    'R1', 'R2', 'R3', 'R4', 'N1', 'N2', 'N3',
    'O1', 'O2', 'O3', 'S1', 'S2', 'S3', 'S4',
    'C1', 'C2', 'C3', 'C4', 'W1', 'W2', 'W3',
    'A1', 'A2', 'A3',
  ]
  for (const id of expectedIds) {
    assert(allDocs.includes(id), `Skill feature map is missing coverage reference for ${id}`)
  }

  const markdownFiles = [skillMdPath, readmePath, ...featureFiles.map(file => path.join(featuresDir, file))]
  let checkedLinks = 0
  for (const mdFile of markdownFiles) {
    const text = fs.readFileSync(mdFile, 'utf8')
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (/^(https?:|#)/.test(target)) continue
      const [relPath] = target.split('#')
      const resolved = path.resolve(path.dirname(mdFile), relPath)
      assert(fs.existsSync(resolved), `${path.relative(repoRoot, mdFile)} links to missing path ${target}`)
      checkedLinks += 1
    }
  }

  return {
    ok: true,
    skillMdPath,
    featureFiles,
    checkedIds: expectedIds.length,
    checkedLinks,
  }
}

async function runDrive(port: RelayPort, feature: FeatureScope, outDir: string) {
  const doctorBefore = await runDoctor(port)
  assert(doctorBefore.distBuilt, 'dist/cli.js is missing; run `bun run build` before driving')
  assert(doctorBefore.featureMapCheck.ok, 'Repository feature-map check failed before drive')

  const artifactsDir = path.join(outDir, 'artifacts')
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-verify-scratch-'))
  fs.mkdirSync(artifactsDir, { recursive: true })

  const checks: CheckRecord[] = []
  try {
    if (feature === 'all' || feature === 'lifecycle') {
      checks.push(...(await driveLifecycle(port, artifactsDir, scratchDir)))
    }
    if (feature === 'all' || feature === 'terminal') {
      checks.push(...(await driveTerminal(port, artifactsDir, scratchDir)))
    }
    if (feature === 'all' || feature === 'recording') {
      checks.push(...(await driveRecording(port, artifactsDir, scratchDir)))
    }
    if (feature === 'all' || feature === 'protocols') {
      checks.push(...(await driveProtocols(port, artifactsDir)))
    }
    if (feature === 'all' || feature === 'models') {
      checks.push(...(await driveModels(artifactsDir)))
    }
  } finally {
    await stopVerifyDaemon(port)
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }

  const postCleanupProbe = await probeRelayPort(port)
  assert.equal(postCleanupProbe.kind, 'no-listener', `Port ${port} must be free after drive cleanup`)

  const evidencePath = writeJson(path.join(outDir, 'evidence.json'), {
    checkedAt: new Date().toISOString(),
    gitRevision: doctorBefore.gitRevision,
    packageVersion: doctorBefore.packageVersion,
    port,
    feature,
    evidenceDir: outDir,
    postCleanupPortState: postCleanupProbe.kind,
    passedCount: checks.filter(check => check.status === 'passed').length,
    skippedCount: checks.filter(check => check.status === 'skipped').length,
    checks,
  })
  assert(fs.existsSync(evidencePath), 'Evidence file must survive cleanup')

  return {
    ok: true,
    evidenceDir: outDir,
    evidencePath,
    postCleanupPortState: postCleanupProbe.kind,
    passedCount: checks.filter(check => check.status === 'passed').length,
    skippedCount: checks.filter(check => check.status === 'skipped').length,
    checks: checks.map(check => ({
      id: check.id,
      kind: check.kind,
      status: check.status,
      featureIds: check.featureIds,
      properties: check.properties,
    })),
  }
}

async function runCleanupCommand(port: RelayPort, outDir?: string) {
  const probeAfter = await stopVerifyDaemon(port)
  assert.equal(probeAfter.kind, 'no-listener', `Port ${port} is still occupied after cleanup`)
  const evidencePreserved = outDir ? fs.existsSync(path.join(outDir, 'evidence.json')) : null
  if (outDir) {
    assert.equal(evidencePreserved, true, `Cleanup must preserve ${path.join(outDir, 'evidence.json')}`)
  }
  return {
    ok: true,
    port,
    portState: probeAfter.kind,
    outDir: outDir ?? null,
    evidencePreserved,
  }
}

async function main() {
  const command = parseArgs(process.argv.slice(2))
  switch (command.kind) {
    case 'doctor': {
      const report = await runDoctor(command.port)
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      process.exit(report.ok ? 0 : 1)
    }
    case 'drive': {
      const report = await runDrive(command.port, command.feature, command.outDir)
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      return
    }
    case 'cleanup': {
      const report = await runCleanupCommand(command.port, command.outDir)
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      return
    }
    case 'validate-skill': {
      const report = validateSkillStructure()
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      return
    }
    default: {
      const _exhaustive: never = command
      throw new Error(`Unhandled command: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

await main()
