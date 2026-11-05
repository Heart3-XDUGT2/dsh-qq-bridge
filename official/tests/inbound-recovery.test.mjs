import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createPlugin, STATUS_SERVICE } from '../lib/index.js'
import { createTransport } from '../lib/transport.js'
import { openLedger } from '../lib/ledger.js'
import { config, event, plan } from './plugin-fixture.mjs'
import { fixture, Clock, until } from './transport-fixture.mjs'

// Protocol order is deliberate: QQ's WebSocket documentation says missed
// events are replayed BEFORE RESUMED. No existing acceptance fixture is edited.
// https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
async function wire (t, { inject, ledgerFactory, interval = 45000 } = {}) {
  const root = resolve(mkdtempSync(join(tmpdir(), 'echo-018-r1-')))
  const rel = relative(resolve(tmpdir()), root)
  assert.ok(rel.startsWith('echo-018-r1-') && !rel.startsWith('..') && !isAbsolute(rel))
  const cleanup = []
  t.after(async () => {
    try { for (const fn of cleanup.reverse()) await fn() } finally {
      assert.equal(resolve(root), root)
      rmSync(root, { recursive: true, force: true })
    }
  })
  const localTest = { after: fn => cleanup.push(fn) }
  const c = config(root)
  const clock = new Clock()
  const server = await fixture(localTest, { interval })
  const ctx = new Context()
  const data = { injections: [], results: [], leases: [], acks: [], rawLease: 0, rawAck: 0, agents: 0, registered: 0, unregistered: 0, unsubscribed: 0 }
  let notify, queuedPlans = []
  const service = {
    inject: async envelope => {
      data.injections.push(envelope)
      return inject ? inject(envelope, data) : { ok: true, accepted: true, sessionId: 'synthetic-existing-companion' }
    },
    registerChannel: () => { data.registered++; return () => { data.unregistered++ } },
    subscribeOutbound: fn => { notify = fn; return () => { data.unsubscribed++; notify = null } },
    lease: () => { data.rawLease++; throw Error('unscoped_lease_forbidden') },
    ack: () => { data.rawAck++; throw Error('unscoped_ack_forbidden') },
    officialC2c: {
      version: 1, contract: 'complete-turn-v1',
      leaseReplies: async scope => { data.leases.push(scope); return { plans: [...queuedPlans] } },
      ackReplies: async scope => { data.acks.push(scope); queuedPlans = queuedPlans.filter(p => p.planKey !== scope.planKey); return { ok: true, ids: scope.ids } }
    }
  }
  let removeService = ctx.provide('echo:relay', service)
  cleanup.push(() => removeService?.())
  ctx.provide('agents', { create: () => { data.agents++; throw Error('new_agent_forbidden') } })
  const plugin = createPlugin({
    clock,
    ...(ledgerFactory ? { ledgerFactory } : {}),
    transportFactory: options => createTransport({
      ...options, testEndpoints: server.testEndpoints,
      onEvent: async payload => {
        const result = await options.onEvent(payload)
        data.results.push({ seq: payload.s, result })
        return result
      }
    })
  })
  const fiber = ctx.plugin(plugin, c)
  await fiber
  const controller = ctx.get(STATUS_SERVICE)
  cleanup.push(() => fiber.dispose())
  await controller.ready
  await until(() => controller.status().connected)
  const message = event(c, 'synthetic-r1-inbound')
  server.onResume = (socket, resume) => {
    // Send replay first, then the marker. A failed handler must not consume
    // either the original event sequence or the trailing RESUMED sequence.
    socket.send(JSON.stringify(message))
    socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: message.s, d: null }))
  }
  const journal = () => JSON.parse(readFileSync(join(c.stateDir, 'delivery.json'), 'utf8'))
  const entry = () => Object.values(journal().inbound)[0]
  function noDelivery () {
    assert.equal(server.posts().length, 0)
    assert.equal(data.acks.length, 0)
    assert.equal(data.rawAck + data.rawLease, 0)
    assert.equal(data.agents, 0)
  }
  return {
    c, clock, server, ctx, controller, fiber, service, data, message, journal, entry, noDelivery,
    notify: () => notify?.(), setPlans: plans => { queuedPlans = [...plans] },
    replaceService () { removeService(); removeService = ctx.provide('echo:relay', { ...service }) }
  }
}

test('inbound R1: pre-accept throw returns false, Resume repeats stable identity and accepts once', async t => {
  let attempts = 0, modelWork = 0
  const f = await wire(t, { inject: async () => {
    if (++attempts === 1) throw Error('synthetic-before-accept')
    modelWork++
    return { ok: true, accepted: true, sessionId: 'synthetic-existing-companion' }
  } })
  f.server.send(f.message)
  await until(() => f.data.results.length === 1)
  assert.equal(f.data.results[0].result, false, 'unaccepted event must not acknowledge gateway consumption')
  assert.equal(f.entry().accepted, false)
  await until(() => !f.controller.status().connected)
  await f.clock.advance(250)
  await until(() => attempts === 2 && f.entry().accepted && f.controller.status().connected)
  const resume = f.server.connections[1].received.find(p => p.op === 6)
  assert.equal(resume.d.seq, 1)
  assert.equal(f.data.injections[0].msgId, f.data.injections[1].msgId)
  assert.equal(f.data.injections[0].chat.id, f.data.injections[1].chat.id)
  assert.deepEqual(f.data.results.map(r => r.result), [false, true])
  assert.equal(modelWork, 1)
  assert.equal(f.controller.status().accepted, 1)
  assert.equal(f.entry().state, 'accepted')
  f.noDelivery()
})

test('inbound R1: accepted response lost is retried as duplicate without repeating model work', async t => {
  let attempts = 0, modelWork = 0
  const accepted = new Set()
  const f = await wire(t, { inject: async envelope => {
    attempts++
    if (accepted.has(envelope.msgId)) return { ok: true, accepted: false, duplicate: true, sessionId: 'synthetic-existing-companion' }
    accepted.add(envelope.msgId)
    modelWork++
    throw Error('synthetic-after-accept-response-lost')
  } })
  f.server.send(f.message)
  await until(() => f.data.results.length === 1)
  assert.equal(f.data.results[0].result, false)
  assert.equal(f.entry().accepted, false)
  await until(() => !f.controller.status().connected)
  await f.clock.advance(250)
  await until(() => f.data.results.length === 2 && f.entry().accepted && f.controller.status().connected)
  assert.equal(attempts, 2)
  assert.equal(modelWork, 1)
  assert.equal(accepted.size, 1)
  assert.equal(f.data.injections[0].msgId, f.data.injections[1].msgId)
  assert.equal(f.server.connections[1].received.find(p => p.op === 6).d.seq, 1)
  assert.equal(f.entry().state, 'accepted')
  f.server.send({ ...f.message, s: 3 })
  await until(() => f.data.results.length === 3)
  assert.equal(f.controller.status().duplicate, 1)
  assert.equal(attempts, 2)
  assert.equal(modelWork, 1)
  f.noDelivery()
})

test('inbound R1: replay before RESUMED is processed even for an explicit transient refusal', async t => {
  let attempts = 0
  const f = await wire(t, { inject: async () => {
    if (++attempts === 1) return { ok: false, reason: 'synthetic-busy' }
    return { ok: true, accepted: true, sessionId: 'synthetic-existing-companion' }
  } })
  f.server.send(f.message)
  await until(() => f.data.results.length === 1)
  assert.equal(f.data.results[0].result, false)
  await until(() => !f.controller.status().connected)
  await f.clock.advance(250)
  await until(() => attempts === 2 && f.entry().accepted && f.controller.status().connected)
  assert.equal(f.server.connections[1].received.find(p => p.op === 6).d.seq, 1)
  assert.equal(f.data.injections[0].msgId, f.data.injections[1].msgId)
  assert.deepEqual(f.data.results.map(r => r.result), [false, true])
  f.noDelivery()
})

test('inbound R1: persistent throws stop at the existing three-reconnect budget with no acceptance/send/ack', async t => {
  const f = await wire(t, { inject: async () => { throw Error('synthetic-persistent-failure') } })
  f.server.send(f.message)
  await until(() => f.data.results.length === 1)
  assert.equal(f.data.results[0].result, false)
  for (const [index, wait] of [250, 1000, 3000].entries()) {
    await until(() => !f.controller.status().connected)
    await f.clock.advance(wait)
    await until(() => f.data.results.length === index + 2)
    assert.equal(f.data.results.at(-1).result, false)
  }
  await until(() => f.controller.status().code === 'error')
  assert.equal(f.server.connections.length, 4)
  assert.equal(f.data.injections.length, 4)
  assert.equal(new Set(f.data.injections.map(e => e.msgId)).size, 1)
  assert.equal(f.controller.status().accepted, 0)
  assert.equal(f.controller.status().canSend, false)
  assert.equal(f.entry().accepted, false)
  assert.equal(f.entry().state, 'unknown')
  assert.ok(f.server.connections.slice(1).every(c => c.received.find(p => p.op === 6)?.d.seq === 1))
  await f.clock.advance(60000)
  assert.equal(f.server.connections.length, 4)
  assert.equal(f.data.injections.length, 4)
  f.noDelivery()
})

test('inbound R1: smaller trailing RESUMED sequence cannot regress successfully replayed progress', async t => {
  let attempts = 0
  const f = await wire(t, { interval: 1000, inject: async () => {
    if (++attempts === 1) return { ok: false, reason: 'synthetic-busy' }
    return { ok: true, accepted: true }
  } })
  f.server.onResume = socket => {
    socket.send(JSON.stringify(f.message))
    socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 1, d: null }))
  }
  f.server.send(f.message)
  await until(() => f.data.results.length === 1 && !f.controller.status().connected)
  await f.clock.advance(250)
  await until(() => attempts === 2 && f.entry().accepted && f.controller.status().connected)
  await f.clock.advance(1000)
  await until(() => f.server.connections[1].received.some(p => p.op === 1))
  assert.equal(f.server.connections[1].received.find(p => p.op === 1).d, 2)
  assert.equal(f.data.injections[0].msgId, f.data.injections[1].msgId)
  f.noDelivery()
})

test('inbound R1: queued reply during replay stays unsent until trailing RESUMED', async t => {
  let attempts = 0, resumeSocket, f
  f = await wire(t, { inject: async () => {
    if (++attempts === 1) return { ok: false, reason: 'synthetic-busy' }
    f.setPlans([plan(f.c, 'synthetic-r1-inbound', ['synthetic resumed answer'])])
    f.notify()
    return { ok: true, accepted: true }
  } })
  f.server.onResume = socket => { resumeSocket = socket; socket.send(JSON.stringify(f.message)) }
  f.server.send(f.message)
  await until(() => f.data.results.length === 1 && !f.controller.status().connected)
  await f.clock.advance(250)
  await until(() => attempts === 2 && f.entry().accepted)
  assert.equal(f.controller.status().connected, false)
  assert.equal(f.controller.status().canSend, false)
  f.notify()
  await f.clock.advance(1000)
  assert.equal(f.server.posts().length, 0)
  assert.equal(f.data.acks.length, 0)
  resumeSocket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 2, d: null }))
  await until(() => f.controller.status().connected && f.data.acks.length === 1)
  assert.equal(f.server.posts().length, 1)
  assert.equal(f.server.posts()[0].body.msg_id, 'synthetic-r1-inbound')
  assert.equal(f.server.posts()[0].body.msg_seq, 1)
  assert.equal(f.server.posts()[0].body.content, 'synthetic resumed answer')
  assert.equal(f.data.agents + f.data.rawAck + f.data.rawLease, 0)
})

test('inbound R1: later dispatches on a failed socket cannot skip the failed sequence before Resume', async t => {
  let resumed
  const f = await wire(t, { inject: async () => ({ ok: false, reason: 'synthetic-busy' }) })
  f.server.onResume = (socket, payload) => {
    resumed = payload
    socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: payload.d.seq, d: null }))
  }
  f.server.send(f.message)
  f.server.send({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 3, d: {} })
  f.server.send({ ...event(f.c, 'synthetic-later-on-failed-socket'), s: 4 })
  await until(() => f.data.results.length === 1 && !f.controller.status().connected)
  assert.equal(f.data.results[0].result, false)
  await f.clock.advance(250)
  await until(() => !!resumed && f.controller.status().connected)
  assert.equal(resumed.d.seq, 1)
  assert.equal(f.data.injections.length, 1)
  assert.deepEqual(f.data.results.map(r => r.seq), [2])
  assert.equal(Object.keys(f.journal().inbound).length, 1)
  f.noDelivery()
})

for (const mode of ['dispose', 'configuration-generation', 'service-replacement', 'reply-capability-replacement']) {
  test('inbound R1: late successful injection after ' + mode + ' cannot restore acceptance or sending', async t => {
    let release
    const f = await wire(t, { inject: () => new Promise(resolve => { release = resolve }) })
    f.server.send(f.message)
    await until(() => !!release)
    let disposing
    if (mode === 'dispose') disposing = f.controller.dispose()
    else if (mode === 'configuration-generation') f.c.appSecret = 'SYNTHETIC_REPLACEMENT_SECRET'
    else if (mode === 'service-replacement') f.replaceService()
    else f.service.officialC2c = { ...f.service.officialC2c }
    release({ ok: true, accepted: true, sessionId: 'synthetic-existing-companion' })
    await until(() => f.data.results.length === 1)
    assert.equal(f.data.results[0].result, false)
    if (disposing) await disposing
    else { await f.clock.advance(1000); await until(() => !f.controller.status().connected) }
    assert.equal(f.entry().accepted, false)
    assert.equal(f.controller.status().accepted, 0)
    assert.equal(f.controller.status().canSend, false)
    assert.equal(f.controller.status().connected, false)
    f.noDelivery()
  })
}

for (const when of ['before-inject', 'after-accepted']) {
  test('inbound R1: persistence failure ' + when + ' stops transport and never advances/send/ack', async t => {
    let fail = when === 'before-inject', modelWork = 0
    const f = await wire(t, {
      inject: async () => { modelWork++; fail = true; return { ok: true, accepted: true } },
      ledgerFactory: (dir, namespace) => {
        const real = openLedger(dir, namespace)
        return { ...real, change: fn => { if (fail) throw Error('synthetic-write-failure'); return real.change(fn) } }
      }
    })
    f.server.send(f.message)
    await until(() => f.data.results.length === 1)
    assert.equal(f.data.results[0].result, false)
    assert.equal(modelWork, when === 'before-inject' ? 0 : 1)
    assert.equal(f.controller.status().accepted, 0)
    assert.equal(f.controller.status().canSend, false)
    assert.equal(f.controller.status().connected, false)
    await until(() => f.controller.status().code === 'storage_error' && f.data.unregistered === 1 && f.data.unsubscribed === 1 && !existsSync(join(f.c.stateDir, '.writer-lock')))
    assert.equal(f.controller.status().code, 'storage_error')
    assert.equal(f.controller.status().enabled, false)
    assert.equal(f.data.unregistered, 1)
    assert.equal(f.data.unsubscribed, 1)
    assert.equal(Object.values(f.journal().inbound).some(e => e.accepted), false)
    await f.clock.advance(10000)
    assert.equal(f.server.connections.length, 1)
    f.noDelivery()
  })
}

test('inbound R1: READY cannot replace the trailing RESUMED marker during replay', async t => {
  const f = await wire(t, { inject: async () => ({ ok: false, reason: 'synthetic-busy' }) })
  f.server.onResume = socket => {
    socket.send(JSON.stringify({ op: 0, t: 'READY', s: 99, d: { session_id: 'SYNTHETIC_WRONG_PHASE' } }))
  }
  f.server.send(f.message)
  await until(() => f.data.results.length === 1 && !f.controller.status().connected)
  await f.clock.advance(250)
  await until(() => f.controller.status().code === 'error')
  assert.equal(f.controller.status().canSend, false)
  assert.equal(f.controller.status().accepted, 0)
  assert.equal(f.entry().accepted, false)
  assert.equal(f.server.connections[1].received.find(p => p.op === 6).d.seq, 1)
  await f.clock.advance(10000)
  assert.equal(f.server.connections.length, 2)
  f.noDelivery()
})
