import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import * as codec from '../../../dsh-memory-agent/lib/official-c2c-codec.js'
import { openMvpJournal } from '../lib/mvp-journal.js'
import { createTransport } from '../lib/transport.js'
import { fixture, until } from './transport-fixture.mjs'

function temporary (t) {
  const base = resolve(tmpdir()), root = mkdtempSync(join(base, 'echo025-journal-'))
  const rel = relative(base, root)
  assert.ok(rel.startsWith('echo025-journal-') && !rel.startsWith('..') && !isAbsolute(rel))
  t.after(() => { assert.equal(resolve(root), root); rmSync(root, { recursive: true, force: true }) })
  return root
}
function identity () {
  const raw = { appId: 'synthetic-app-A', rawOpenid: 'SYNTHETIC_OWNER_OPENID_A', rawMsgId: 'synthetic-in-1', indexKind: 'missing', indexValue: '' }
  const ids = codec.deriveMessageIdentity(raw)
  const scope = { ...codec.validateScope({ platform: 'qq-official', appId: raw.appId, ownerHash: ids.ownerHash, chatId: ids.chatId }), keyScheme: codec.KEY_SCHEME }
  return { scope, entry: { ...ids, scopeKey: scope.scopeKey, rawMsgId: raw.rawMsgId, text: 'synthetic body', firstAtMs: 1000000, deadlineMs: 1300000 } }
}
function metadata (entry) {
  return { scopeKey: entry.scopeKey, inboundKey: entry.inboundKey, replyAnchorKey: entry.replyAnchorKey,
    inputDigest: codec.inputDigest({ ...entry, text: entry.text }), requestKey: 'synthetic-request',
    sourceKey: 'synthetic-source', attemptKey: 'synthetic-attempt',
    admissionState: 'accepted', everAccepted: true, processingState: 'queued_volatile', receipt: { id: 'synthetic-receipt' } }
}

test('025 journal: metadata commit resolves after actual flushed file replace and serial reducer', async t => {
  const root = temporary(t), { scope, entry } = identity()
  const journal = openMvpJournal(join(root, 'new-mvp'), scope)
  journal.rememberInput(entry)
  const ref = { scopeKey: scope.scopeKey, inboundKey: entry.inboundKey }
  let reductions = 0
  const first = journal.metadataStore.transaction(ref, old => { assert.equal(old, null); reductions++; return { next: metadata(entry), value: 'committed' } })
  const second = journal.metadataStore.transaction(ref, old => { reductions++; assert.equal(old.everAccepted, true); return { next: { ...old, processingState: 'entered' }, value: old.receipt.id } })
  assert.equal(await first, 'committed')
  assert.equal(await second, 'synthetic-receipt')
  assert.equal(reductions, 2)
  const disk = JSON.parse(readFileSync(join(root, 'new-mvp', 'owner-text.json'), 'utf8'))
  assert.equal(disk.metadata[entry.inboundKey].processingState, 'entered')
  assert.equal(disk.inputs[entry.inboundKey].text, entry.text)
  assert.equal(journal.metadataStore.durability, 'durable-metadata')
  assert.deepEqual(journal.close({ drained: true }), { closed: true, lockRetained: false })
})
test('025 journal: metadata scope/body/anchor mutations and deletion cannot overwrite record', async t => {
  const root = temporary(t), { scope, entry } = identity(), j = openMvpJournal(join(root, 'mvp'), scope)
  j.rememberInput(entry)
  const ref = { scopeKey: scope.scopeKey, inboundKey: entry.inboundKey }
  await j.metadataStore.transaction(ref, () => ({ next: metadata(entry), value: null }))
  for (const patch of [{ inputDigest: 'changed' }, { replyAnchorKey: 'changed' }, { scopeKey: 'changed' }]) {
    await assert.rejects(j.metadataStore.transaction(ref, old => ({ next: { ...old, ...patch }, value: null })), /metadata_conflict/)
  }
  await assert.rejects(j.metadataStore.transaction({ ...ref, scopeKey: 'other' }, old => ({ next: old })), /metadata_scope_conflict/)
  await assert.rejects(j.metadataStore.transaction(ref, () => ({ next: null })), /metadata_delete_forbidden/)
  await assert.rejects(j.metadataStore.transaction(ref, async old => ({ next: old })), /metadata_reducer/)
  assert.equal((await j.metadataStore.read(ref)).inputDigest, metadata(entry).inputDigest)
  assert.throws(() => j.rememberInput({ ...entry, text: 'changed' }), /input_conflict/)
  assert.equal(j.close({ drained: true }).closed, true)
})
test('025 journal: single writer/new marker reject old v1, owner/app mismatch and pending file', t => {
  const root = temporary(t), { scope } = identity(), dir = join(root, 'mvp')
  const j = openMvpJournal(dir, scope)
  assert.throws(() => openMvpJournal(dir, scope))
  j.close({ drained: true })
  assert.throws(() => openMvpJournal(dir, { ...scope, appId: 'other-app' }), /storage_unavailable/)
  assert.equal(existsSync(join(dir, '.writer-lock')), true)
  const old = join(root, 'v1'); mkdirSync(old); writeFileSync(join(old, '.echo-official-owner'), 'echo-official-v1\n')
  assert.throws(() => openMvpJournal(old, scope), /storage_format/)
  const pending = join(root, 'pending')
  const p = openMvpJournal(pending, scope); p.close({ drained: true })
  writeFileSync(join(pending, 'owner-text.pending'), '{}')
  assert.throws(() => openMvpJournal(pending, scope), /storage_format/)
  const corrupt = join(root, 'corrupt')
  const c = openMvpJournal(corrupt, scope); c.close({ drained: true })
  writeFileSync(join(corrupt, 'owner-text.json'), '{broken')
  assert.throws(() => openMvpJournal(corrupt, scope), /storage_unavailable/)
})
test('025 journal: clean restart abandons drafts, makes sending unknown and retains original input', t => {
  const root = temporary(t), { scope, entry } = identity(), dir = join(root, 'mvp')
  const j = openMvpJournal(dir, scope)
  j.rememberInput(entry)
  j.change(d => { d.anchors[entry.replyAnchorKey].state = 'sending'; d.pendingClaim = { key: 'synthetic-claim' } })
  j.close({ drained: true })
  const next = openMvpJournal(dir, scope)
  assert.equal(next.snapshot().anchors[entry.replyAnchorKey].state, 'unknown')
  assert.equal(next.snapshot().pendingClaim, null)
  assert.equal(next.snapshot().inputs[entry.inboundKey].text, entry.text)
  assert.equal(next.close({ drained: false }).lockRetained, true)
  assert.equal(next.close({ drained: true }).closed, true)
})
test('025 journal: same raw message index shares earliest anchor, capacity faults keep lock', t => {
  const root = temporary(t), { scope, entry } = identity(), dir = join(root, 'mvp')
  const j = openMvpJournal(dir, scope, { maxInputs: 1 })
  j.rememberInput(entry)
  j.rememberInput({ ...entry, firstAtMs: 999000, deadlineMs: 1299000 })
  assert.equal(j.snapshot().anchors[entry.replyAnchorKey].deadlineMs, 1299000)
  const other = codec.deriveMessageIdentity({ appId: scope.appId, rawOpenid: 'SYNTHETIC_OWNER_OPENID_A', rawMsgId: 'synthetic-other', indexKind: 'missing', indexValue: '' })
  assert.throws(() => j.rememberInput({ ...entry, ...other, rawMsgId: 'synthetic-other' }), /storage_unavailable/)
  assert.equal(j.status().failed, true)
  assert.equal(j.close({ drained: true }).lockRetained, true)
  assert.equal(existsSync(join(dir, '.writer-lock')), true)
})
test('025 transport: optional final gate runs after token, can deny with zero POST and preserves default send', async t => {
  const f = await fixture(t), bot = createTransport({ appId: 'synthetic-app', appSecret: 'synthetic-secret', testEndpoints: f.testEndpoints })
  t.after(() => bot.stop())
  assert.equal(await bot.start(), true); await until(() => bot.status() === 'ready')
  const text = { openid: 'SYNTHETIC_OWNER_OPENID_A', msgId: 'synthetic-id', msgSeq: 1, text: 'synthetic answer' }
  let gates = 0
  assert.deepEqual(await bot.sendText({ ...text, beforePost: () => { gates++; return { allowed: false, reason: 'rate_wait', retryAtMs: 12345 } } }), { kind: 'not_dispatched', reason: 'rate_wait', retryAtMs: 12345 })
  assert.equal(gates, 1); assert.equal(f.posts().length, 0)
  assert.equal((await bot.sendText({ ...text, beforePost: () => ({ allowed: true }) })).kind, 'confirmed')
  assert.equal((await bot.sendText(text)).kind, 'confirmed')
  assert.equal(f.posts().length, 2)
})
