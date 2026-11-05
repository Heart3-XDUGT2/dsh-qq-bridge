import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createOwnerPairing, runOwnerSetup } from '../lib/owner-pairing.js'
import { createTransport } from '../lib/transport.js'
import { fixture, until, Clock } from './transport-fixture.mjs'
import { rootFor } from './echo025-fixture.mjs'

const offer = (pairing, text = pairing.challenge().text, owner = 'SYNTHETIC_OWNER_OPENID_A', appId = 'synthetic-app') =>
  pairing.offer({ appId, event: { t: 'C2C_MESSAGE_CREATE', d: { content: text, author: { user_openid: owner } } } })

test('025 pairing: 256-bit nonce, fixed AppID, no first-message auto owner, local confirmation one-shot', () => {
  const clock = new Clock(), p = createOwnerPairing({ appId: 'synthetic-app', clock })
  assert.match(p.challenge().text, /^ECHO-PAIR:[A-Za-z0-9_-]{43}$/)
  assert.equal(offer(p, 'hello').candidate, false)
  assert.equal(offer(p, p.challenge().text, 'SYNTHETIC_OWNER_OPENID_A', 'wrong-app').candidate, false)
  assert.equal(offer(p, p.challenge().text, '123456789').candidate, false)
  const candidate = offer(p)
  assert.equal(candidate.candidate, true)
  assert.equal(Object.hasOwn(candidate, 'userOpenid'), false)
  assert.throws(() => p.confirm('yes'), /local_confirmation/)
  const authorized = p.confirm('CONFIRM ' + candidate.fingerprint)
  assert.equal(authorized.authorized, true)
  assert.equal(authorized.userOpenid, 'SYNTHETIC_OWNER_OPENID_A')
  assert.throws(() => p.confirm('CONFIRM ' + candidate.fingerprint), /local_confirmation/)
  assert.ok(!JSON.stringify(p.status()).includes(authorized.userOpenid))
  assert.ok(!JSON.stringify(p.status()).includes(p.challenge().text))
})
test('025 pairing: expiry and conflicting nonce holder cannot be silently confirmed', () => {
  const clock = new Clock(), p = createOwnerPairing({ appId: 'synthetic-app', clock, ttlMs: 1000 })
  const first = offer(p)
  assert.equal(offer(p, p.challenge().text, 'SYNTHETIC_OTHER_OWNER').conflict, true)
  assert.throws(() => p.confirm('CONFIRM ' + first.fingerprint), /local_confirmation/)
  const q = createOwnerPairing({ appId: 'synthetic-app', clock, ttlMs: 1000 }), candidate = offer(q)
  clock.time += 1000
  assert.equal(q.status().phase, 'expired')
  assert.throws(() => q.confirm('CONFIRM ' + candidate.fingerprint), /local_confirmation/)
  assert.equal(offer(q).candidate, false)
})
test('025 CLI preparation: temporary credentials + real loopback protocol, local confirmation writes disabled draft only', async t => {
  const local = rootFor(t); t.after(local.cleanup)
  const protocol = await fixture(t), credentials = join(local.root, 'synthetic-credentials.json'), output = join(local.root, 'synthetic-owner.json')
  writeFileSync(credentials, JSON.stringify({ appId: 'synthetic-app', appSecret: 'SYNTHETIC_PAIRING_SECRET' }))
  const printed = []
  const run = runOwnerSetup({
    configPath: credentials, outputPath: output, print: line => printed.push(line),
    ask: async question => 'CONFIRM ' + question.match(/CONFIRM ([a-f0-9]{12})/)[1],
    transportFactory: opts => createTransport({ ...opts, testEndpoints: protocol.testEndpoints })
  })
  await until(() => protocol.connections[0]?.received.some(p => p.op === 2))
  const challenge = printed.find(x => x.startsWith('ECHO-PAIR:'))
  protocol.send({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'synthetic-pairing-in', content: 'not the nonce', author: { user_openid: 'SYNTHETIC_OTHER_OWNER' } } })
  protocol.send({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'synthetic-pairing-owner', content: challenge, author: { user_openid: 'SYNTHETIC_OWNER_OPENID_A' } } })
  const result = await run, draft = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(result.ok, true); assert.equal(result.enabled, false)
  assert.equal(draft.ownerBinding.userOpenid, 'SYNTHETIC_OWNER_OPENID_A')
  assert.equal(Object.hasOwn(draft, 'appSecret'), false)
  assert.equal(protocol.posts().length, 0)
  assert.ok(!printed.join('\n').includes('SYNTHETIC_PAIRING_SECRET'))
  assert.ok(!printed.join('\n').includes('SYNTHETIC_OWNER_OPENID_A'))
  assert.equal(existsSync(join(local.root, 'owner-mvp')), false)
})
test('025 setup refuses silent overwrite or absent local confirmation', async t => {
  const local = rootFor(t); t.after(local.cleanup)
  const credentials = join(local.root, 'config.json'), output = join(local.root, 'existing.json')
  writeFileSync(credentials, JSON.stringify({ appId: 'synthetic-app', appSecret: 'synthetic' }))
  writeFileSync(output, 'keep original')
  await assert.rejects(runOwnerSetup({ configPath: credentials, outputPath: output, ask: async () => '' }), /pairing_paths/)
  assert.equal(readFileSync(output, 'utf8'), 'keep original')
})
