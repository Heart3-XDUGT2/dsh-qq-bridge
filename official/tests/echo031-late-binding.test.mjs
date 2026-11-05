import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createOwnerTextPlugin } from '../lib/owner-text.js'
import { openMvpJournal } from '../lib/mvp-journal.js'
import { rootFor, configFor, stubService, gate } from './echo025-fixture.mjs'
import { until } from './transport-fixture.mjs'

test('031 late binding after disposal timeout automatically finishes closing without self-wait', async t => {
  const local = rootFor(t), raw = configFor(local.root)
  const entered = gate(), bindGo = gate(), closeEntered = gate(), closeGo = gate()
  const f = stubService({ closeHook: async () => { closeEntered.resolve(); await closeGo.promise; return { drained: true } } })
  const originalOpen = f.service.officialOwnerText.openBinding
  f.service.officialOwnerText.openBinding = async value => { entered.resolve(); await bindGo.promise; return originalOpen(value) }
  let journal, controller, network = 0
  const services = new Map([['echo:relay', f.service]])
  createOwnerTextPlugin({
    journalFactory: (...args) => { journal = openMvpJournal(...args); return journal },
    transportFactory: () => { network++; throw Error('network_must_not_start') }
  }).apply({ get: key => services.get(key), provide: (key, value) => { services.set(key, value) },
    effect: () => {} }, raw)
  controller = services.get('echo:official-c2c')
  t.after(async () => { bindGo.resolve(); closeGo.resolve(); await controller.ready; await controller.dispose({ timeoutMs: 100 }); local.cleanup() })
  await entered.promise
  const stopped = await controller.dispose({ timeoutMs: 10 })
  assert.equal(stopped.drained, false); assert.equal(stopped.lockRetained, true)
  const lock = join(raw.stateDir, '.writer-lock')
  assert.equal(existsSync(lock), true)
  bindGo.resolve(); await closeEntered.promise
  assert.equal(existsSync(lock), true)
  closeGo.resolve()
  await controller.ready
  // No second dispose is invoked to make this assertion pass.
  await until(() => !existsSync(lock), 1000)
  assert.equal(journal.status().closed, true)
  assert.equal(network, 0)
  const next = openMvpJournal(raw.stateDir, { ...f.data.bindings[0].scope, keyScheme: 'eqqc2c-lp32-v2' })
  assert.equal(next.status().healthy, true); next.close({ drained: true })
})
