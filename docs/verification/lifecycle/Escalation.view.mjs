export const title = 'One stop operation must keep its original targets'
export function state(v) {
  if (v.victims.includes('successor')) return 'Successor was killed'
  const listener = { old: 'old daemon', free: 'free port', successor: 'healthy successor' }[v.port]
  const phase = { term: 'before TERM', wait: 'waiting for exit', discover: 'look up escalation target',
    kill: `selected ${v.selected}`, done: 'operation ended' }[v.phase]
  return `${listener}; ${phase}${v.sessions.includes('successor') ? '; session alive' : ''}`
}
export const step = action => ({ SendTerm: 'send TERM to old daemon', OldExit: 'old daemon exits',
  SuccessorBinds: 'pending successor binds', LaunchSession: 'user starts session',
  WaitEnds: 'grace interval ends', Discover: 'enumerate listener',
  SendKill: 'apply escalation policy', Done: 'finished' }[action] ?? action)
