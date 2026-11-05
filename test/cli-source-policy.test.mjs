import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { validateMembers, verifyArchive, assertSafeDestination } from '../scripts/cli-source-policy.mjs'
import { mkdtemp, mkdir, symlink, unlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const safe = [{ name: 'package/package.json', type: 'file' }, { name: 'package/lib/profile-boot-synthetic.js', type: 'file' }]
test('public CLI archive policy accepts only unique expected plain files', () => {
  assert.equal(validateMembers(safe).length, 2)
})
for (const member of [
  { name: '/absolute', type: 'file' }, { name: 'package/../outside', type: 'file' },
  { name: 'C:/outside', type: 'file' }, { name: 'package/link', type: 'symlink' },
  { name: 'package/hard', type: 'hardlink' }, { name: 'package/lib/profile-boot-other.js', type: 'file' }
]) test('public CLI archive refuses unsafe path/link/ambiguous source: ' + member.type + '/' + member.name.split('/').at(-1), () => {
  assert.throws(() => validateMembers([...safe, member]))
})
test('public CLI archive verifies bytes before extraction; changed byte refuses', () => {
  const data = Buffer.from('synthetic-public-archive'), expected = 'sha512-' + createHash('sha512').update(data).digest('base64')
  assert.doesNotThrow(() => verifyArchive(data, expected))
  assert.throws(() => verifyArchive(Buffer.from('changed'), expected), /integrity_mismatch/)
})
test('public CLI preparation rejects pre-existing destination or nested directory links before writing', async () => {
  const parent = await realpath(tmpdir()), root = await mkdtemp(path.join(parent, 'echo-cli-policy-'))
  const outside = path.join(root, 'synthetic-outside'), scratch = path.join(root, '.scratch')
  await mkdir(outside); await mkdir(scratch)
  const link = path.join(scratch, 'public-cli-source')
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(assertSafeDestination(root, link), /link_refused/)
    await unlink(link); await mkdir(link); await mkdir(path.join(link, 'package'))
    await symlink(outside, path.join(link, 'package/lib'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(assertSafeDestination(root, link), /link_refused/)
    await unlink(path.join(link, 'package/lib'))
  } finally {
    const actual = await realpath(root)
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('echo-cli-policy-'))
    await rm(actual, { recursive: true, force: true })
  }
})
