import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, symlink, unlink, realpath, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyInstallBoundary } from '../scripts/install-boundary.mjs'
import { isolatedNpmEnvironment } from '../scripts/npm-environment.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const [installer, name] of [['scripts/install.mjs', 'dsh-echo-qq'], ['official/scripts/install.mjs', 'dsh-echo-qq-official']]) {
  for (const args of [['--remove'], []]) {
    test('installer refuses ancestor junction before writes: ' + name + '/' + (args[0] || 'install'), async () => {
      const parent = await realpath(tmpdir()), base = await mkdtemp(path.join(parent, 'echo-install-boundary-'))
      const home = path.join(base, 'home'), profile = path.join(home, 'profiles/web'), outside = path.join(base, 'outside')
      await mkdir(profile, { recursive: true }); await mkdir(path.join(outside, name), { recursive: true })
      const manifest = path.join(profile, 'package.json'), sentinel = path.join(outside, name, 'sentinel.txt')
      await writeFile(manifest, JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } })); await writeFile(sentinel, 'synthetic unchanged')
      const before = await readFile(manifest)
      const link = path.join(profile, 'node_modules')
      try {
        await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
        const child = spawnSync(process.execPath, [path.join(root, installer), ...args], { env: { ...process.env, DSH_HOME: home }, windowsHide: true, encoding: 'utf8' })
        assert.notEqual(child.status, 0)
        assert.equal(await readFile(sentinel, 'utf8'), 'synthetic unchanged'); assert.deepEqual(await readFile(manifest), before)
      } finally {
        await unlink(link)
        const resolved = await realpath(base); assert.equal(path.dirname(resolved), parent)
        await rm(resolved, { recursive: true, force: true })
      }
    })
  }
}
test('installer boundary rejects source and destination containment', async () => {
  const parent = await realpath(tmpdir()), home = await mkdtemp(path.join(parent, 'echo-overlap-'))
  try {
    await mkdir(path.join(home, 'profiles/web/node_modules'), { recursive: true })
    await assert.rejects(verifyInstallBoundary({ home, profile: 'web', name: 'synthetic', source: home }), /overlap/)
  } finally {
    assert.equal(path.dirname(await realpath(home)), parent); await rm(home, { recursive: true, force: true })
  }
})
test('npm child environment strips mixed-case inherited settings and uses empty private configs', async () => {
  const env = await isolatedNpmEnvironment({ PATH: 'synthetic-path', NPM_CONFIG_USERCONFIG: 'forbidden-user',
    NPM_CONFIG_GLOBALCONFIG: 'forbidden-global', npm_config_cache: 'forbidden-cache', NpM_CoNfIg_ReGiStRy: 'forbidden',
    NODE_OPTIONS: 'forbidden', NODE_PATH: 'forbidden', ECHO_DB: 'forbidden' })
  assert.equal(env.PATH, 'synthetic-path')
  assert.equal(env.NPM_CONFIG_USERCONFIG, undefined); assert.equal(env.NPM_CONFIG_GLOBALCONFIG, undefined)
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.NODE_PATH, undefined); assert.equal(env.ECHO_DB, undefined)
  assert.equal(await readFile(env.npm_config_userconfig, 'utf8'), '')
  assert.equal(await readFile(env.npm_config_globalconfig, 'utf8'), '')
  assert.ok(!Object.values(env).some(value => value.includes('forbidden')))
})
