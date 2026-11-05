import { actor, temporary, scope } from './echo031-fixture.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, toNamespacedPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as codec from '../../../dsh-memory-agent/lib/official-c2c-codec.js'
import { openManagedMvpJournal } from '../lib/managed-journal.js'
import { openMvpJournal } from '../lib/mvp-journal.js'

const records = [], sha = bytes => createHash('sha256').update(bytes).digest('hex')
after(() => {
  const label = process.env.ECHO031_LABEL ?? 'manual-' + Date.now() + '-' + process.pid
  writeFileSync(new URL('../../.scratch/test-traces/echo-executor-031-managed-' + label + '.json', import.meta.url),
    JSON.stringify({ task: 'ECHO-031', platform: process.platform, records }, null, 2) + '\n', { flag: 'wx' })
})
test('031 real Windows active writer excludes case/dot/namespace aliases and normal close releases ownership', async t => {
  assert.equal(process.platform, 'win32')
  const root = temporary(t), dir = join(root, 'Journal'), a = actor(t, dir)
  assert.equal((await a.result()).event, 'ready')
  for (const variant of [dir, dir.toUpperCase(), join(dir, '..', 'Journal'), dir + '\\', toNamespacedPath(dir)]) {
    const b = actor(t, variant), result = await b.result()
    assert.equal(result.event, 'rejected'); assert.equal(result.code, 'storage_busy'); await b.exit()
  }
  await a.stop()
  const c = actor(t, dir); assert.equal((await c.result()).event, 'ready'); await c.stop()
  assert.equal(existsSync(join(dir, '.writer-lock')), false)
  records.push({ kind: 'active-writer-aliases', variants: 5, normalCloseReleased: true })
})
test('031 fresh creation handoff cannot invert ownership order or produce zero successful writers', async t => {
  const dir = join(temporary(t), 'journal'), a = actor(t, dir, 'fresh-handoff')
  await a.created()
  const b = actor(t, dir), blocked = await b.result()
  assert.equal(blocked.event, 'rejected'); assert.equal(blocked.code, 'storage_busy'); await b.exit()
  a.continue(); assert.equal((await a.result()).event, 'ready'); await a.stop()
  records.push({ kind: 'fresh-existing-handoff', winners: 1 })
})
test('031 forced managed writer recovery archives exact old bytes; two recoverers have one winner', async t => {
  const dir = join(temporary(t), 'journal'), first = actor(t, dir, 'seed-confirmed')
  await first.result()
  const oldLock = readFileSync(join(dir, '.writer-lock')), oldLog = readFileSync(join(dir, 'owner-text.json'))
  await first.force()
  const racers = [actor(t, dir), actor(t, dir)], results = await Promise.all(racers.map(a => a.result()))
  assert.equal(results.filter(r => r.event === 'ready').length, 1)
  assert.equal(results.filter(r => r.code === 'storage_busy').length, 1)
  const winner = results.findIndex(r => r.event === 'ready')
  assert.equal(results[winner].recovered, true); assert.deepEqual(results[winner].states, ['confirmed'])
  const archives = readdirSync(dir).filter(p => p.startsWith('recovery-'))
  assert.equal(archives.length, 1)
  assert.deepEqual(readFileSync(join(dir, archives[0], 'writer-lock.json')), oldLock)
  assert.deepEqual(readFileSync(join(dir, archives[0], 'owner-text.json')), oldLog)
  assert.equal(JSON.parse(readFileSync(join(dir, archives[0], 'manifest.json'))).complete, true)
  await racers[winner].stop(); await racers[1 - winner].exit()
  records.push({ kind: 'forced-and-racing-recovery', winners: 1, lockBackupMatches: true, journalBackupMatches: true })
})
for (const [seed, state] of [['sending', 'unknown'], ['unknown', 'unknown'], ['draft', 'abandoned']]) {
  test('031 ' + seed + ' remains non-replayable after a real forced child exit', async t => {
    const dir = join(temporary(t), 'journal'), a = actor(t, dir, 'seed-' + seed)
    await a.result(); await a.force()
    const b = actor(t, dir), result = await b.result()
    assert.equal(result.recovered, true); assert.deepEqual(result.states, [state]); assert.equal(result.pendingClaimCleared, true)
    assert.deepEqual(result.attempts, [seed === 'draft' ? 0 : 1])
    await b.stop()
    records.push({ kind: 'no-replay', seed, recoveredState: state })
  })
}
test('031 legacy empty lock is never inferred stale from a free new primitive', async t => {
  const dir = join(temporary(t), 'journal'), old = openMvpJournal(dir, scope)
  const bytes = readFileSync(join(dir, 'owner-text.json'))
  await assert.rejects(openManagedMvpJournal(dir, scope), e => e.code === 'storage_legacy')
  assert.equal(readFileSync(join(dir, '.writer-lock')).length, 0)
  assert.deepEqual(readFileSync(join(dir, 'owner-text.json')), bytes)
  old.close({ drained: true })
})
test('031 UNC/namespace UNC/device paths reject before any probe or file mutation', async () => {
  let probes = 0
  for (const path of ['\\\\server.invalid\\share\\journal', '\\\\?\\UNC\\server.invalid\\share\\journal', '\\\\?\\GLOBALROOT\\Device\\journal', '\\\\.\\pipe\\not-a-directory']) {
    await assert.rejects(openManagedMvpJournal(path, scope, { systemProbe: async () => { probes++; return {} } }), e => e.code === 'storage_unsupported')
  }
  assert.equal(probes, 0)
})
test('031 pending/corrupt/foreign-host/unknown locks and mismatched identity keep originals', async t => {
  for (const mode of ['pending', 'pending-dangling', 'corrupt', 'foreign-host', 'unknown-lock', 'wrong-scope', 'oversize']) {
    const dir = join(temporary(t), 'journal'), a = actor(t, dir)
    await a.result(); await a.force()
    if (mode === 'pending') writeFileSync(join(dir, 'owner-text.pending'), '{}')
    if (mode === 'pending-dangling') {
      symlinkSync(join(dir, '..', 'missing-target'), join(dir, 'owner-text.pending'), 'junction')
      assert.equal(existsSync(join(dir, 'owner-text.pending')), false)
    }
    if (mode === 'corrupt') writeFileSync(join(dir, 'owner-text.json'), '{bad')
    if (mode === 'oversize') writeFileSync(join(dir, 'owner-text.json'), readFileSync(join(dir, 'owner-text.json'), 'utf8') + ' '.repeat(1024))
    if (mode === 'foreign-host') { const r = JSON.parse(readFileSync(join(dir, '.writer-lock'))); r.hostKey = '0'.repeat(64); writeFileSync(join(dir, '.writer-lock'), JSON.stringify(r)) }
    if (mode === 'unknown-lock') writeFileSync(join(dir, '.writer-lock'), '{"protocol":"unknown"}')
    const lock = readFileSync(join(dir, '.writer-lock')), log = readFileSync(join(dir, 'owner-text.json'))
    await assert.rejects(openManagedMvpJournal(dir, mode === 'wrong-scope' ? { ...scope, appId: 'other' } : scope, mode === 'oversize' ? { maxBytes: 512 } : {}))
    assert.deepEqual(readFileSync(join(dir, '.writer-lock')), lock)
    assert.deepEqual(readFileSync(join(dir, 'owner-text.json')), log)
    assert.equal(readdirSync(dir).filter(p => p.startsWith('recovery-')).length, 0)
    if (mode === 'pending-dangling') assert.equal(lstatSync(join(dir, 'owner-text.pending')).isSymbolicLink(), true)
  }
})
test('031 synchronous init and persist also reject dangling pending directory entries without deleting them', t => {
  const root = temporary(t), dir = join(root, 'journal'), journal = openMvpJournal(dir, scope)
  const before = readFileSync(join(dir, 'owner-text.json'))
  symlinkSync(join(root, 'missing-target'), join(dir, 'owner-text.pending'), 'junction')
  assert.throws(() => journal.change(() => {}), /storage_unavailable/)
  assert.deepEqual(readFileSync(join(dir, 'owner-text.json')), before)
  assert.equal(lstatSync(join(dir, 'owner-text.pending')).isSymbolicLink(), true)
  assert.equal(journal.close({ drained: true }).lockRetained, true)
  assert.throws(() => openMvpJournal(dir, scope), /storage_format/)
})
test('031 backup collision/failure preserves scene; symlink directory refuses; normal recovery remains possible', async t => {
  const root = temporary(t), dir = join(root, 'journal'), a = actor(t, dir)
  await a.result(); await a.force()
  const lock = readFileSync(join(dir, '.writer-lock')), log = readFileSync(join(dir, 'owner-text.json'))
  const name = 'recovery-00000000-0000-0000-0000-000000000000'
  mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'sentinel'), 'keep')
  await assert.rejects(openManagedMvpJournal(dir, scope, { archiveNameFactory: () => name }))
  await assert.rejects(openManagedMvpJournal(dir, scope, { archive: () => { throw Error('synthetic_backup_failure') } }))
  assert.equal(readFileSync(join(dir, name, 'sentinel'), 'utf8'), 'keep')
  assert.deepEqual(readFileSync(join(dir, '.writer-lock')), lock); assert.deepEqual(readFileSync(join(dir, 'owner-text.json')), log)
  const link = join(root, 'alias'); symlinkSync(dir, link, 'junction')
  await assert.rejects(openManagedMvpJournal(link, scope), e => e.code === 'storage_recovery')
  const restored = await openManagedMvpJournal(dir, scope)
  assert.equal(restored.status().recovered, true); await restored.close({ drained: true })
  records.push({ kind: 'backup-fail-closed', originals: sha(log), collisionPreserved: true })
})
test('031 recovery canceled at the pre-archive await preserves lock/log and relinquishes ownership safely', async t => {
  for (const action of ['abort', 'generation']) {
    const dir = join(temporary(t), 'journal'), a = actor(t, dir)
    await a.result(); await a.force()
    const oldLock = readFileSync(join(dir, '.writer-lock')), oldLog = readFileSync(join(dir, 'owner-text.json'))
    let ready, resume
    const entered = new Promise(r => { ready = r }), wait = new Promise(r => { resume = r }), abort = new AbortController()
    let current = true
    const opening = openManagedMvpJournal(dir, scope, { signal: abort.signal, isCurrent: () => current,
      onStage: async stage => { if (stage === 'before-archive') { ready(); await wait } } })
    await entered
    if (action === 'abort') abort.abort()
    else current = false
    await assert.rejects(openManagedMvpJournal(dir, scope), e => e.code === 'storage_busy')
    resume(); await assert.rejects(opening, e => e.code === 'storage_canceled')
    assert.deepEqual(readFileSync(join(dir, '.writer-lock')), oldLock)
    assert.deepEqual(readFileSync(join(dir, 'owner-text.json')), oldLog)
    assert.equal(readdirSync(dir).filter(p => p.startsWith('recovery-')).length, 0)
  }
})
