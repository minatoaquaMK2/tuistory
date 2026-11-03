import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const jar = process.env.TLA2TOOLS
assert(jar && fs.existsSync(jar), 'Set TLA2TOOLS to the pinned tla2tools.jar; see docs/verification/lifecycle/README.md')
assert.equal(createHash('sha256').update(fs.readFileSync(jar)).digest('hex'),
  '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88', 'TLC jar differs from the reviewed version')
const source = fileURLToPath(new URL('../docs/verification/lifecycle/', import.meta.url))
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-lifecycle-models-'))
for (const name of fs.readdirSync(source).filter(name => /\.(tla|cfg)$/.test(name))) {
  fs.copyFileSync(path.join(source, name), path.join(output, name))
}
const invariant = name => ({ status: 12, message: `Invariant ${name} is violated` })
const temporal = { status: 13, message: 'Temporal properties were violated' }
const cases = [
  ['TicketLock', 'TicketLock'],
  ['TicketLock', 'TicketLockCompletion'],
  ['LegacyLock', 'LegacyLock', invariant('LiveOwnerKeepsClaim')],
  ['LegacyLock', 'LegacyLockOverlap', invariant('MutualExclusion')],
  ['TicketLock', 'TicketLockNoPostScan', invariant('MutualExclusion')],
  ['TicketLock', 'TicketLockSaturated', invariant('MutualExclusion')],
  ['TicketLock', 'TicketLockWeakListing', invariant('MutualExclusion')],
  ['OsLock', 'OsLock'],
  ['OsLock', 'OsLockCompletion'],
  ['ProbeInterleaving', 'ProbeCurrent', invariant('CallersSurvive')],
  ['ProbeInterleaving', 'ProbeSerialized'],
  ['Escalation', 'EscalationBaseline', invariant('TargetDoesNotExpand')],
  ['Escalation', 'EscalationFixed'],
]
for (const [module, config] of [['ProbeInterleaving', 'ProbeCurrent'], ['Escalation', 'EscalationBaseline']]) {
  const name = `${config}RefinementControl`
  const original = fs.readFileSync(path.join(output, config + '.cfg'), 'utf8')
  fs.writeFileSync(path.join(output, name + '.cfg'), original.replace(/^INVARIANT[^\n]*\n/gm, ''))
  const contract = module === 'ProbeInterleaving' ? 'LifecycleContract' : 'ReplacementContract'
  cases.push([module, name, { status: 13, message: `of module ${contract} is violated.` }])
}
for (const module of ['TicketLock', 'OsLock']) {
  const name = `${module}NoFairnessControl`
  const original = fs.readFileSync(path.join(output, module + 'Completion.cfg'), 'utf8')
  fs.writeFileSync(path.join(output, name + '.cfg'), original.replace('SPECIFICATION FairSpec', 'SPECIFICATION Spec'))
  cases.push([module, name, temporal])
}
const results = []
console.log(`TLC logs and generated controls: ${output}`)
for (const [module, config, expected] of cases) {
  const args = ['-XX:+UseParallelGC', '-Xmx1g', '-cp', path.resolve(jar), 'tlc2.TLC',
    '-workers', '1', '-fp', '0', '-metadir', path.join(output, config + '-states'),
    '-config', config + '.cfg', module + '.tla']
  const result = spawnSync(process.env.JAVA || 'java', args, { cwd: output, encoding: 'utf8', timeout: 55_000 })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  fs.writeFileSync(path.join(output, config + '.log'), log)
  if (result.error) throw result.error
  const counts = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(log)
  const verdict = expected?.message ?? 'Model checking completed. No error has been found.'
  const matched = result.status === (expected?.status ?? 0) && log.includes(verdict) && counts !== null
  const record = { config, expected: expected?.message ?? 'pass', matched, status: result.status,
    generated: counts ? Number(counts[1].replaceAll(',', '')) : null,
    distinct: counts ? Number(counts[2].replaceAll(',', '')) : null,
    command: [process.env.JAVA || 'java', ...args] }
  results.push(record)
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  assert(matched, `${config} did not produce the expected result; inspect ${path.join(output, config + '.log')}`)
  console.log(`${config}: ${expected ? 'expected counterexample' : 'pass'}; ${record.distinct} distinct states`)
}
