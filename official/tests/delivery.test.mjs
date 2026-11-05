import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setup, plan, event, temp, config } from './plugin-fixture.mjs'
import { openLedger, ledgerNamespace } from '../lib/ledger.js'
import { inboundKey } from '../lib/config.js'

const disk = f => JSON.parse(readFileSync(join(f.c.stateDir, 'delivery.json'), 'utf8'))
const firstPlan = f => Object.values(disk(f).plans)[0]
async function prepared (t, opts) {
  const f = await setup(t, opts)
  await f.emit(event(f.c)); await f.idle()
  return f
}
test('partial success then unknown never resends confirmed or unknown bubbles', async t => {
  const f = await prepared(t, { outcomes: [{ kind: 'confirmed' }, { kind: 'unknown' }] })
  f.data.plans = [plan(f.c, 'synthetic-in-1', ['A', 'B', 'C'])]
  f.notify(); await f.until(() => f.data.sent.length === 2); await f.idle()
  for (let i = 0; i < 4; i++) { f.notify(); await f.idle() }
  assert.equal(f.data.sent.length, 2)
  assert.equal(f.data.acks.length, 0)
  assert.deepEqual(firstPlan(f).parts.map(p => p.state), ['confirmed', 'unknown', 'planned'])
})
for (const kind of ['rejected', 'expired', 'token', 'unknown']) test(kind + ' is terminal without retry, ack or proactive fallback', async t => {
  const f = await prepared(t, { outcomes: [{ kind }] })
  f.data.plans = [plan(f.c)]; f.notify(); await f.until(() => f.data.sent.length === 1); await f.idle()
  f.notify(); await f.clock.advance(5000); await f.idle()
  assert.equal(f.data.sent.length, 1)
  assert.equal(f.data.acks.length, 0)
  assert.equal(firstPlan(f).parts[0].state, kind)
  assert.equal(f.data.rawLease + f.data.rawAck, 0)
})
test('429 waits then retries the identical physical request with bounded attempts', async t => {
  const f = await prepared(t, { outcomes: Array.from({ length: 5 }, () => ({ kind: 'rate_limited', retryAfterMs: 1000 })) })
  f.data.plans = [plan(f.c)]; f.notify(); await f.until(() => f.data.sent.length === 1); await f.idle()
  f.notify(); await f.idle(); assert.equal(f.data.sent.length, 1)
  for (let i = 0; i < 4; i++) { await f.clock.advance(1000); await f.idle() }
  assert.equal(f.data.sent.length, 3)
  assert.deepEqual(f.data.sent[0], f.data.sent[1])
  assert.deepEqual(f.data.sent[1], f.data.sent[2])
  assert.equal(f.data.acks.length, 0)
})
test('ack-only failure retries acknowledgement and never repeats successful send', async t => {
  const f = await prepared(t)
  let attempts = 0
  f.service.officialC2c.ackReplies = async p => { f.data.acks.push(p); if (++attempts === 1) throw Error('synthetic_ack_failure'); return { ok: true, ids: p.ids } }
  f.data.plans = [plan(f.c)]; f.notify(); await f.until(() => f.data.acks.length === 1)
  assert.equal(f.controller.status().code, 'ack_pending')
  await f.clock.advance(1000); await f.until(() => f.data.acks.length === 2)
  assert.equal(f.data.sent.length, 1)
  assert.equal(firstPlan(f).acked, true)
})
test('wrong ack ids cannot confirm an otherwise delivered plan', async t => {
  const f = await prepared(t)
  f.service.officialC2c.ackReplies = async p => { f.data.acks.push(p); return { ok: true, ids: [999] } }
  f.data.plans = [plan(f.c)]; f.notify(); await f.until(() => f.data.acks.length === 1)
  assert.equal(firstPlan(f).acked, false)
  assert.equal(f.data.sent.length, 1)
})
test('plan mutation or overlapping original rows never creates a new delivery', async t => {
  const f = await prepared(t, { outcomes: [{ kind: 'unknown' }] })
  f.data.plans = [plan(f.c)]; f.notify(); await f.until(() => f.data.sent.length === 1); await f.idle()
  f.data.plans[0].rows[0].text = 'changed after frozen'
  f.notify(); await f.idle()
  f.data.plans[0].planKey = 'new-claim-same-row'
  f.notify(); await f.idle()
  assert.equal(f.data.sent.length, 1)
})
test('four sequences are shared across all plans for one original message', async t => {
  const f = await prepared(t)
  f.data.plans = [plan(f.c, 'synthetic-in-1', ['A', 'B', 'C', 'D'])]
  f.notify(); await f.until(() => f.data.acks.length === 1); await f.idle()
  const p = plan(f.c, 'synthetic-in-1', ['fifth'], { planKey: 'plan-2', turnId: 'turn-2' })
  Object.assign(p.rows[0], { id: 20, turnId: 'turn-2#0' })
  f.data.plans = [p]; f.notify(); await f.idle()
  assert.equal(f.data.sent.length, 4)
  assert.equal(f.controller.status().code, 'budget')
})
test('distinct event indexes for one official msg_id share the same four-reply budget', async t => {
  const f = await prepared(t)
  f.data.plans = [plan(f.c, 'synthetic-in-1', ['A', 'B', 'C', 'D'])]
  f.notify(); await f.until(() => f.data.acks.length === 1); await f.idle()
  await f.emit(event(f.c, 'synthetic-in-1', { message_scene: { ext: ['msg_idx=SECOND_ELEMENT'] }, content: 'another element' })); await f.idle()
  const p = plan(f.c, 'synthetic-in-1', ['fifth'], { planKey: 'element-plan-2', turnId: 'element-turn-2', inboundKey: inboundKey(f.c.appId, 'synthetic-in-1', 'msg_idx=SECOND_ELEMENT') })
  Object.assign(p.rows[0], { id: 50, turnId: 'element-turn-2#0' })
  f.data.plans = [p]; f.notify(); await f.idle()
  assert.equal(f.data.injections.length, 2)
  assert.equal(f.data.sent.length, 4)
  assert.equal(f.controller.status().code, 'budget')
})
test('later index without timestamp cannot extend the original five-minute window', async t => {
  const f = await prepared(t)
  f.clock.time += 300000
  const later = event(f.c, 'synthetic-in-1', { message_scene: { ext: ['msg_idx=LATE_ELEMENT'] }, timestamp: undefined })
  assert.equal(await f.emit(later), true)
  assert.equal(f.data.injections.length, 1)
  assert.equal(f.controller.status().code, 'expired')
  assert.equal(f.data.sent.length, 0)
})
test('notBefore delays physical send without reassigning the original message', async t => {
  const f = await prepared(t)
  const p = plan(f.c); p.rows[0].notBefore = (f.clock.now() + 2000) / 1000
  f.data.plans = [p]; f.notify(); await f.idle()
  assert.equal(f.data.sent.length, 0)
  await f.clock.advance(2000); await f.until(() => f.data.sent.length === 1)
  assert.equal(f.data.sent[0].msgId, 'synthetic-in-1')
})
test('stop during send never accepts late success or sends another bubble', async t => {
  let resolveSend
  const f = await prepared(t, { outcomes: [() => new Promise(resolve => { resolveSend = resolve })] })
  f.data.plans = [plan(f.c, 'synthetic-in-1', ['A', 'B'])]; f.notify(); await f.until(() => !!resolveSend)
  const stopped = f.controller.dispose()
  resolveSend({ kind: 'confirmed' }); await stopped
  assert.equal(f.data.sent.length, 1)
  assert.equal(f.data.acks.length, 0)
  assert.equal(firstPlan(f).parts[0].state, 'unknown')
})
test('restart with confirmed-but-unacked journal retries ack alone', async t => {
  const root = temp(t)
  const a = await prepared(t, { root })
  a.service.officialC2c.ackReplies = async p => { a.data.acks.push(p); throw Error('synthetic_ack_failure') }
  a.data.plans = [plan(a.c)]; a.notify(); await a.until(() => a.data.acks.length === 1)
  await a.controller.dispose()
  const b = await setup(t, { root, raw: a.c })
  await b.idle()
  await b.clock.advance(1000); await b.until(() => b.data.acks.length === 1)
  assert.equal(b.data.sent.length, 0)
  assert.equal(firstPlan(b).acked, true)
})
test('persisted sending boundary becomes unknown at restart and is not replayed', async t => {
  const root = temp(t)
  const a = await prepared(t, { root, outcomes: [{ kind: 'unknown' }] })
  a.data.plans = [plan(a.c)]; a.notify(); await a.until(() => a.data.sent.length === 1); await a.idle()
  await a.controller.dispose()
  // Simulate a durable crash snapshot, not a claim of power-loss testing.
  const path = join(a.c.stateDir, 'delivery.json'), snapshot = disk(a)
  Object.values(snapshot.plans)[0].parts[0].state = 'sending'
  writeFileSync(path, JSON.stringify(snapshot))
  const b = await setup(t, { root, raw: a.c }); b.data.plans = [plan(b.c)]
  await b.clock.advance(1000); await b.idle()
  assert.equal(b.data.sent.length, 0)
  assert.equal(b.data.acks.length, 0)
  assert.equal(firstPlan(b).parts[0].state, 'unknown')
})
test('owner/AppID change cannot open the old delivery namespace', async t => {
  const root = temp(t), c = config(root)
  const ledger = openLedger(c.stateDir, ledgerNamespace(c)); ledger.close()
  assert.throws(() => openLedger(c.stateDir, ledgerNamespace({ ...c, appId: 'different-app' })), /storage/)
})
test('second writer, unowned directory and interrupted pending file fail closed', async t => {
  const root = temp(t), c = config(root)
  const a = openLedger(c.stateDir, ledgerNamespace(c))
  assert.throws(() => openLedger(c.stateDir, ledgerNamespace(c)))
  a.close()
  writeFileSync(join(c.stateDir, 'delivery.pending'), '{}')
  assert.throws(() => openLedger(c.stateDir, ledgerNamespace(c)))
  assert.equal(existsSync(join(c.stateDir, '.writer-lock')), false)
  assert.throws(() => openLedger(root, ledgerNamespace(c)))
})
test('multiple original messages share a local account/owner burst limit', async t => {
  const f = await prepared(t)
  for (let i = 0; i < 6; i++) {
    const id = 'burst-in-' + i
    await f.emit(event(f.c, id)); await f.idle()
    const p = plan(f.c, id, ['burst answer'], { planKey: 'burst-plan-' + i })
    p.rows[0].id = 100 + i
    f.data.plans = [p]; f.notify(); await f.idle()
  }
  assert.equal(f.data.sent.length, 5)
  await f.clock.advance(1000); await f.until(() => f.data.sent.length === 6)
})
test('twenty local account/relationship attempts per minute include distinct originals', async t => {
  const f = await prepared(t)
  for (let i = 0; i < 21; i++) {
    const id = 'minute-in-' + i
    await f.emit(event(f.c, id)); await f.idle()
    const p = plan(f.c, id, ['minute answer'], { planKey: 'minute-plan-' + i })
    p.rows[0].id = 200 + i
    f.data.plans = [p]; f.notify(); await f.idle()
    if (i < 20) { await f.clock.advance(1000); await f.idle() }
  }
  assert.equal(f.data.sent.length, 20)
  assert.equal(f.controller.status().code, 'rate_limited')
  await f.clock.advance(40000); await f.until(() => f.data.sent.length === 21)
})
