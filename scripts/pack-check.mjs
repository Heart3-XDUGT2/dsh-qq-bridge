import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isolatedNpmEnvironment } from './npm-environment.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destination = path.join(root, '.scratch', 'packages')
await mkdir(destination, { recursive: true })
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const npmEnvironment = await isolatedNpmEnvironment()
const results = []
for (const relative of ['.', 'official']) {
  const cwd = path.resolve(root, relative)
  const packed = spawnSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd, env: npmEnvironment, encoding: 'utf8', windowsHide: true
  })
  if (packed.status !== 0) throw Error(packed.stderr || 'pack failed')
  const meta = JSON.parse(packed.stdout)[0]
  const names = new Set(meta.files.map(file => file.path))
  for (const required of ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY.md', 'cordis.patch.yml', 'lib/index.js', 'scripts/install.mjs']) {
    if (!names.has(required)) throw Error('Missing packed file: ' + required)
  }
  for (const name of names) {
    if (/(?:^|\/)(?:node_modules|\.scratch|\.git|test|tests|credentials|state)\//u.test(name) || /\.(?:db|log|tap|bak)$/u.test(name)) throw Error('Private/test artifact in pack: ' + name)
  }
  const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'))
  if (pkg.license !== 'MIT') throw Error('License mismatch')
  results.push({ package: pkg.name, version: pkg.version, filename: meta.filename, shasum: meta.shasum, integrity: meta.integrity, files: [...names] })
}
await writeFile(path.join(destination, 'pack-check.json'), JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results.map(result => ({ package: result.package, filename: result.filename, files: result.files.length })), null, 2))
