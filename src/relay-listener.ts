import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type ProcessId = number & { readonly __brand: 'ProcessId' }
type RelayAddress = '127.0.0.1' | '0.0.0.0'
type RelayListener = { pid: ProcessId; address: RelayAddress }

function isProcessId(value: number): value is ProcessId {
  return Number.isSafeInteger(value) && value > 0
}

function parseProcessId(value: string): ProcessId | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined
  const pid = Number(value)
  return isProcessId(pid) ? pid : undefined
}

function parseAddress(value: string, port: number): RelayAddress | undefined {
  if (value === `127.0.0.1:${port}`) return '127.0.0.1'
  if (value === `0.0.0.0:${port}` || value === `*:${port}`) return '0.0.0.0'
  return undefined
}

export function parseLsofListeners(output: string, port: number): RelayListener[] {
  const listeners: RelayListener[] = []
  let pid: ProcessId | undefined
  for (const record of output.split('\n')) {
    const fields = record.split('\0')
    const first = fields[0]
    if (first?.startsWith('p')) {
      pid = parseProcessId(first.slice(1))
      continue
    }
    if (!pid || !first?.startsWith('f') || !fields.includes('tIPv4')) continue
    const name = fields.find(field => field.startsWith('n'))
    const address = name && parseAddress(name.slice(1), port)
    if (address) listeners.push({ pid, address })
  }
  return listeners
}

export function parseNetstatListeners(output: string, port: number): RelayListener[] {
  const listeners: RelayListener[] = []
  for (const line of output.split('\n')) {
    const [protocol, local, , state, rawPid, ...extra] = line.trim().split(/\s+/)
    if (protocol !== 'TCP' || state !== 'LISTENING' || !rawPid || extra.length) continue
    const address = parseAddress(local, port)
    const pid = parseProcessId(rawPid)
    if (address && pid) listeners.push({ pid, address })
  }
  return listeners
}

export function parseProcListeners(output: string, port: number): Map<string, RelayAddress> {
  const sockets = new Map<string, RelayAddress>()
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const [hexAddress, hexPort] = (fields[1] ?? '').split(':')
    const inode = fields[9]
    if (fields[3] !== '0A' || !/^[0-9A-F]{4}$/.test(hexPort ?? '') || Number.parseInt(hexPort, 16) !== port) continue
    if (!inode || !/^[1-9]\d*$/.test(inode)) continue
    if (hexAddress === '0100007F') sockets.set(inode, '127.0.0.1')
    if (hexAddress === '00000000') sockets.set(inode, '0.0.0.0')
  }
  return sockets
}

async function findLinuxListeners(port: number): Promise<RelayListener[]> {
  const sockets = parseProcListeners(await fs.readFile('/proc/net/tcp', 'utf8'), port)
  if (!sockets.size) return []
  const listeners: RelayListener[] = []
  for (const entry of await fs.readdir('/proc')) {
    const pid = parseProcessId(entry)
    if (!pid) continue
    const fdDirectory = `/proc/${entry}/fd`
    const descriptors = await fs.readdir(fdDirectory).catch(() => [])
    for (const descriptor of descriptors) {
      const target = await fs.readlink(`${fdDirectory}/${descriptor}`).catch(() => '')
      const inode = /^socket:\[([1-9]\d*)\]$/.exec(target)?.[1]
      const address = inode && sockets.get(inode)
      if (address) {
        listeners.push({ pid, address })
        break
      }
    }
  }
  return listeners
}

export async function findRelayListeners(port: number): Promise<RelayListener[]> {
  if (process.platform === 'linux') return findLinuxListeners(port)
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'netstat.exe')
    const { stdout } = await execFileAsync(executable, ['-ano', '-p', 'tcp'], { timeout: 2000 })
    return parseNetstatListeners(stdout, port)
  }
  const executable = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof'
  const { stdout } = await execFileAsync(executable, ['-nP', '-a', `-i4TCP:${port}`, '-sTCP:LISTEN', '-F0pftn'], { timeout: 2000 })
  return parseLsofListeners(stdout, port)
}
