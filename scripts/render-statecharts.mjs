import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({ options: { tools: { type: 'string' } }, allowPositionals: true })
assert(values.tools && positionals.length > 0, 'Usage: bun scripts/render-statecharts.mjs --tools <external package directory> <chart.mmd> ...')
const require = createRequire(path.join(path.resolve(values.tools), 'package.json'))
const { render } = await import(pathToFileURL(require.resolve('pele')).href)
const css = `<style>
.pele { --pele-bg:#ffffff; --pele-fg:#1c1c1c; --pele-muted:#656565; --pele-line:#808080; --pele-surface:#fcfcfc; --pele-surface-alt:#f1f1f1; --pele-border:#c9c9c9; }
.pele .blue rect { fill:#c3e0ff; }
.pele .teal rect { fill:#bfe3df; }
.pele .orange rect { fill:#f0d3bf; }
.pele .purple rect { fill:#e3d5ff; }
.pele .breaks rect { fill:#ffecee !important; stroke:#e72e3b !important; stroke-width:2.5px !important; }
.pele .breaks text { fill:#cd2834 !important; }
.pele .mayBreak rect { fill:#fff3e6 !important; stroke:#e8730c !important; stroke-width:2.5px !important; }
.pele .mayBreak text { fill:#b85a06 !important; }
.pele .bugPath rect { stroke:#1680f3 !important; stroke-width:2.5px !important; }
.pele .repeats rect { stroke:#9b35d6 !important; stroke-width:2.5px !important; stroke-dasharray:6 3; }
</style>`
for (const input of positionals) {
  assert(input.endsWith('.mmd'), `Expected a Mermaid source file: ${input}`)
  const { svg, width, height } = render(fs.readFileSync(input, 'utf8'), {
    limit: 1_000_000,
    outputLimit: 8_000_000,
    maxEdges: 10_000,
  })
  const output = input.slice(0, -4) + '.svg'
  const background = `<rect width="${width}" height="${height}" fill="#ffffff" aria-hidden="true"/>`
  fs.writeFileSync(output, svg.replace(/(<svg\b[^>]*>)/, `$1${css}${background}`))
  console.log(`${output}: ${width} x ${height}`)
}
