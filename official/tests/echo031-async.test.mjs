import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createOwnerTextPlugin } from '../lib/owner-text.js'
import { openManagedMvpJournal } from '../lib/managed-journal.js'
import { openMvpJournal } from '../lib/mvp-journal.js'
import { rootFor, configFor, stubService, gate } from './echo025-fixture.mjs'
import { until } from './transport-fixture.mjs'
import { scope } from './echo031-fixture.mjs'

function mount (t, options = {}) {
  const local = rootFor(t), raw = configFor(local.root), f = stubService(options)
  const services = new Map([['echo:relay', f.service]]), logs = []
  let network = 0
  createOwnerTextPlugin({
    ...(options.journalFactory ? { journalFactory: options.journalFactory } : {}),
    transportFactory: () => { network++; throw Error('network_must_not_start') }
  }).apply({
    get: key => services.get(key), provide: (key, value) => { services.set(key, value) }, effect: () => {},
    logger: { warn: line => logs.push(line) }
  }, raw)
  const controller = services.get('echo:official-c2c')
  return { ...local, ...f, raw, services, logs, controller, network: () => network }
}
for (const action of ['dispose', 'disable', 'service']) {
  test('031 managed initialization held during ' + action + ' retains ownership until late resource closes', async t => {
    const entered = gate(), go = gate()
    const f = mount(t, { journalFactory: (dir, s, opts) => openManagedMvpJournal(dir, s, {
      ...opts, onStage: async stage => { if (stage === 'journal-opened') { entered.resolve(); await go.promise } }
    }) })
    t.after(async () => { go.resolve(); await f.controller.ready; await f.controller.dispose({ timeoutMs: 100 }); f.cleanup() })
    await entered.promise
    const lock = join(f.raw.stateDir, '.writer-lock')
    assert.equal(existsSync(lock), true)
    if (action === 'dispose') {
      const r = await f.controller.dispose({ timeoutMs: 0 })
      assert.equal(r.drained, false); assert.equal(r.lockRetained, true); assert.equal(r.ledgerLockReleased, false)
    } else if (action === 'disable') f.raw.enabled = false
    else f.services.set('echo:relay', stubService().service)
    await assert.rejects(openManagedMvpJournal(f.raw.stateDir, scope), e => e.code === 'storage_busy')
    assert.equal(f.data.bindings.length, 0); assert.equal(f.network(), 0)
    go.resolve(); await f.controller.ready
    await until(() => !existsSync(lock))
    assert.equal(f.controller.status().enabled, false)
    assert.equal(f.data.bindings.length, 0); assert.equal(f.network(), 0)
    const next = await openManagedMvpJournal(f.raw.stateDir, scope); await next.close({ drained: true })
  })
}
for (const action of ['dispose', 'disable', 'service']) {
  test('031 actual default managed factory reaps binding that arrives after ' + action, async t => {
    const entered = gate(), go = gate(), closing = gate(), closeGo = gate()
    const f = stubService({ closeHook: async () => { closing.resolve(); await closeGo.promise; return { drained: true } } })
    const original = f.service.officialOwnerText.openBinding
    f.service.officialOwnerText.openBinding = async args => { entered.resolve(); await go.promise; return original(args) }
    const local = rootFor(t), raw = configFor(local.root), services = new Map([['echo:relay', f.service]])
    let network = 0
    createOwnerTextPlugin({ transportFactory: () => { network++; throw Error('network_must_not_start') } }).apply({
      get: key => services.get(key), provide: (key, value) => { services.set(key, value) }, effect: () => {}
    }, raw)
    const controller = services.get('echo:official-c2c')
    t.after(async () => { go.resolve(); closeGo.resolve(); await controller.ready; await controller.dispose({ timeoutMs: 100 }); local.cleanup() })
    await entered.promise
    const lock = join(raw.stateDir, '.writer-lock')
    if (action === 'dispose') assert.equal((await controller.dispose({ timeoutMs: 10 })).drained, false)
    else if (action === 'disable') raw.enabled = false
    else services.set('echo:relay', stubService().service)
    go.resolve(); await closing.promise
    assert.equal(existsSync(lock), true)
    await assert.rejects(openManagedMvpJournal(raw.stateDir, scope), e => e.code === 'storage_busy')
    closeGo.resolve(); await controller.ready
    await until(() => !existsSync(lock), 1500)
    assert.equal(network, 0); assert.equal(controller.status().enabled, false)
    const next = await openManagedMvpJournal(raw.stateDir, scope); await next.close({ drained: true })
  })
}
for (const mode of ['legacy', 'busy']) test('031 ' + mode + ' startup failure is a fixed Chinese log plus safe controller code', async t => {
  // Synchronous compatibility factory creates an old empty lock on purpose.
  let old
  const f = mount(t, { journalFactory: async (dir, s, opts) => {
    old = mode === 'legacy' ? openMvpJournal(dir, s, opts) : await openManagedMvpJournal(dir, s, opts)
    return openManagedMvpJournal(dir, s, opts)
  } })
  t.after(async () => { await f.controller.ready; await old?.close({ drained: true }); await f.controller.dispose({ timeoutMs: 100 }); f.cleanup() })
  await f.controller.ready
  assert.equal(f.controller.status().code, mode === 'legacy' ? 'storage_legacy' : 'storage_busy')
  assert.ok(f.logs.some(line => line.includes(mode === 'legacy' ? '旧版写入锁需一次人工审核' : '无法取得写入独占')))
  assert.ok(f.logs.every(line => !line.includes(f.raw.stateDir) && !line.includes(f.raw.ownerBinding.userOpenid)))
  assert.equal(f.network(), 0); assert.equal(f.data.bindings.length, 0)
})
