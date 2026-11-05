import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { temp, config } from './plugin-fixture.mjs'
import { openLedger, ledgerNamespace } from '../lib/ledger.js'

test('a real isolated helper crash leaves a writer lock and blocks automatic restart/replay', t => {
  const root = temp(t), c = config(root), namespace = ledgerNamespace(c)
  const ledgerURL = new URL('../lib/ledger.js', import.meta.url).href
  const source = `import {openLedger} from ${JSON.stringify(ledgerURL)};
const ledger = openLedger(process.argv[1], process.argv[2]);
ledger.change(d => {d.plans.synthetic = {parts:[{state:'sending',msgSeq:1,text:'synthetic'}]}});
process.exit(23);`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, c.stateDir, namespace], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(child.status, 23)
  assert.equal(child.stderr, '')
  assert.equal(existsSync(join(c.stateDir, '.writer-lock')), true)
  assert.throws(() => openLedger(c.stateDir, namespace))
  assert.equal(JSON.parse(readFileSync(join(c.stateDir, 'delivery.json'), 'utf8')).plans.synthetic.parts[0].state, 'sending')
  // No process probing, automatic lock deletion or uncertain send replay.
})
test('malformed journal fails without replacing its original bytes', t => {
  const root = temp(t), c = config(root), namespace = ledgerNamespace(c)
  const ledger = openLedger(c.stateDir, namespace)
  ledger.close()
  // The corruption is created only in this test-owned temporary directory.
  const { writeFileSync } = process.getBuiltinModule('node:fs')
  const path = join(c.stateDir, 'delivery.json')
  writeFileSync(path, '{broken')
  assert.throws(() => openLedger(c.stateDir, namespace))
  assert.equal(readFileSync(path, 'utf8'), '{broken')
  assert.equal(existsSync(join(c.stateDir, '.writer-lock')), false)
})
