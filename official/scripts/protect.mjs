import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const baselinePath = resolve(root, 'docs/echo-executor-018-baseline.json')
const sha = b => createHash('sha256').update(b).digest('hex')
const paths = []
function walk (rel) {
  const abs = resolve(root, rel)
  if (!existsSync(abs)) return
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isSymbolicLink() || e.name === 'node_modules' || e.name === '.git') continue
    const p = relative(root, resolve(abs, e.name)).replaceAll('\\', '/')
    if (p.startsWith('docs/echo-executor-018-') || p === 'docs/plan-echo-official-c2c.md') continue
    if (e.isDirectory()) walk(p)
    else if (p !== 'docs/agent-handoff.md') paths.push(p)
  }
}
if (process.argv[2] === 'capture') {
  if (existsSync(baselinePath)) throw Error('baseline_exists')
  for (const base of ['dsh-echo/lib', 'dsh-echo/web', 'dsh-echo/tests', 'dsh-echo/scripts', 'dsh-echo/docs', 'dsh-echo-qq/lib', 'dsh-echo-qq/web', 'dsh-echo-qq/test', 'dsh-echo-qq/scripts', 'dsh-echo-qq/docs', 'docs']) walk(base)
  for (const p of ['AGENTS.md', 'dsh-echo/package.json', 'dsh-echo-qq/package.json']) if (existsSync(resolve(root, p))) paths.push(p)
  const handoff = readFileSync(resolve(root, 'docs/agent-handoff.md'))
  const files = [...new Set(paths)].sort().map(path => ({ path, sha256: sha(readFileSync(resolve(root, path))) }))
  writeFileSync(baselinePath, JSON.stringify({ capturedAt: new Date().toISOString(), files, handoff: { bytes: handoff.length, sha256: sha(handoff) } }, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ captured: files.length }))
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const changed = baseline.files.filter(f => !existsSync(resolve(root, f.path)) || sha(readFileSync(resolve(root, f.path))) !== f.sha256).map(f => f.path)
  const handoff = readFileSync(resolve(root, 'docs/agent-handoff.md'))
  const handoffSuffix = handoff.length >= baseline.handoff.bytes && sha(handoff.subarray(handoff.length - baseline.handoff.bytes)) === baseline.handoff.sha256
  console.log(JSON.stringify({ protectedFiles: baseline.files.length, changed, handoffSuffix }))
  if (changed.length || !handoffSuffix) process.exitCode = 1
}
