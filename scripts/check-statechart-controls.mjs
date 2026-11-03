import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

assert(process.env.TLA2TOOLS, 'Set TLA2TOOLS to the pinned tla2tools.jar path')
const source = fileURLToPath(new URL('../docs/feature-map/models/', import.meta.url))
const controls = [
  { name: 'Relay', before: 'port \\in {"older", "wedged"}', after: 'port \\in {"older", "wedged", "compatible"}', rule: 'CompatibleNotKilled' },
  { name: 'Recorder', before: 'target = "absent" /\\ target\' = "owned"', after: 'target \\in {"absent", "foreign"} /\\ target\' = "owned"', rule: 'NoClobber' },
  { name: 'Session', before: 'cleaned\' = (process = "exited")', after: 'cleaned\' = TRUE', rule: 'CleanupRequiresExit' },
]
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tuistory-model-controls-'))
try {
  for (const control of controls) {
    const spec = fs.readFileSync(path.join(source, `${control.name}.tla`), 'utf8')
    assert(spec.includes(control.before), `${control.name} mutation target has drifted`)
    fs.writeFileSync(path.join(scratch, `${control.name}.tla`), spec.replaceAll(control.before, control.after))
    fs.copyFileSync(path.join(source, `${control.name}.cfg`), path.join(scratch, `${control.name}.cfg`))
    const result = spawnSync(process.env.JAVA || 'java', ['-XX:+UseParallelGC', '-cp', process.env.TLA2TOOLS,
      'tlc2.TLC', '-workers', '1', '-fp', '0', '-config', `${control.name}.cfg`, `${control.name}.tla`],
    { cwd: scratch, encoding: 'utf8', timeout: 60_000 })
    if (result.error) throw result.error
    const output = result.stdout + result.stderr
    assert(result.status !== 0 && output.includes(`Invariant ${control.rule} is violated`), `${control.name} did not report the expected violation:\n${output}`)
    console.log(`${control.name}: rejected mutation with ${control.rule}`)
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
