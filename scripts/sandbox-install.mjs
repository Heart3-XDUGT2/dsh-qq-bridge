import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parent = path.join(root, '.scratch', 'install-tests')
await mkdir(parent, { recursive: true })
const home = await mkdtemp(path.join(tmpdir(), 'echo-qq-synthetic-home-'))
const profile = path.join(home, 'profiles', 'web')
await mkdir(path.join(profile, 'node_modules'), { recursive: true })
const manifest = path.join(profile, 'package.json')
await writeFile(manifest, JSON.stringify({ private: true, dependencies: { sentinel: 'link:synthetic' },
  dsh: { profile: { bundles: ['sentinel'] } } }, null, 2) + '\n')
const runs = []
for (const relative of ['.', 'official']) {
  const script = path.resolve(root, relative, 'scripts/install.mjs')
  const name = JSON.parse(await readFile(path.resolve(root, relative, 'package.json'), 'utf8')).name
  const oldSlot = path.resolve(profile, 'node_modules', name)
  if (!oldSlot.startsWith(path.resolve(home) + path.sep)) throw Error('Unsafe synthetic upgrade target')
  await mkdir(oldSlot, { recursive: true })
  await writeFile(path.join(oldSlot, 'package.json'), JSON.stringify({ name, version: '0.0.0-synthetic-old' }))
  for (const args of [[], ['--check'], [], ['--check'], ['--doctor'], ['--remove']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, DSH_HOME: home }, windowsHide: true, encoding: 'utf8'
    })
    runs.push({ package: name, args, exit: result.status })
    if (result.status !== 0) throw Error('Synthetic install failed: ' + result.stdout + result.stderr)
  }
  const after = JSON.parse(await readFile(manifest, 'utf8'))
  if (after.dsh.profile.bundles.includes(name) || after.dependencies[name]) throw Error('Uninstall left registration')
  if (!after.dsh.profile.bundles.includes('sentinel') || after.dependencies.sentinel !== 'link:synthetic') throw Error('Other registration changed')
}
await writeFile(path.join(parent, 'sandbox-result.json'), JSON.stringify({ home, runs, liveHomeTouched: false,
  boundary: 'installer registration/link/reinstall/remove only; no DSH process or account started' }, null, 2) + '\n')
console.log(JSON.stringify({ runs: runs.length, failed: runs.filter(run => run.exit !== 0).length, unrelatedRegistrationPreserved: true }))
