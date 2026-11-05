import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(plugin, '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const files = []
function walk (dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, e.name)
    if (e.isSymbolicLink()) throw Error('unexpected_symlink')
    if (e.isDirectory()) walk(path)
    else files.push(path)
  }
}
walk(plugin)
for (const p of ['docs/plan-echo-official-c2c.md', 'docs/echo-executor-018-baseline.json', 'docs/echo-executor-018-result.md', 'docs/echo-executor-018-tests.tap']) if (existsSync(resolve(root, p))) files.push(resolve(root, p))
const invalidEncoding = [], syntaxFailures = [], fingerprints = []
let syntaxFiles = 0
for (const path of files.sort()) {
  const bytes = readFileSync(path)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if ((bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) || text.includes('\uFFFD')) invalidEncoding.push(relative(root, path))
  } catch { invalidEncoding.push(relative(root, path)) }
  if (/\.(?:js|mjs)$/.test(path)) {
    syntaxFiles++
    const r = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (r.status !== 0) syntaxFailures.push(relative(root, path))
  }
  fingerprints.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: sha(bytes), bytes: bytes.length })
}
const protectedRun = spawnSync(process.execPath, [resolve(plugin, 'scripts/protect.mjs'), 'check'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
const protection = JSON.parse(protectedRun.stdout)
const manifest = JSON.parse(readFileSync(resolve(plugin, 'package.json'), 'utf8'))
const patch = readFileSync(resolve(plugin, 'cordis.patch.yml'), 'utf8')
const disabledPatch = /enabled:\s*false/.test(patch)
const noRuntimeDependency = !manifest.dependencies && !manifest.devDependencies
const evidencePath = resolve(root, 'docs/echo-executor-018-evidence.json')
const passed = !invalidEncoding.length && !syntaxFailures.length && protectedRun.status === 0 && disabledPatch && noRuntimeDependency
const result = { date: '2026-10-29', passed, files: files.length, syntaxFiles, invalidEncoding, syntaxFailures, protection, disabledPatch, noRuntimeDependency, fingerprints }
if (process.argv.includes('--record')) {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  evidence.verification = result
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
}
console.log(JSON.stringify({ ...result, fingerprints: undefined }))
if (!passed) process.exitCode = 1
