import { allowLoopback, network } from '../../../dsh-memory-agent/tests/fixtures/echo024-network.mjs'
import { coreHost, response, isolation, cleanTmp } from '../../../dsh-memory-agent/tests/fixtures/echo024-core.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { actor, temporary } from './echo031-fixture.mjs'
import { configFor } from './echo025-fixture.mjs'
import { fixture, until } from './transport-fixture.mjs'
import { createOwnerTextPlugin } from '../lib/owner-text.js'
import { createTransport } from '../lib/transport.js'

allowLoopback()
const proofs = []
after(() => {
  assert.equal(network.forbidden, 0); assert.equal(isolation.networkAttempts, 0)
  const label = process.env.ECHO031_LABEL ?? 'manual-' + Date.now() + '-' + process.pid
  writeFileSync(new URL('../../.scratch/test-traces/echo-executor-031-core-' + label + '.json', import.meta.url),
    JSON.stringify({ task: 'ECHO-031', proofs, network, isolation }, null, 2) + '\n', { flag: 'wx' })
  cleanTmp()
})
for (const prior of ['confirmed', 'sending']) test('031 real default managed adapter recovers ' + prior + ', ignores old work, replies to a new message', async t => {
  let controller, core
  t.after(async () => { await controller?.dispose({ timeoutMs: 1000 }); await core?.owner.dispose() })
  const root = temporary(t), dir = join(root, 'journal'), old = actor(t, dir, 'seed-' + prior)
  assert.equal((await old.result()).event, 'ready')
  const originalBytes = readFileSync(join(dir, 'owner-text.json'))
  await old.force()
  core = await coreHost(t, { bind: false, allowMemoryMetadata: false,
    script: (_request, index) => index === 0
      ? response('', [{ id: 'echo031-real-say', name: 'echo_qq_say', arguments: JSON.stringify({ text: 'synthetic recovered answer' }) }])
      : response('ordinary tail must not send') })
  core.h.ctx.effect(() => () => core.owner.dispose(), 'echo031.real-core-close')
  const server = await fixture(t), raw = { ...configFor(root), stateDir: dir }
  const plugin = core.h.ctx.plugin(createOwnerTextPlugin({
    // Journal factory is deliberately NOT injected: this is the real default.
    transportFactory: opts => createTransport({ ...opts, testEndpoints: server.testEndpoints })
  }), raw)
  await plugin
  controller = plugin.ctx.get('echo:official-c2c')
  await controller.ready; await until(() => controller.status().connected && controller.status().activeTasks === 0)
  const disk = () => JSON.parse(readFileSync(join(dir, 'owner-text.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(dir, '.writer-lock'), 'utf8'))
  assert.equal(lock.protocol, 'echo-owner-writer-v1')
  assert.equal(Object.values(disk().anchors)[0].state, prior === 'sending' ? 'unknown' : 'confirmed')
  assert.equal(disk().pendingClaim?.key.startsWith('mvp_claim_'), true) // fresh poll, never the old claim
  assert.equal(core.h.requests.length, 0); assert.equal(server.posts().length, 0)
  const archive = readdirSync(dir).filter(p => p.startsWith('recovery-'))
  assert.equal(archive.length, 1)
  assert.deepEqual(readFileSync(join(dir, archive[0], 'owner-text.json')), originalBytes)
  const event = (id, content, seq) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', s: seq, d: {
    id, content, timestamp: new Date().toISOString(), author: { user_openid: raw.ownerBinding.userOpenid }
  } })
  server.send(event('synthetic-031-old', 'synthetic old input', 2))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(core.h.requests.length, 0); assert.equal(server.posts().length, 0)
  server.send(event('synthetic-031-new', 'synthetic new input', 3))
  await until(() => server.posts().length === 1)
  await until(() => Object.values(disk().anchors).some(a => a.rawMsgId === 'synthetic-031-new' && a.state === 'confirmed' && a.coreSettled))
  await core.h.agent.whenIdle()
  assert.equal(core.h.ctx.agents.list().length, 1); assert.equal(core.h.requests.length, 2)
  assert.deepEqual(server.posts()[0].body, { content: 'synthetic recovered answer', msg_type: 0, msg_id: 'synthetic-031-new', msg_seq: 1 })
  assert.equal(disk().dispatchHistory.length, 2)
  assert.equal(core.oldCalls.length, 0)
  proofs.push({ prior, originalArchiveMatches: true, oldModelWork: 0, oldPosts: 0, newPosts: 1,
    originalAgentCount: 1, actualModelSteps: core.h.requests.length, newCoreSettled: true, historyKept: true,
    oldFinalState: Object.values(disk().anchors).find(a => a.rawMsgId === 'synthetic-031-old').state })
  const closed = await controller.dispose({ timeoutMs: 1000 })
  assert.equal(closed.drained, true); assert.equal(closed.ledgerLockReleased, true)
  assert.equal(existsSync(join(dir, '.writer-lock')), false)
})
