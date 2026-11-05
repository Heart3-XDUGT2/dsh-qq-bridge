import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] ?? 'unit'
if (!['unit', 'integration', 'all', 'official-unit', 'official-integration'].includes(mode)) throw Error('Unknown test scope')
const localOfficial = new Set(['delivery.test.mjs', 'ledger.test.mjs', 'transport.test.mjs', 'plugin.test.mjs',
  'inbound-recovery.test.mjs', 'echo028-gateway.test.mjs'])
const matrix = { unit: [], integration: [] }
for (const filename of (await readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort()) {
  const text = await readFile(path.join(root, 'test', filename), 'utf8')
  matrix[text.includes('../../dsh-memory-agent/') ? 'integration' : 'unit'].push('test/' + filename)
}
for (const filename of (await readdir(path.join(root, 'official/tests'))).filter(name => name.endsWith('.test.mjs')).sort()) {
  matrix[localOfficial.has(filename) ? 'unit' : 'integration'].push('official/tests/' + filename)
}
let selected = mode === 'all' ? [...matrix.unit, ...matrix.integration] : matrix[mode.includes('integration') ? 'integration' : 'unit']
if (mode.startsWith('official-')) selected = selected.filter(file => file.startsWith('official/'))
if (mode === 'all' || mode.includes('integration')) {
  const pkg = JSON.parse(await readFile(path.resolve(root, '../dsh-memory-agent/package.json'), 'utf8').catch(() => {
    throw Error('Cross-repository tests require sibling checkout ../dsh-memory-agent; see docs/TESTING.md. No tests were skipped.')
  }))
  if (pkg.name !== 'dsh-echo') throw Error('Unexpected memory checkout package identity')
}
const evidence = path.join(root, '.scratch', 'test-runs')
await mkdir(evidence, { recursive: true })
const label = mode + '-' + Date.now()
await writeFile(path.join(evidence, label + '-selection.json'), JSON.stringify({ mode, matrix, selected, node: process.version }, null, 2) + '\n')
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
  '--import', './official/tests/echo025-preload.mjs', ...selected], {
  cwd: root, env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
})
const output = []
child.stdout.on('data', bytes => { output.push(bytes); process.stdout.write(bytes) })
child.stderr.on('data', bytes => { output.push(bytes); process.stderr.write(bytes) })
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
await writeFile(path.join(evidence, label + '.tap'), Buffer.concat(output))
process.exitCode = exit ?? 1
