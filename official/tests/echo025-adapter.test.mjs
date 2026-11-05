import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupMvp, eventFor, stubService, gate, tick } from './echo025-fixture.mjs'
import { apply } from '../lib/index.js'
const log = f => JSON.parse(readFileSync(join(f.raw.stateDir, 'owner-text.json'), 'utf8'))

test('025 stub: capability unavailable/old v1 and default disabled create no journal or network', async t => {
  for (const service of [{}, { officialC2c: { version: 1, contract: 'complete-turn-v1' } }]) {
    const f = await setupMvp(t, { stub: { service, data: {} }, transportFactory: () => { throw Error('network_forbidden') } })
    assert.equal(f.controller.status().code, 'context')
    assert.equal(existsSync(f.raw.stateDir), false)
  }
})
test('025 default apply stays disabled and never looks up a core/network/storage without config', async () => {
  const published = new Map(), disposers = []
  apply({ get: () => { throw Error('core_lookup_forbidden') }, provide: (name, value) => { published.set(name, value) },
    effect: fn => { disposers.push(fn()) } })
  const controller = published.get('echo:official-c2c')
  await controller.ready
  assert.equal(controller.status().code, 'disabled')
  assert.equal(controller.status().canSend, false)
  await controller.dispose()
  for (const fn of disposers) await fn()
})
test('025 stub: owner input, immutable claim/body, one message success, duplicate index cannot resend', async t => {
  const f = await setupMvp(t)
  assert.equal(await f.emit(eventFor(f.raw)), true)
  await f.idle()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].msgId, 'synthetic-in-1'); assert.equal(f.sent[0].msgSeq, 1)
  assert.equal(f.sent[0].text, 'synthetic answer')
  assert.equal(await f.emit(eventFor(f.raw)), true)
  assert.equal(await f.emit(eventFor(f.raw, undefined, undefined, { message_scene: { ext: ['msg_idx=2'] } })), true)
  await f.idle(); assert.equal(f.sent.length, 1); assert.equal(f.data.injects.length, 1)
  const d = log(f), a = Object.values(d.anchors)[0]
  assert.equal(a.state, 'confirmed'); assert.equal(a.attempts.length, 1); assert.equal(a.coreSettled, true)
  assert.equal(Object.values(d.metadata)[0].everAccepted, true)
  const serialized = JSON.stringify(f.data.bindings[0].scope) + JSON.stringify(f.data.bindings[0].authorization) + JSON.stringify(f.data.injects)
  assert.ok(!serialized.includes(f.raw.ownerBinding.userOpenid)); assert.ok(!serialized.includes('synthetic-in-1'))
  assert.ok(!JSON.stringify(f.controller.status()).includes('SYNTHETIC_025_SECRET'))
})
test('025 stub: invalid/non-owner/bot/duplicate ext never inject', async t => {
  const f = await setupMvp(t)
  for (const extra of [
    { author: { user_openid: 'SYNTHETIC_OTHER_OWNER' } }, { author: { user_openid: f.raw.ownerBinding.userOpenid, bot: true } },
    { content: '' }, { content: '\ud800' }, { id: '' }, { message_scene: { ext: ['msg_idx=1', 'msg_idx=2'] } }
  ]) assert.equal(await f.emit(eventFor(f.raw, undefined, undefined, extra)), true)
  assert.equal(f.data.injects.length, 0); assert.equal(f.sent.length, 0)
})
test('025 stub: take reply response lost recovers the same pre-persisted claim', async t => {
  let lost = false
  const f = await setupMvp(t, { takeHook: async (key, reply) => { if (reply && !lost) { lost = true; throw Error('synthetic_lost_claim_response') } } })
  await f.emit(eventFor(f.raw)); await f.idle(); await f.idle()
  assert.equal(f.sent.length, 1)
  const assigned = [...f.data.claims.keys()]
  assert.equal(assigned.length, 1)
  const a = Object.values(log(f).anchors)[0]
  assert.equal(a.claimKey, assigned[0])
  assert.ok(f.data.takes.filter(key => key === a.claimKey).length >= 2)
})
test('025 stub: confirmed core receipt lost retries confirmation only, never HTTP', async t => {
  let lost = false
  const f = await setupMvp(t, { confirmHook: async input => { if (input.outcome === 'confirmed' && !lost) { lost = true; throw Error('synthetic_lost_confirmation_response') } } })
  await f.emit(eventFor(f.raw)); await f.idle(); await f.idle()
  assert.equal(f.sent.length, 1)
  const confirmations = f.data.confirms.filter(x => x.outcome === 'confirmed')
  assert.ok(confirmations.length >= 2); assert.deepEqual(confirmations[0], confirmations[1])
  assert.equal(Object.values(log(f).anchors)[0].coreSettled, true)
})
test('025 stub: 429 keeps original sequence and at most three attempts; no fourth POST', async t => {
  const f = await setupMvp(t, { send: async () => ({ kind: 'rate_limited', retryAfterMs: 1000 }) })
  await f.emit(eventFor(f.raw)); await f.idle()
  assert.equal(f.sent.length, 1)
  await f.clock.advance(1000); await f.idle()
  await f.clock.advance(1000); await f.idle()
  await f.clock.advance(1000); await f.idle()
  assert.equal(f.sent.length, 3)
  assert.ok(f.sent.every(p => p.msgSeq === 1 && p.msgId === 'synthetic-in-1'))
  assert.equal(Object.values(log(f).anchors)[0].attempts.length, 3)
  assert.equal(Object.values(log(f).anchors)[0].state, 'rejected')
})
test('025 stub: timeout/unknown never reposts but another raw message can progress', async t => {
  const f = await setupMvp(t, { send: async () => ({ kind: 'unknown' }) })
  await f.emit(eventFor(f.raw)); await f.idle(); await f.clock.advance(2000); await f.idle()
  assert.equal(f.sent.length, 1)
  assert.equal(Object.values(log(f).anchors)[0].state, 'unknown')
  await f.emit(eventFor(f.raw, 'synthetic-in-2')); await f.idle()
  assert.equal(f.sent.length, 2)
})
test('025 stub: accepted new input while token waits prevents old POST and permits new reply', async t => {
  const waiting = gate(), release = gate()
  let first = true
  const f = await setupMvp(t, { beforeSend: async () => { if (first) { first = false; waiting.resolve(); await release.promise } } })
  await f.emit(eventFor(f.raw)); await waiting.promise
  await f.emit(eventFor(f.raw, 'synthetic-in-2'))
  release.resolve(); await f.idle(); await f.idle()
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].msgId, 'synthetic-in-2')
})
test('025 stub: disable while HTTP pending records unknown and waits before releasing lock', async t => {
  const started = gate(), release = gate()
  const f = await setupMvp(t, { send: async () => { started.resolve(); await release.promise; return { kind: 'confirmed' } } })
  await f.emit(eventFor(f.raw)); await started.promise
  f.raw.enabled = false
  const status = await f.controller.dispose({ timeoutMs: 0 })
  assert.equal(status.drained, false); assert.equal(status.lockRetained, true)
  assert.equal(existsSync(join(f.raw.stateDir, '.writer-lock')), true)
  release.resolve(); await tick(); await tick()
  const last = await f.controller.dispose({ timeoutMs: 100 })
  assert.equal(Object.values(log(f).anchors)[0].state, 'unknown')
  assert.equal(last.drained, true); assert.equal(last.ledgerLockReleased, true)
  assert.equal(f.sent.length, 1)
})
test('025 stub: rejection and overlong reply do not split/truncate into another send', async t => {
  const f = await setupMvp(t, { text: '🦉'.repeat(1501) })
  await f.emit(eventFor(f.raw)); await f.idle()
  assert.equal(f.sent.length, 0)
  assert.equal(f.controller.status().canSend, false)
})
test('025 stub: final dispatch timestamps/5-per-second budget are checked after a slow token wait', async t => {
  const started = gate(), release = gate()
  let sends = 0
  const f = await setupMvp(t, { beforeSend: async () => { if (++sends === 6) { started.resolve(); await release.promise } } })
  for (let i = 0; i < 5; i++) { await f.emit(eventFor(f.raw, 'synthetic-rate-' + i)); await f.idle() }
  assert.equal(f.sent.length, 5)
  await f.emit(eventFor(f.raw, 'synthetic-rate-5')); await started.promise
  assert.equal(log(f).dispatchHistory.length, 5)
  f.clock.time += 1000
  release.resolve(); await f.idle()
  assert.equal(f.sent.length, 6)
  assert.equal(log(f).dispatchHistory.at(-1), 1001000)
  for (let i = 6; i < 11; i++) { await f.emit(eventFor(f.raw, 'synthetic-rate-' + i)); await f.idle() }
  assert.equal(f.sent.length, 10) // the eleventh waits in the same actual second
  f.clock.time += 1000; await f.controller.poll()
  assert.equal(f.sent.length, 11)
})
test('025 stub: account 20/minute blocks the 21st and keeps history across normal waiting', async t => {
  const f = await setupMvp(t)
  for (let i = 0; i < 21; i++) {
    f.clock.time = 1000000 + Math.floor(i / 5) * 1000
    await f.emit(eventFor(f.raw, 'synthetic-minute-' + i)); await f.idle()
  }
  assert.equal(f.sent.length, 20)
  assert.equal(log(f).dispatchHistory.length, 20)
  f.clock.time = 1060000; await f.controller.poll()
  assert.equal(f.sent.length, 21)
  assert.equal(log(f).dispatchHistory.length, 21) // no idempotency/history purge
})
test('025 stub: pending-file write fault fails closed before POST and retains writer marker', async t => {
  let f
  f = await setupMvp(t, { beforeSend: async () => { writeFileSync(join(f.raw.stateDir, 'owner-text.pending'), '{}') } })
  await f.emit(eventFor(f.raw)); await f.idle()
  assert.equal(f.sent.length, 0)
  assert.equal(f.controller.status().code, 'storage_error')
  assert.equal(f.controller.status().canSend, false)
  assert.equal(existsSync(join(f.raw.stateDir, '.writer-lock')), true)
})
