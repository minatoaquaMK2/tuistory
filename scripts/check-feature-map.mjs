import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const docs = path.join(root, 'docs/feature-map')
const files = fs.existsSync(docs) ? fs.readdirSync(docs).filter(name => name.endsWith('.md')) : []
assert(files.length > 0, 'Feature map Markdown is missing')
const text = files.map(name => fs.readFileSync(path.join(docs, name), 'utf8')).join('\n')
const cli = fs.readFileSync(path.join(root, 'src/cli.ts'), 'utf8')
const commands = Array.from(cli.matchAll(/\.command\('([^']*)'/g), match => match[1] || '-- <command>')
const session = ts.createSourceFile('session.ts', fs.readFileSync(path.join(root, 'src/session.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const sessionClass = session.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'Session')
assert(sessionClass, 'Session declaration is missing')
const members = sessionClass.members.filter(node =>
  !ts.isConstructorDeclaration(node) && node.name &&
  !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword),
).map(node => `Session.${node.name.getText(session)}`)
const index = ts.createSourceFile('index.ts', fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const exports = new Set()
for (const node of index.statements) {
  if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const entry of node.exportClause.elements) exports.add(entry.name.text)
  } else if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && node.name) {
    exports.add(node.name.getText(index))
  }
}
const missing = [...commands, ...members, ...exports].filter(name => !text.includes(`\`${name}\``))
assert.deepEqual(missing, [], 'Public entries missing from the feature map')
let links = 0
for (const name of files) {
  const document = fs.readFileSync(path.join(docs, name), 'utf8')
  for (const match of document.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(https?:|#)/.test(match[1])) continue
    const [target, anchor] = match[1].split('#')
    const resolved = path.resolve(docs, target)
    assert(fs.existsSync(resolved), `${name} links to missing ${target}`)
    if (anchor?.startsWith('L')) {
      const line = Number(anchor.slice(1))
      assert(Number.isInteger(line) && line > 0 && line <= fs.readFileSync(resolved, 'utf8').split('\n').length, `${name} has an invalid line anchor ${match[1]}`)
    }
    links++
  }
}
console.log(`Feature map covers ${commands.length} CLI registrations, ${members.length} public Session members, and ${exports.size} root exports. Checked ${links} local links.`)
console.log('This checks inventory mentions and link targets. It does not prove descriptions, line meanings, test execution, or implementation correctness.')
