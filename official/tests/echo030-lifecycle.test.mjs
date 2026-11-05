// Capture native loopback transport before the existing host fixture isolates it.
import { allowLoopback, network } from '../../../dsh-memory-agent/tests/fixtures/echo024-network.mjs'
import { coreHost, response, isolation, cleanTmp } from '../../../dsh-memory-agent/tests/fixtures/echo024-core.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOwnerTextPlugin } from '../lib/owner-text.js'
import { openMvpJournal } from '../lib/mvp-journal.js'
import { createTransport } from '../lib/transport.js'
import { fixture, until } from './transport-fixture.mjs'
import { rootFor, configFor } from './echo025-fixture.mjs'

allowLoopback()
const results = []
after(() => {
  assert.equal(network.forbidden, 0)
  assert.equal(isolation.networkAttempts, 0)
  const label = process.env.ECHO030_LABEL ?? 'manual-' + Date.now() + '-' + process.pid
  if (!/^[a-z0-9-]+$/.test(label ?? '')) throw Error('new_030_label_required')
  writeFileSync(new URL('../../.scratch/test-traces/echo-executor-030-lifecycle-' + label + '.json', import.meta.url),
    JSON.stringify({ task: 'ECHO-030', results, network, isolation }, null, 2) + '\n', { flag: 'wx' })
  cleanTmp()
})
const normal = (_request, step) => step % 2 === 0
  ? response('', [{ id: 'echo030-say-' + step, name: 'echo_qq_say', arguments: JSON.stringify({ text: 'synthetic lifecycle answer' }) }])
  : response('ordinary tail')

async function assemble (t) {
  const core = await coreHost(t, { bind: false, allowMemoryMetadata: false, script: normal })
  // Actual core cleanup is owned by the same real root, like production.
  core.h.ctx.effect(() => () => core.owner.dispose(), 'echo030.actual-core-dispose')
  const local = rootFor(t), config = configFor(local.root), server = await fixture(t)
  let journal
  const fiber = core.h.ctx.plugin(createOwnerTextPlugin({
    transportFactory: opts => createTransport({ ...opts, testEndpoints: server.testEndpoints }),
    journalFactory: (...args) => { journal = openMvpJournal(...args); return journal }
  }), config)
  await fiber
  const controller = fiber.ctx.get('echo:official-c2c')
  await controller.ready
  await until(() => controller.status().connected && controller.status().activeTasks === 0)
  const lock = join(config.stateDir, '.writer-lock')
  t.after(async () => { await controller.dispose({ timeoutMs: 100 }); local.cleanup() })
  return { core, fiber, controller, server, journal, lock, config,
    disk: () => JSON.parse(readFileSync(join(config.stateDir, 'owner-text.json'), 'utf8')),
    async confirm () {
      server.send({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: {
        id: 'synthetic-030-original', content: 'synthetic lifecycle input', timestamp: new Date().toISOString(),
        author: { user_openid: config.ownerBinding.userOpenid }
      } })
      await until(() => server.posts().length === 1)
      await until(() => {
        const a = Object.values(this.disk().anchors)[0]
        return a?.state === 'confirmed' && a.coreSettled && controller.status().activeTasks === 0
      })
      await core.h.agent.whenIdle()
    }
  }
}

for (const stage of ['idle', 'confirmed']) {
  for (const scope of ['plugin', 'root']) test('030 real Cordis ' + scope + ' disposal releases ' + stage + ' journal after actual core drain', async t => {
    const f = await assemble(t)
    if (stage === 'confirmed') await f.confirm()
    assert.equal(existsSync(f.lock), true)
    const before = f.disk(), started = Date.now()
    if (scope === 'plugin') await f.fiber.dispose()
    else await f.core.h.ctx.fiber.dispose()
    const proof = {
      stage, scope, elapsedMs: Date.now() - started,
      lockRemains: existsSync(f.lock), journal: f.journal.status(), adapter: f.controller.status(),
      beforeAnchorStates: Object.values(before.anchors).map(a => ({ state: a.state, coreSettled: a.coreSettled, attempts: a.attempts.length })),
      afterAnchorStates: Object.values(f.disk().anchors).map(a => ({ state: a.state, coreSettled: a.coreSettled, attempts: a.attempts.length })),
      posts: f.server.posts().length, originalSessionId: f.core.h.agent.session.id
    }
    results.push(proof)
    assert.equal(proof.lockRemains, false)
    assert.equal(proof.journal.closed, true)
    assert.equal(proof.adapter.activeTasks, 0)
    assert.deepEqual(proof.afterAnchorStates, proof.beforeAnchorStates)
    assert.equal(proof.posts, stage === 'confirmed' ? 1 : 0)
    assert.throws(() => f.journal.change(() => {}), /storage_unavailable/)
  })
}
