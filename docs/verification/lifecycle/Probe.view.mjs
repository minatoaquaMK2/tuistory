export const title = 'A port probe must not become a kill target'
const stages = { http: 'check readiness', probeOutside: 'probe without lock', lock: 'wait for lock',
  recheck: 'recheck readiness', probeInside: 'probe with lock', boundOutside: 'hold probe socket',
  boundInside: 'hold probe socket', kill: 'look up occupied port', signal: 'signal selected caller', spawn: 'start daemon',
  complete: 'return success', done: 'finished' }
export function state(v) {
  if (v.alive.length < 2) return 'A caller was killed'
  if (v.port === 3) return v.completed.length === 2 ? 'Both readiness checks finished' : 'Daemon is ready'
  if (v.port === 1 || v.port === 2) {
    const other = v.port === 1 ? 2 : 1
    return `Caller holds probe socket; peer: ${stages[v.pc[other]]}`
  }
  if (v.lock) return `Lock owner: ${stages[v.pc[v.lock]]}`
  const checked = [v.pc[1], v.pc[2]].filter(stage => stage !== 'http').length
  return ['Both callers check readiness', 'One caller finished its readiness check',
    'Both callers finished their readiness checks'][checked]
}
export const step = (_action, from, to) => {
  if (to.alive.length < from.alive.length) return 'signal the probe owner'
  if (from.port === 0 && to.port === 3) return 'start service'
  if (from.port === 0 && to.port > 0) return 'bind probe socket'
  if (from.port > 0 && to.port === 0) return 'close probe socket'
  if (from.lock === 0 && to.lock > 0) return 'acquire lifecycle lock'
  return 'continue request'
}
