import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, config, event, plan, temp } from './plugin-fixture.mjs'
import { identity, inboundKey, PLATFORM } from '../lib/config.js'
import { createChannel as createLegacyChannel } from '../../lib/contract.js'

for (const [label, change, expected] of [
  ['default disabled', { enabled: undefined }, 'disabled'],
  ['missing credential', { appSecret: '' }, 'credentials'],
  ['no binding', { ownerBinding: null }, 'binding'],
  ['unapproved binding', { ownerBinding: { appId: 'synthetic-app-A', userOpenid: 'SYNTHETIC_OWNER_OPENID_A', authorized: false } }, 'binding'],
  ['wrong binding AppID', { ownerBinding: { appId: 'synthetic-app-B', userOpenid: 'SYNTHETIC_OWNER_OPENID_A', authorized: true } }, 'binding'],
  ['QQ number is not OpenID', { ownerBinding: { appId: 'synthetic-app-A', userOpenid: '10000000001', authorized: true } }, 'binding'],
  ['relative storage', { stateDir: './state' }, 'storage']
]) test(label + ' performs zero network/storage/registration', async t => {
  const root = temp(t), c = config(root, change)
  const f = await setup(t, { raw: c, root })
  assert.equal(f.controller.status().code, expected)
  assert.equal(f.data.registered.length, 0)
  assert.equal(f.data.transportOpts, undefined)
  assert.equal(existsSync(join(root, 'ledger')), false)
})

test('current Echo without complete-turn capability remains completely off', async t => {
  const f = await setup(t, { replies: false })
  assert.equal(f.controller.status().code, 'context')
  assert.equal(f.data.registered.length, 0)
  assert.equal(f.data.transportOpts, undefined)
  assert.equal(f.data.rawLease + f.data.rawAck, 0)
  assert.equal(existsSync(f.c.stateDir), false)
})
test('missing Echo basic service does not connect', async t => {
  const f = await setup(t, { serviceOverride: { inject: null } })
  assert.equal(f.controller.status().code, 'service')
  assert.equal(f.data.registered.length, 0)
})
test('explicit owner uses existing relay and duplicate events do not re-inject', async t => {
  const f = await setup(t)
  assert.equal(await f.emit(event(f.c)), true)
  assert.equal(await f.emit(event(f.c)), true)
  assert.equal(f.data.injections.length, 1)
  const e = f.data.injections[0]
  assert.equal(e.platform, PLATFORM)
  assert.equal(e.chat.id, identity(f.c.appId, f.c.ownerBinding.userOpenid))
  assert.equal(e.msgId, inboundKey(f.c.appId, 'synthetic-in-1'))
  assert.equal(e.sender.isMaster, true)
  assert.equal(f.data.agentCalls, 0)
  assert.equal(f.controller.status().duplicate, 1)
})
test('unknown/non-owner/group/empty/future/old events never enter Echo', async t => {
  const f = await setup(t)
  const samples = [event(f.c, 'other', { author: { user_openid: 'SYNTHETIC_STRANGER' } }), event(f.c, 'bot', { author: { user_openid: f.c.ownerBinding.userOpenid, bot: true } }), { ...event(f.c), t: 'GROUP_MESSAGE_CREATE' }, event(f.c, 'empty', { content: '' }), event(f.c, 'future', { timestamp: new Date(2000000).toISOString() }), event(f.c, 'old', { timestamp: new Date(0).toISOString() })]
  for (const e of samples) assert.equal(await f.emit(e), true)
  assert.equal(f.data.injections.length, 0)
})
test('same OpenID and message id under different AppIDs are isolated', async t => {
  const a = await setup(t), rb = temp(t)
  const b = await setup(t, { root: rb, raw: config(rb, { appId: 'synthetic-app-B', ownerBinding: { ...a.c.ownerBinding, appId: 'synthetic-app-B' } }) })
  await a.emit(event(a.c)); await b.emit(event(b.c))
  assert.notEqual(a.data.injections[0].chat.id, b.data.injections[0].chat.id)
  assert.notEqual(a.data.injections[0].msgId, b.data.injections[0].msgId)
  b.data.plans = [plan(a.c)]
  b.notify(); await b.idle()
  assert.equal(b.data.sent.length, 0)
})
test('enhanced complete-turn contract returns text and scoped ack', async t => {
  const f = await setup(t)
  await f.emit(event(f.c)); await f.idle()
  f.data.plans = [plan(f.c)]
  f.notify(); await f.until(() => f.data.acks.length === 1)
  assert.deepEqual(f.data.sent.map(p => [p.msgId, p.msgSeq, p.text]), [['synthetic-in-1', 1, 'synthetic answer']])
  assert.equal(f.data.acks[0].appId, f.c.appId)
  assert.equal(f.data.acks[0].platform, PLATFORM)
  assert.deepEqual(f.data.acks[0].ids, [1])
  assert.equal(f.data.rawLease + f.data.rawAck, 0)
})
test('six original bubbles are completely retained in at most four sends', async t => {
  const f = await setup(t)
  await f.emit(event(f.c)); await f.idle()
  const texts = ['一', '二', '三', '四', '五', '六']
  f.data.plans = [plan(f.c, 'synthetic-in-1', texts)]
  f.notify(); await f.until(() => f.data.acks.length === 1)
  assert.equal(f.data.sent.length, 4)
  assert.equal(f.data.sent.map(p => p.text).join('\n'), texts.join('\n'))
  assert.deepEqual(f.data.sent.map(p => p.msgSeq), [1, 2, 3, 4])
  assert.deepEqual(f.data.acks[0].ids, [1, 2, 3, 4, 5, 6])
})

for (const [label, mutate] of [
  ['missing original', p => { p.inboundKey = 'unknown' }],
  ['partial turn', p => { p.complete = false }],
  ['unsolicited active', p => { p.kind = 'proactive' }],
  ['active row', p => { p.rows[0].kind = 'proactive' }],
  ['legacy qq row', p => { p.rows[0].platform = 'qq' }],
  ['other chat', p => { p.rows[0].chatId = 'other-chat' }],
  ['wrong turn', p => { p.rows[0].turnId = 'different-turn' }],
  ['duplicate ids', p => { p.rows.push({ ...p.rows[0] }) }]
]) test(label + ' is refused without sending/ack', async t => {
  const f = await setup(t)
  await f.emit(event(f.c)); await f.idle()
  const p = plan(f.c); mutate(p); f.data.plans = [p]
  f.notify(); await f.idle()
  assert.equal(f.data.sent.length, 0)
  assert.equal(f.data.acks.length, 0)
  assert.equal(f.controller.status().code, 'context')
})
test('reply window expires conservatively after five minutes', async t => {
  const f = await setup(t)
  await f.emit(event(f.c)); await f.idle()
  f.clock.time += 300000
  f.data.plans = [plan(f.c)]; f.notify(); await f.idle()
  assert.equal(f.data.sent.length, 0)
  assert.equal(f.controller.status().code, 'expired')
})
test('oversized text is refused whole without truncation', async t => {
  const f = await setup(t)
  await f.emit(event(f.c)); await f.idle()
  f.data.plans = [plan(f.c, 'synthetic-in-1', ['字'.repeat(1501)])]; f.notify(); await f.idle()
  assert.equal(f.data.sent.length, 0)
  assert.equal(f.controller.status().code, 'budget')
})
test('configuration mutation or service replacement invalidates old event generation', async t => {
  const f = await setup(t)
  f.c.enabled = false
  assert.equal(await f.emit(event(f.c)), false)
  await f.clock.advance(1000)
  assert.equal(f.data.injections.length, 0)
  assert.equal(f.controller.status().connected, false)
})
test('safe status never includes owner, secret, message or protocol exception', async t => {
  const f = await setup(t)
  await f.emit(event(f.c))
  const status = JSON.stringify(f.controller.status())
  for (const needle of [f.c.appId, f.c.appSecret, f.c.ownerBinding.userOpenid, 'synthetic input', 'synthetic-in-1']) assert.equal(status.includes(needle), false)
  await f.controller.dispose()
  assert.equal(await f.emit(event(f.c)), false)
  assert.equal(f.data.unregistered, 1)
  assert.equal(f.data.unsubscribed, 1)
  assert.equal(f.clock.timers.size, 0)
})
test('legacy OneBot consumer and official consumer lease/ack only their own namespace', async t => {
  const f = await setup(t), legacyRows = [], legacyScopes = [], legacyAcks = []
  f.service.lease = async scope => { legacyScopes.push(scope); return { items: [{ id: 901, chatId: 'synthetic-legacy-chat', text: 'legacy only' }], nextDueAt: 0 } }
  f.service.ack = async ids => { legacyAcks.push(ids); return { rows: [] } }
  const old = createLegacyChannel({ ctx: { get: key => key === 'echo:relay' ? f.service : undefined }, settings: () => ({}) })
  const unsubscribe = old.onOutbound(async rows => { legacyRows.push(...rows); await old.ack(rows.map(r => r.id)) })
  t.after(() => { unsubscribe(); old.dispose() })
  old.drain()
  await f.until(() => legacyRows.length === 1)
  await f.emit(event(f.c)); await f.idle()
  f.data.plans = [plan(f.c)]; await f.clock.advance(1000)
  await f.until(() => f.data.acks.length === 1)
  assert.ok(legacyScopes.every(s => s.platform === 'qq'))
  assert.ok(f.data.leases.every(s => s.platform === PLATFORM && s.appId === f.c.appId))
  assert.equal(String(legacyAcks[0][0]), '901')
  assert.deepEqual(f.data.acks[0].ids, [1])
  assert.equal(f.data.sent[0].text, 'synthetic answer')
  assert.equal(legacyRows[0].text, 'legacy only')
})
test('service or reply-capability replacement invalidates late events before inject', async t => {
  for (const replace of [f => f.store.set('echo:relay', { ...f.service }), f => { f.service.officialC2c = { ...f.service.officialC2c } }]) {
    const f = await setup(t)
    replace(f)
    assert.equal(await f.emit(event(f.c)), false)
    assert.equal(f.data.injections.length, 0)
    await f.clock.advance(1000)
    assert.equal(f.controller.status().connected, false)
  }
})
