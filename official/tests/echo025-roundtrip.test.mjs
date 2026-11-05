// Network natives must be captured BEFORE the host fixture installs isolation.
import { allowLoopback, network } from '../../../dsh-memory-agent/tests/fixtures/echo024-network.mjs'
import { coreHost, response, isolation, traces, cleanTmp } from '../../../dsh-memory-agent/tests/fixtures/echo024-core.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTransport } from '../lib/transport.js'
import { createOwnerTextPlugin } from '../lib/owner-text.js'
import { fixture, until, Clock } from './transport-fixture.mjs'
import { rootFor, configFor, eventFor } from './echo025-fixture.mjs'

allowLoopback()
const results = []
after(() => {
  assert.equal(network.forbidden, 0)
  assert.equal(isolation.networkAttempts, 0)
  const label = process.env.ECHO025_TRACE_LABEL ?? 'manual-' + Date.now() + '-' + process.pid
  if (!/^[a-z0-9-]+$/.test(label ?? '')) throw Error('new_trace_label_required')
  writeFileSync(new URL('../../.scratch/test-traces/echo-executor-025-core-trace-' + label + '.json', import.meta.url),
    JSON.stringify({ network, isolation, results, actualHostTraces: traces }, null, 2) + '\n', { flag: 'wx' })
  cleanTmp()
})
const call = (id, text) => ({ id: 'echo025-call-' + id, name: 'echo_qq_say', arguments: JSON.stringify({ text }) })
const normal = (_request, index) => index % 2 === 0
  ? response('ordinary assistant text must not be sent', [call(index + '-one', '第一段合成回复'), call(index + '-two', '第二段合成回复')])
  : response('ordinary tail must not be appended')

async function assembled (t, { script = normal, outcomes, transportOptions = {}, coreOptions = {}, protocolOptions = {}, decorateBinding } = {}) {
  const core = await coreHost(t, { bind: false, allowMemoryMetadata: false, script, ...coreOptions })
  const local = rootFor(t), raw = configFor(local.root), clock = new Clock(), protocol = await fixture(t, protocolOptions)
  if (outcomes) protocol.replies.push(...outcomes)
  const statuses = new Map(), disposers = []
  let wireBinding
  const actualCap = core.service
  // The factory service and all binding behavior are real. This wrapper records
  // the actual returned binding without substituting inject/take/confirm logic.
  const recordedCap = { ...actualCap, openBinding: async value => {
    const actual = await actualCap.openBinding(value)
    wireBinding = decorateBinding ? decorateBinding(actual) : actual
    return wireBinding
  } }
  const relayService = { officialOwnerText: recordedCap, registerChannel: () => { throw Error('generic_registration_forbidden') } }
  const ctx = {
    get: key => key === 'echo:relay' ? relayService : statuses.get(key),
    provide: (key, value) => { statuses.set(key, value); return () => statuses.delete(key) },
    effect: fn => { disposers.push(fn()) }
  }
  createOwnerTextPlugin({ clock, transportFactory: opts => createTransport({ ...opts, ...transportOptions, testEndpoints: protocol.testEndpoints }) }).apply(ctx, raw)
  const controller = statuses.get('echo:official-c2c')
  await controller.ready; await until(() => controller.status().connected)
  t.after(async () => {
    await controller.dispose({ timeoutMs: 500 })
    for (const fn of disposers.reverse()) await fn()
    local.cleanup()
  })
  const f = { core, raw, clock, protocol, controller, get binding () { return wireBinding },
    log: () => JSON.parse(readFileSync(join(raw.stateDir, 'owner-text.json'), 'utf8')),
    async receive (id, seq = 2, extra = {}) { protocol.send({ ...eventFor(raw, id, '主人合成来信', extra), s: seq }) },
    async firstPost (count = 1) {
      await until(() => core.h.requests.length >= count * 2)
      await core.h.agent.whenIdle()
      for (let i = 0; i < 100 && protocol.posts().length < count; i++) {
        // A held HTTP deliberately keeps poll pending; drive without awaiting
        // that send task, then observe the real local server's boundary.
        void controller.poll()
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      await until(() => protocol.posts().length >= count)
    },
    async posted (count = 1) {
      await until(() => core.h.requests.length >= count * 2)
      await core.h.agent.whenIdle()
      for (let i = 0; i < 100 && protocol.posts().length < count; i++) { await controller.poll(); await new Promise(resolve => setTimeout(resolve, 2)) }
      await until(() => protocol.posts().length >= count)
      await until(() => Object.values(f.log().anchors).filter(a => a.state === 'confirmed' && a.coreSettled).length >= count)
    } }
  results.push({ case: t.name, agentId: core.h.agent.id, sessionId: core.h.agent.session.id,
    actualFactory: 'dsh-echo/lib/official-owner-text.js:createOfficialOwnerText',
    actualComponents: ['official-input', 'official-turns (020-R1)', 'official-c2c-codec (023)', 'relayToolDefinitions:echo_qq_say'],
    journal: 'openMvpJournal:durable-metadata', protocol: 'real loopback HTTP/WS', originalAgents: core.h.ctx.agents.list().length })
  return f
}

test('025 actual core + original Agent + actual say + single disk journal + real local HTTP/WS complete roundtrip', async t => {
  const f = await assembled(t)
  const original = f.core.h.agent
  await f.receive('synthetic-real-in-1'); await f.posted()
  const post = f.protocol.posts()[0], state = f.log(), anchor = Object.values(state.anchors)[0]
  assert.deepEqual(post.body, { content: '第一段合成回复\n第二段合成回复', msg_type: 0, msg_id: 'synthetic-real-in-1', msg_seq: 1 })
  assert.equal(anchor.state, 'confirmed'); assert.equal(anchor.attempts.length, 1); assert.equal(anchor.coreSettled, true)
  assert.equal(Object.values(state.metadata)[0].everAccepted, true)
  assert.equal(Object.values(state.metadata)[0].ownerText.outcome, 'confirmed')
  assert.equal(Object.values(state.metadata)[0].receipt.hostMessageId,
    f.core.h.agent.session.snapshotEvents(0).find(e => e.type === 'user/message').data.id)
  assert.equal(f.core.h.agent, original); assert.equal(f.core.h.ctx.agents.list().length, 1)
  assert.equal(f.core.oldCalls.length, 0); assert.equal(f.core.oldAuto.length, 0)
  assert.ok(f.core.rendered.every(r => r.value.sent === 0 && r.value.deliveryStatus === 'pending_turn_end'))
  await f.receive('synthetic-real-in-1', 3); await f.controller.poll()
  assert.equal(f.protocol.posts().length, 1); assert.equal(f.core.h.requests.length, 2)
  await f.receive('synthetic-real-in-2', 4); await f.posted(2)
  assert.equal(f.core.h.agent, original)
  assert.equal(f.protocol.posts()[1].body.msg_id, 'synthetic-real-in-2')
  const final = f.log()
  results.at(-1).roundtripProof = {
    sameOriginalAgentObject: f.core.h.agent === original,
    originalAgentCount: f.core.h.ctx.agents.list().length,
    applicationPosts: f.protocol.posts().map(p => p.body),
    anchors: Object.values(final.anchors).map(a => ({
      rawMsgId: a.rawMsgId, state: a.state, attempts: a.attempts, coreSettled: a.coreSettled,
      replyId: a.reply?.replyId, sourceKey: a.reply?.sourceKey
    })),
    acceptedMetadata: Object.values(final.metadata).map(r => ({
      sourceKey: r.sourceKey, inboundKey: r.inboundKey, everAccepted: r.everAccepted,
      admissionReceiptId: r.receipt?.id, hostMessageId: r.receipt?.hostMessageId, ownerTextOutcome: r.ownerText?.outcome
    })),
    legacyRouteCalls: f.core.oldCalls.length,
    ordinaryAssistantBodyIncluded: f.protocol.posts().some(p => p.body.content.includes('ordinary'))
  }
})
test('025 actual core/transport: one 429 retries original body/msg_seq and confirms once', async t => {
  const f = await assembled(t, { outcomes: [{ status: 429, body: {}, headers: { 'Retry-After': '1' } }] })
  await f.receive('synthetic-real-429')
  await f.firstPost()
  await until(() => Object.values(f.log().anchors)[0]?.state === 'rate_limited')
  await f.clock.advance(1000); await f.posted()
  assert.equal(f.protocol.posts().length, 2)
  assert.deepEqual(f.protocol.posts()[0].body, f.protocol.posts()[1].body)
  const a = Object.values(f.log().anchors)[0]
  assert.deepEqual(a.attempts.map(x => x.state), ['rate_limited', 'confirmed'])
  assert.equal(a.coreSettled, true)
})
test('025 actual core/transport: POST timeout records unknown, never retries same original', async t => {
  const f = await assembled(t, { outcomes: [{ hold: true }] })
  await f.receive('synthetic-real-timeout')
  await f.firstPost()
  await f.clock.advance(10000)
  await until(() => Object.values(f.log().anchors)[0]?.state === 'unknown')
  await f.controller.poll(); await f.clock.advance(1000)
  assert.equal(f.protocol.posts().length, 1)
  assert.equal(Object.values(f.log().anchors)[0].attempts.length, 1)
})
test('025 actual core: no tool/oversize merged reply produces zero platform POST', async t => {
  for (const script of [
    () => response('ordinary body only'),
    (_request, index) => index % 2 === 0 ? response('', [0, 1, 2, 3].map(i => call('long-' + i, 'x'.repeat(500)))) : response()
  ]) {
    const f = await assembled(t, { script })
    await f.receive('synthetic-real-no-send')
    await until(() => f.core.h.requests.length > 0); await f.core.quiet(); await f.controller.poll()
    assert.equal(f.protocol.posts().length, 0)
    if (f.binding.status().reason === 'official_reply_too_long') assert.equal(f.controller.status().code, 'budget')
  }
})
test('025 actual core + Resume: accepted response loss replays before RESUMED without another model or early POST', async t => {
  let lost = false, resumeSocket, resumeRequest
  const f = await assembled(t, {
    decorateBinding: actual => ({ ...actual, inject: async (...args) => {
      const receipt = await actual.inject(...args)
      if (!lost) { lost = true; throw Error('synthetic_accepted_response_lost') }
      return receipt
    } }),
    protocolOptions: { onResume: (socket, request) => { resumeSocket = socket; resumeRequest = request } }
  })
  await f.receive('synthetic-real-resume')
  await until(() => lost && !f.controller.status().connected)
  await f.clock.advance(250)
  await until(() => resumeSocket)
  assert.equal(resumeRequest.d.seq, 1)
  resumeSocket.send(JSON.stringify(eventFor(f.raw, 'synthetic-real-resume', '主人合成来信')))
  await until(() => Object.values(f.log().inputs)[0]?.accepted === true)
  await f.core.h.agent.whenIdle(); await f.controller.poll()
  assert.equal(f.protocol.posts().length, 0)
  assert.equal(f.core.h.requests.length, 2)
  resumeSocket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 2, d: null }))
  await until(() => f.controller.status().connected)
  await f.posted()
  assert.equal(f.protocol.posts().length, 1)
  assert.equal(f.protocol.posts()[0].body.msg_id, 'synthetic-real-resume')
  assert.equal(f.core.h.requests.length, 2)
})
test('025 actual core: confirmation response loss retries actual confirmation without duplicate POST', async t => {
  let lost = false, calls = 0
  const f = await assembled(t, { decorateBinding: actual => ({ ...actual, confirmReply: async args => {
    calls++
    const result = await actual.confirmReply(args)
    if (!lost && args.outcome === 'confirmed') { lost = true; throw Error('synthetic_actual_confirmation_response_lost') }
    return result
  } }) })
  await f.receive('synthetic-real-confirm-loss')
  await f.firstPost()
  await until(() => lost)
  await f.controller.poll()
  await until(() => Object.values(f.log().anchors)[0]?.coreSettled === true)
  assert.ok(calls >= 2)
  assert.equal(f.protocol.posts().length, 1)
  assert.equal(Object.values(f.log().metadata)[0].ownerText.outcome, 'confirmed')
})
test('025 actual core/transport: new accepted input aborts old in-flight reply and new original message progresses', async t => {
  const f = await assembled(t, { outcomes: [{ hold: true }] })
  await f.receive('synthetic-real-old-active'); await f.firstPost()
  await f.receive('synthetic-real-new-active', 3); await f.firstPost(2)
  await until(() => {
    const anchors = Object.values(f.log().anchors)
    return anchors.find(a => a.rawMsgId === 'synthetic-real-old-active')?.state === 'unknown' &&
      anchors.find(a => a.rawMsgId === 'synthetic-real-new-active')?.state === 'confirmed' &&
      anchors.find(a => a.rawMsgId === 'synthetic-real-new-active')?.coreSettled
  })
  assert.deepEqual(f.protocol.posts().map(p => p.body.msg_id), ['synthetic-real-old-active', 'synthetic-real-new-active'])
  assert.equal(f.core.h.ctx.agents.list().length, 1)
})
test('025 actual core/transport: disable synchronously revokes POST eligibility; in-flight outcome is unknown', async t => {
  const f = await assembled(t, { outcomes: [{ hold: true }] })
  await f.receive('synthetic-real-disable'); await f.firstPost()
  f.raw.enabled = false
  const pending = await f.controller.dispose({ timeoutMs: 0 })
  assert.equal(pending.drained, false); assert.equal(pending.lockRetained, true)
  assert.equal(f.controller.status().canSend, false)
  await until(() => Object.values(f.log().anchors)[0]?.state === 'unknown')
  const drained = await f.controller.dispose({ timeoutMs: 500 })
  assert.equal(drained.drained, true); assert.equal(drained.ledgerLockReleased, true)
  assert.equal(f.protocol.posts().length, 1)
})
for (const mode of ['token', 'rejected']) test('025 actual core/transport: ' + mode + ' result terminates without application retry', async t => {
  const f = await assembled(t, { outcomes: mode === 'token'
    ? [{ status: 401, body: { code: 11252, message: 'SYNTHETIC_SECRET_ERROR' } }]
    : [{ status: 400, body: { code: 40054004, message: 'SYNTHETIC_SECRET_ERROR' } }] })
  await f.receive('synthetic-real-' + mode); await f.firstPost()
  await until(() => ['unknown', 'rejected'].includes(Object.values(f.log().anchors)[0]?.state))
  await f.controller.poll()
  assert.equal(f.protocol.posts().length, 1)
  assert.ok(!JSON.stringify(f.controller.status()).includes('SYNTHETIC_SECRET_ERROR'))
  if (mode === 'token') assert.equal(f.controller.status().canSend, false)
  else assert.equal(Object.values(f.log().anchors)[0].state, 'rejected')
})
test('025 actual core: runtime power availability change immediately closes send eligibility', async t => {
  const f = await assembled(t)
  f.core.powerOff()
  assert.equal(f.controller.status().canSend, false)
  await f.controller.poll()
  assert.equal(f.protocol.posts().length, 0)
  await f.clock.advance(250)
  await until(() => f.controller.status().enabled === false)
})
