// Explicit test-only download of public CLI source, without installing its runtime.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CLI_SOURCE, verifyArchive, validateMembers, assertSafeDestination } from './cli-source-policy.mjs'
import { isolatedNpmEnvironment } from './npm-environment.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destination = path.join(root, '.scratch', 'public-cli-source')
await assertSafeDestination(root, destination)
await mkdir(destination, { recursive: true })
await assertSafeDestination(root, destination)
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const npmEnvironment = await isolatedNpmEnvironment()
function run (command, args) {
  const result = spawnSync(command, args, { cwd: destination, env: npmEnvironment, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw Error(result.stderr || 'Public source preparation failed')
  return result.stdout
}
const info = JSON.parse(run(process.execPath, [npm, 'pack', CLI_SOURCE.package, '--registry=' + CLI_SOURCE.registry, '--json', '--ignore-scripts']))[0]
const archive = path.join(destination, path.basename(info.filename))
verifyArchive(await readFile(archive))
const paths = run('tar', ['-tf', archive]).split(/\r?\n/u).filter(Boolean)
const verbose = run('tar', ['-tvf', archive]).split(/\r?\n/u).filter(Boolean)
if (paths.length !== verbose.length) throw Error('public_cli_archive_listing_mismatch')
const members = paths.map((name, index) => ({ name, type: verbose[index].startsWith('-') ? 'file'
  : verbose[index].startsWith('d') ? 'directory' : 'refused-link-or-special' }))
const selected = validateMembers(members)
await assertSafeDestination(root, destination)
run('tar', ['-xf', archive, ...selected])
await assertSafeDestination(root, destination)
const pkg = JSON.parse(await readFile(path.join(destination, 'package/package.json'), 'utf8'))
if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== '0.2.0-rc.2' || pkg.license !== 'MIT') throw Error('Public CLI source identity mismatch')
const files = []
for (const name of selected) {
  const data = await readFile(path.join(destination, name))
  files.push({ path: name, sha256: createHash('sha256').update(data).digest('hex') })
}
await writeFile(path.join(destination, 'source.json'), JSON.stringify({ source: '@deepseek-ai/dsh@0.2.0-rc.2',
  registry: CLI_SOURCE.registry, integrity: CLI_SOURCE.integrity, shasum: info.shasum, files, fullCLIInstalled: false,
  boundary: 'test reads exact published shutdown blocks; not CLI launch/plugin management acceptance' }, null, 2) + '\n')
console.log(JSON.stringify({ source: pkg.name, version: pkg.version, extractedFiles: files.length, fullCLIInstalled: false }))
