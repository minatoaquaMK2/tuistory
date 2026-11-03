import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

type Contender = { id: string; pid: number; directory: string }
type ContenderState =
  | { kind: 'retired' }
  | { kind: 'choosing' }
  | { kind: 'ticket'; number: bigint }

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function contenders(directory: string): Contender[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const match = /^([1-9][0-9]*)-[a-f0-9]{32}$/.exec(entry.name)
    if (!entry.isDirectory() || !match) return []
    const pid = Number(match[1])
    return Number.isSafeInteger(pid)
      ? [{ id: entry.name, pid, directory: path.join(directory, entry.name) }]
      : []
  })
}

function observe(contender: Contender): ContenderState {
  try {
    process.kill(contender.pid, 0)
  } catch (error) {
    // Permission errors and ambiguous PID reuse must never evict a live owner.
    if (hasCode(error, 'ESRCH')) {
      fs.rmSync(contender.directory, { recursive: true, force: true })
      return { kind: 'retired' }
    }
  }

  let ticket: string
  try {
    ticket = fs.readFileSync(path.join(contender.directory, 'ticket'), 'utf8')
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    try {
      fs.statSync(contender.directory)
      return { kind: 'choosing' }
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return { kind: 'retired' }
      throw error
    }
  }
  if (!/^[1-9][0-9]*$/.test(ticket)) {
    throw new Error(`Invalid relay lifecycle ticket in ${contender.directory}`)
  }
  return { kind: 'ticket', number: BigInt(ticket) }
}

export async function withRelayLifecycleLock<T>(
  { directory, timeoutMs = 15000 }: { directory: string; timeoutMs?: number },
  action: () => Promise<T>,
): Promise<T> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const id = `${process.pid}-${randomBytes(16).toString('hex')}`
  const ownDirectory = path.join(directory, id)
  const deadline = Date.now() + timeoutMs
  fs.mkdirSync(ownDirectory, { mode: 0o700 })

  try {
    let number = 1n
    for (const contender of contenders(directory)) {
      if (contender.id === id) continue
      const state = observe(contender)
      if (state.kind === 'ticket' && state.number >= number) number = state.number + 1n
    }
    fs.writeFileSync(path.join(ownDirectory, 'ticket.tmp'), String(number), { flag: 'wx' })
    fs.renameSync(path.join(ownDirectory, 'ticket.tmp'), path.join(ownDirectory, 'ticket'))

    while (true) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for relay lifecycle lock')
      const blocked = contenders(directory).some(contender => {
        if (contender.id === id) return false
        const state = observe(contender)
        return state.kind === 'choosing' || (state.kind === 'ticket' && (
          state.number < number || (state.number === number && contender.id < id)
        ))
      })
      if (!blocked) return await action()
      await sleep(25)
    }
  } finally {
    fs.rmSync(ownDirectory, { recursive: true, force: true })
  }
}
