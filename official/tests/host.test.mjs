import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createPlugin, STATUS_SERVICE } from '../lib/index.js'
import { createTransport } from '../lib/transport.js'
import { temp, config, event, plan } from './plugin-fixture.mjs'
import { fixture, Clock, until } from './transport-fixture.mjs'
import { identity, PLATFORM } from '../lib/config.js'

test('real Cordis assembly: complete-turn fixture to local HTTP/WS and scoped ack', async t => {
  const root = temp(t), c = config(root), clock = new Clock()
  const server = await fixture(t)
  const ctx = new Context()
  const injections = [], leased = [], acked = []
  let plans = [], notify = null, registered = 0, disposed = 0, agents = 0
  ctx.provide('agents', { create: () => { agents++; throw Error('new_agent_forbidden') } })
  ctx.provide('echo:relay', {
    inject: async envelope => { injections.push(envelope); plans = [plan(c)]; notify?.(); return { ok: true, accepted: true, sessionId: 'existing-companion' } },
    registerChannel: () => { registered++; return () => { disposed++ } },
    subscribeOutbound: fn => { notify = fn; return () => { notify = null } },
    lease: () => { throw Error('legacy_lease_forbidden') }, ack: () => { throw Error('legacy_ack_forbidden') },
    officialC2c: { version: 1, contract: 'complete-turn-v1',
      leaseReplies: async scope => { leased.push(scope); return { plans: [...plans] } },
      ackReplies: async scope => { acked.push(scope); plans = []; return { ok: true, ids: scope.ids } }
    }
  })
  const plugin = createPlugin({ clock, transportFactory: opts => createTransport({ ...opts, testEndpoints: server.testEndpoints }) })
  const fiber = ctx.plugin(plugin, c)
  await fiber
  const status = ctx.get(STATUS_SERVICE)
  await status.ready
  await until(() => status.status().connected)
  server.send(event(c))
  await until(() => injections.length === 1)
  await new Promise(r => setTimeout(r, 10))
  await clock.advance(1000)
  await until(() => acked.length === 1)
  assert.equal(server.posts().length, 1)
  assert.equal(server.posts()[0].body.msg_id, 'synthetic-in-1')
  assert.equal(injections[0].platform, PLATFORM)
  assert.equal(injections[0].chat.id, identity(c.appId, c.ownerBinding.userOpenid))
  assert.equal(agents, 0)
  assert.equal(registered, 1)
  assert.ok(leased.every(s => s.platform === PLATFORM && s.kind === 'reply'))
  // Cordis lifecycle, not just a hand-rolled context disposer.
  await fiber.dispose()
  assert.equal(disposed, 1)
  assert.equal(notify, null)
  assert.equal(clock.timers.size, 0)
  assert.equal(ctx.get(STATUS_SERVICE), undefined)
  assert.equal(existsSync(join(c.stateDir, '.writer-lock')), false)
})

test('real Cordis with the current basic service has zero connection and no channel side effect', async t => {
  const root = temp(t), c = config(root), ctx = new Context()
  let registration = 0, connections = 0
  ctx.provide('echo:relay', { inject: async () => ({ ok: true }), registerChannel: () => { registration++; return () => {} }, lease () { throw Error('forbidden') }, ack () { throw Error('forbidden') } })
  const fiber = ctx.plugin(createPlugin({ transportFactory: () => { connections++; throw Error('forbidden') } }), c)
  await fiber
  const s = ctx.get(STATUS_SERVICE); await s.ready
  assert.equal(s.status().code, 'context')
  assert.equal(registration + connections, 0)
  assert.equal(existsSync(c.stateDir), false)
  await fiber.dispose()
})

test('current contract migration: generic official ingress is side-effect-free reserved; legacy qq keeps original companion and outbox', async t => {
  const root = temp(t), c = config(root)
  const coreHome = join(root, 'isolated-core')
  const coreData = join(coreHome, 'echo')
  mkdirSync(coreData, { recursive: true })
  // Set both explicit and fallback overrides BEFORE any core dynamic import.
  process.env.ECHO_DATA_DIR = coreData
  process.env.DSH_HOME = coreHome
  process.env.ECHO_DB = join(coreData, 'DO-NOT-OPEN.db')
  writeFileSync(join(coreData, 'config.json'), JSON.stringify({ newSessionOn: { qq: false, other: false } }))
  const { createRelay } = await import('../../../dsh-memory-agent/lib/relay.js')
  const { CONFIG_PATH } = await import('../../../dsh-memory-agent/lib/toggle.js')
  const rel = relative(coreData, CONFIG_PATH)
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel))
  const channels = [], outbox = [], seen = new Set(), accepted = [], storeReads = []
  let ensured = 0, configReads = 0, gateReads = 0
  const originalAgent = { marker: 'existing-agent' }
  const fakeStore = {
    relayBeginInbound: x => ({ duplicate: seen.has(x.msgId) }),
    relayCommitInbound: x => { seen.add(x.msgId); return true }, relayRollbackInbound: () => true,
    relayUpsertChannel: ch => { channels.push({ ...ch, enabled: 1, proactive: 1 }); return ch },
    relayCancelBubbles: () => ({ rows: 0 }),
    relayChannelsOfSession: sid => channels.filter(c => c.sessionId === sid), relayListChannels: () => channels,
    relayEnqueue: row => { outbox.push(row); return { ok: true } },
    relayLeaseOutbox: ({ platform }) => ({ items: outbox.filter(r => r.platform === platform).map((r, i) => ({ id: i + 1, chatId: r.chatId, kind: r.kind, text: r.text, turnId: r.turnId, createdAt: 1000, notBefore: r.notBefore, groupId: r.groupId, seq: r.seq, chatType: 'private' })) })
  }
  const observedStore = new Proxy(fakeStore, {
    get (target, property, receiver) { storeReads.push(String(property)); return Reflect.get(target, property, receiver) }
  })
  const relay = createRelay({ store: observedStore, config: () => {
    configReads++
    return { sessionId: 'original-companion', permissionPreset: 'off', autoReplyToOrigin: true, proactiveScope: 'off', bubble: { enabled: false } }
  },
    now: () => 1000, isEnabled: () => { gateReads++; return true },
    ensureCompanion: async () => { ensured++; return { sessionId: 'original-companion', agent: originalAgent, via: 'existing' } },
    injectInbound: async (agent, env) => { assert.equal(agent, originalAgent); accepted.push({ agent, env }); return 'ok' }
  })
  // Approved migration: this otherwise valid old envelope must be rejected
  // before even reading a legacy store method or evaluating config/permission.
  const official = { v: 1, platform: PLATFORM, chat: { id: identity(c.appId, c.ownerBinding.userOpenid), type: 'private' }, sender: { id: 'synthetic-bound-owner', isMaster: true }, text: 'synthetic input', msgId: 'original-official-msg', ts: 1000 }
  const refused = await relay.handleInbound(official)
  assert.equal(refused.status, 403)
  assert.deepEqual(refused.body, { ok: false, reason: 'reserved-platform' })
  assert.deepEqual(storeReads, [])
  assert.equal(configReads, 0)
  assert.equal(gateReads, 0)
  assert.equal(ensured, 0)
  assert.deepEqual(accepted, [])
  assert.deepEqual(channels, [])
  assert.deepEqual(outbox, [])
  assert.equal(seen.size, 0)

  // Positive control uses the same real relay, fake store and original Agent:
  // rejecting every platform or breaking the old QQ queue cannot pass this.
  const originalMsg = 'original-legacy-msg'
  const legacy = { ...official, platform: 'qq', chat: { id: 'synthetic-legacy-private-chat', type: 'private' }, msgId: originalMsg }
  const response = await relay.handleInbound(legacy)
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.sessionId, 'original-companion')
  assert.equal(ensured, 1)
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].agent, originalAgent)
  assert.equal(accepted[0].env.msgId, originalMsg)
  assert.equal(accepted[0].env.platform, 'qq')
  assert.equal(accepted[0].env.text, legacy.text)
  assert.equal(channels.length, 1)
  assert.equal(channels[0].platform, 'qq')
  assert.equal(channels[0].chatId, legacy.chat.id)
  assert.equal(channels[0].sessionId, 'original-companion')
  assert.equal(seen.has(originalMsg), true)
  assert.equal(seen.has(official.msgId), false)
  relay.captureSegment('original-companion', 'synthetic legacy core reply')
  const result = relay.finishTurn('original-companion')
  assert.equal(result.queued, 1)
  assert.equal(outbox.length, 1)
  assert.equal(outbox[0].platform, 'qq')
  assert.equal(outbox[0].chatId, legacy.chat.id)
  const leased = relay.lease({ platform: 'qq' })
  assert.equal(leased.items.length, 1)
  const row = leased.items[0]
  assert.equal(row.kind, 'reply')
  assert.equal(row.chatId, legacy.chat.id)
  assert.equal(row.text, 'synthetic legacy core reply')
  assert.equal(typeof row.turnId, 'string')
  assert.ok(row.turnId.length > 0)
  assert.ok(storeReads.includes('relayBeginInbound'))
  assert.ok(storeReads.includes('relayCommitInbound'))
  assert.ok(storeReads.includes('relayUpsertChannel'))
  assert.ok(storeReads.includes('relayEnqueue'))
  assert.ok(storeReads.includes('relayLeaseOutbox'))
  assert.equal(existsSync(process.env.ECHO_DB), false)
})
