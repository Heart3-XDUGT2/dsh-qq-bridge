import test from 'node:test'
import assert from 'node:assert/strict'
import { createTransport } from '../lib/transport.js'
import { fixture, until, Clock } from './transport-fixture.mjs'

const CREDS = { appId: 'SYNTHETIC_APP', appSecret: 'synthetic-secret' }
const TEXT = { openid: 'SYNTHETIC_OWNER_123', msgId: 'SYNTHETIC_INBOUND', msgSeq: 1, text: '测试文本' }
const event = (s = 2) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', s, d: { id: 'SYNTHETIC_INBOUND', author: { user_openid: TEXT.openid }, content: '测试来信' } })

async function connected (t, options = {}, serverOptions = {}) {
  const f = await fixture(t, serverOptions)
  const states = []
  const bot = createTransport({ ...CREDS, testEndpoints: f.testEndpoints, onState: code => states.push(code), ...options })
  t.after(() => bot.stop())
  assert.equal(await bot.start(), true)
  await until(() => bot.status() === 'ready')
  return { f, bot, states }
}

test('real local HTTP/WS auth, C2C dispatch, text reply and safe status', async t => {
  const received = []
  const { f, bot, states } = await connected(t, { onEvent: async p => { received.push(p); return true } })
  const auth = f.connections[0].received.find(p => p.op === 2)
  assert.equal(auth.d.token, 'QQBot synthetic-token-1')
  assert.equal(auth.d.intents, 1 << 25)
  assert.deepEqual(auth.d.shard, [0, 1])
  assert.deepEqual(f.requests[0].body, { appId: CREDS.appId, clientSecret: CREDS.appSecret })
  assert.equal(f.requests[1].headers.authorization, 'QQBot synthetic-token-1')
  assert.equal(f.posts().length, 0)
  f.send(event())
  await until(() => received.length === 1)
  assert.deepEqual(received[0], event())
  assert.deepEqual(await bot.sendText(TEXT), { kind: 'confirmed', id: 'SYNTHETIC_SENT_ID' })
  assert.deepEqual(f.posts()[0].body, { content: TEXT.text, msg_type: 0, msg_id: TEXT.msgId, msg_seq: 1 })
  assert.ok(states.every(s => ['connecting', 'ready'].includes(s)))
})

test('only C2C events are forwarded, ignored group events do not invoke the consumer', async t => {
  const received = []
  const { f } = await connected(t, { onEvent: async p => { received.push(p); return true } })
  f.send({ ...event(), t: 'GROUP_MESSAGE_CREATE' })
  f.send({ ...event(3), t: 'C2C_MSG_RECEIVE' })
  f.send(event(4))
  await until(() => received.length === 1)
  assert.equal(received[0].s, 4)
})

test('missing msg_id, out-of-budget sequence, numeric QQ and empty/oversize text never request send', async t => {
  const { f, bot } = await connected(t)
  for (const invalid of [{ msgId: '' }, { msgSeq: 0 }, { msgSeq: 5 }, { msgSeq: 1.5 }, { openid: '123456789' }, { text: '' }, { text: '🙂'.repeat(1501) }]) {
    assert.deepEqual(await bot.sendText({ ...TEXT, ...invalid }), { kind: 'rejected' })
  }
  assert.equal(f.posts().length, 0)
})

test('HTTP errors, business errors and malformed replies remain separately classified with no HTTP retry', async t => {
  const { f, bot } = await connected(t)
  const cases = [
    [{ status: 429, body: {}, headers: { 'Retry-After': '2' } }, { kind: 'rate_limited', retryAfterMs: 2000 }],
    [{ status: 429, body: {}, headers: { 'Retry-After': '9999' } }, { kind: 'rate_limited', retryAfterMs: 60000 }],
    [{ status: 200, body: { err_code: 40034100 } }, { kind: 'rate_limited', retryAfterMs: 60000 }],
    [{ status: 200, body: { err_code: 40054013 } }, { kind: 'rejected' }],
    [{ status: 200, body: { err_code: 40054004 } }, { kind: 'rejected' }],
    [{ status: 200, body: { err_code: 0, code: 40054013, id: 'NOT_SUCCESS' } }, { kind: 'rejected' }],
    [{ status: 200, body: { err_code: 40034005 } }, { kind: 'expired' }],
    [{ status: 200, body: { err_code: 40034128 } }, { kind: 'expired' }],
    [{ status: 500, body: { id: 'NOT_A_CONFIRMATION' } }, { kind: 'unknown' }],
    [{ status: 200, body: {} }, { kind: 'unknown' }],
    [{ status: 200, raw: 'not json' }, { kind: 'unknown' }],
    [{ status: 202, body: { id: 'NOT_SUCCESS', err_code: 10001 } }, { kind: 'unknown' }],
    [{ status: 200, body: { id: 'NOT_SUCCESS', err_code: 40054005 } }, { kind: 'unknown' }],
    [{ status: 403, body: { message: CREDS.appSecret } }, { kind: 'rejected' }],
    [{ disconnect: true }, { kind: 'unknown' }]
  ]
  for (const [response, expected] of cases) {
    const before = f.posts().length
    f.replies.push(response)
    assert.deepEqual(await bot.sendText(TEXT), expected)
    assert.equal(f.posts().length, before + 1)
  }
})

test('401 invalidates credentials, cancels gateway and does not automatically retry the message', async t => {
  const { f, bot } = await connected(t)
  f.replies.push({ status: 401, body: { message: 'synthetic-token-1' } })
  assert.deepEqual(await bot.sendText(TEXT), { kind: 'token' })
  assert.equal(bot.status(), 'token')
  assert.equal(f.posts().length, 1)
  assert.deepEqual(await bot.sendText(TEXT), { kind: 'rejected' })
  assert.equal(f.posts().length, 1)
})

test('documented wrong-AppID token business failure is terminal for this transport', async t => {
  const { f, bot } = await connected(t)
  f.replies.push({ status: 200, body: { err_code: 11252, message: 'SYNTHETIC_PRIVATE_ERROR' } })
  assert.deepEqual(await bot.sendText(TEXT), { kind: 'token' })
  assert.equal(bot.status(), 'token')
})

test('stop cancels an in-flight response and late success cannot be acknowledged as confirmed', async t => {
  const { f, bot } = await connected(t)
  f.replies.push({ hold: true })
  const pending = bot.sendText(TEXT)
  await until(() => !!f.heldResponse)
  bot.stop()
  f.heldResponse.res.end(JSON.stringify({ id: 'LATE_SUCCESS' }))
  assert.deepEqual(await pending, { kind: 'unknown' })
  assert.equal(bot.status(), 'stopped')
  assert.equal(await bot.start(), false)
})

test('caller AbortSignal cancels only that HTTP send and leaves its result unknown', async t => {
  const { f, bot } = await connected(t)
  const caller = new AbortController()
  f.replies.push({ hold: true })
  const pending = bot.sendText({ ...TEXT, signal: caller.signal })
  await until(() => !!f.heldResponse)
  caller.abort()
  assert.deepEqual(await pending, { kind: 'unknown' })
  assert.equal(bot.status(), 'ready')
})

test('heartbeat uses processed sequence, requires ACK, and reconnects with Resume', async t => {
  const clock = new Clock()
  const { f, bot } = await connected(t, { clock }, { interval: 100 })
  f.send(event(2))
  await new Promise(resolve => setImmediate(resolve))
  await clock.advance(100)
  await until(() => f.connections[0].received.some(p => p.op === 1))
  assert.equal(f.connections[0].received.find(p => p.op === 1).d, 2)
  await new Promise(resolve => setTimeout(resolve, 10))
  f.acknowledgeHeartbeat = false
  await clock.advance(100)
  await until(() => f.connections[0].received.filter(p => p.op === 1).length === 2)
  await clock.advance(100)
  assert.equal(bot.status(), 'connecting')
  await clock.advance(250)
  await until(() => f.connections.length === 2 && bot.status() === 'ready')
  const resume = f.connections[1].received.find(p => p.op === 6)
  assert.equal(resume.d.seq, 2)
  assert.equal(resume.d.session_id, 'SYNTHETIC_SESSION')
})

test('unaccepted C2C event does not advance Resume sequence', async t => {
  const clock = new Clock()
  let handled = 0
  const { f, bot } = await connected(t, { clock, onEvent: async () => { handled++; return false } })
  f.send(event(8))
  await until(() => handled === 1 && bot.status() === 'connecting')
  await clock.advance(250)
  await until(() => f.connections.length === 2 && bot.status() === 'ready')
  assert.equal(f.connections[1].received.find(p => p.op === 6).d.seq, 1)
})

test('already-processed sequence is not re-dispatched or used to regress Resume', async t => {
  const clock = new Clock()
  let handled = 0
  const { f, bot } = await connected(t, { clock, onEvent: async () => { handled++; return true } })
  f.send(event(5))
  f.send(event(3))
  f.send(event(5))
  await until(() => handled === 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  f.connections[0].socket.terminate()
  await until(() => bot.status() === 'connecting')
  await clock.advance(250)
  await until(() => f.connections.length === 2 && bot.status() === 'ready')
  assert.equal(handled, 1)
  assert.equal(f.connections[1].received.find(p => p.op === 6).d.seq, 5)
})

test('gateway invalid-token close refreshes token before Resume without sending application text', async t => {
  const clock = new Clock()
  const { f, bot } = await connected(t, { clock })
  f.connections[0].socket.close(4004)
  await until(() => bot.status() === 'connecting')
  await clock.advance(250)
  await until(() => f.connections.length === 2 && bot.status() === 'ready')
  assert.equal(f.tokenCalls, 2)
  assert.equal(f.connections[1].received.find(p => p.op === 6).d.token, 'QQBot synthetic-token-2')
  assert.equal(f.posts().length, 0)
})

test('missing READY reaches a bounded handshake timeout with no send permission', async t => {
  const clock = new Clock()
  const f = await fixture(t, { autoReady: false })
  const bot = createTransport({ ...CREDS, clock, testEndpoints: f.testEndpoints })
  t.after(() => bot.stop())
  assert.equal(await bot.start(), true)
  await until(() => f.connections[0]?.received.some(p => p.op === 2))
  assert.deepEqual(await bot.sendText(TEXT), { kind: 'rejected' })
  await clock.advance(15000)
  assert.equal(bot.status(), 'connecting')
  assert.equal(f.posts().length, 0)
  bot.stop()
  assert.equal(clock.timers.size, 0)
})

test('invalid-session opcode clears session, next connection Identifies rather than Resume', async t => {
  const clock = new Clock()
  const { f, bot } = await connected(t, { clock })
  f.send({ op: 9, d: false })
  await until(() => bot.status() === 'connecting')
  await clock.advance(250)
  await until(() => f.connections.length === 2 && bot.status() === 'ready')
  assert.ok(f.connections[1].received.some(p => p.op === 2))
  assert.ok(!f.connections[1].received.some(p => p.op === 6))
})

test('fatal banned close terminates, clears timers and never reconnects', async t => {
  const clock = new Clock()
  const { f, bot } = await connected(t, { clock })
  f.connections[0].socket.close(4915)
  await until(() => bot.status() === 'error')
  await clock.advance(200000)
  assert.equal(f.connections.length, 1)
  assert.equal(clock.timers.size, 0)
})

test('reconnection budget is finite across successful reconnects', async t => {
  const clock = new Clock()
  const { f, bot } = await connected(t, { clock })
  for (const [index, wait] of [250, 1000, 3000].entries()) {
    f.connections[index].socket.terminate()
    await until(() => bot.status() === 'connecting')
    await clock.advance(wait)
    await until(() => f.connections.length === index + 2 && bot.status() === 'ready')
  }
  f.connections[3].socket.terminate()
  await until(() => bot.status() === 'error')
  await clock.advance(200000)
  assert.equal(f.connections.length, 4)
  assert.equal(clock.timers.size, 0)
})

test('token refresh happens before expiry; a refresh error terminates without leaking error text', async t => {
  const clock = new Clock()
  const { f, bot } = await connected(t, { clock }, { tokenExpiry: 70, interval: 120000 })
  await clock.advance(10000)
  await until(() => f.tokenCalls === 2)
  assert.equal((await bot.sendText(TEXT)).kind, 'confirmed')
  assert.equal(f.posts().at(-1).headers.authorization, 'QQBot synthetic-token-2')
  f.tokenError = 100016
  await clock.advance(10000)
  await until(() => bot.status() === 'token')
  assert.equal(f.tokenCalls, 3)
  assert.equal(clock.timers.size, 0)
})

test('tokenProvider is injectable, no token HTTP call, and late provider result after stop cannot connect', async t => {
  const f = await fixture(t)
  let resolveToken
  const bot = createTransport({ ...CREDS, testEndpoints: f.testEndpoints, tokenProvider: ({ signal }) => new Promise(resolve => { assert.ok(signal instanceof AbortSignal); resolveToken = resolve }) })
  t.after(() => bot.stop())
  const starting = bot.start()
  await until(() => !!resolveToken)
  bot.stop()
  resolveToken({ access_token: 'synthetic-provider-token', expires_in: 7200 })
  assert.equal(await starting, false)
  assert.equal(f.requests.length, 0)
})

test('startup token failure does not open gateway or retry', async t => {
  const f = await fixture(t, { tokenError: 100016 })
  const bot = createTransport({ ...CREDS, testEndpoints: f.testEndpoints })
  t.after(() => bot.stop())
  assert.equal(await bot.start(), false)
  assert.equal(bot.status(), 'error')
  assert.equal(f.requests.length, 1)
  assert.equal(f.connections.length, 0)
})

test('non-success token HTTP status is rejected even with a token-shaped body', async t => {
  const f = await fixture(t, { tokenStatus: 500 })
  const bot = createTransport({ ...CREDS, testEndpoints: f.testEndpoints })
  t.after(() => bot.stop())
  assert.equal(await bot.start(), false)
  assert.equal(f.connections.length, 0)
  assert.equal(f.requests.length, 1)
})

test('test endpoints reject public/credential URLs before any network access', () => {
  for (const apiBase of ['https://api.bot.qq.com', 'http://localhost:1', 'http://127.0.0.1@public.example', 'http://127.0.0.1:1/path']) {
    assert.throws(() => createTransport({ ...CREDS, testEndpoints: { apiBase, tokenUrl: 'http://127.0.0.1:1/token' } }), /invalid_test_endpoint/)
  }
})

test('gateway returned by local fixture cannot redirect tests to public network', async t => {
  const f = await fixture(t, { gatewayOverride: 'wss://api.bot.qq.com/websocket/' })
  let constructed = 0
  const bot = createTransport({ ...CREDS, testEndpoints: f.testEndpoints, WebSocketImpl: class { constructor () { constructed++ } } })
  t.after(() => bot.stop())
  assert.equal(await bot.start(), false)
  assert.equal(bot.status(), 'error')
  assert.equal(constructed, 0)
})

test('stop drops a late consumer completion and cleans every clock timer', async t => {
  const clock = new Clock()
  let resolveEvent
  const { f, bot } = await connected(t, { clock, onEvent: () => new Promise(resolve => { resolveEvent = resolve }) })
  f.send(event())
  await until(() => !!resolveEvent)
  bot.stop()
  resolveEvent(true)
  await clock.advance(200000)
  assert.equal(clock.timers.size, 0)
  assert.equal(bot.status(), 'stopped')
  assert.equal(f.connections.length, 1)
})

async function pendingRefresh (t) {
  const clock = new Clock()
  let tokenCalls = 0
  let release
  const { f, bot } = await connected(t, {
    clock,
    tokenProvider: () => {
      tokenCalls++
      if (tokenCalls === 1) return Promise.resolve({ access_token: 'synthetic-provider-first', expires_in: 70 })
      return new Promise(resolve => { release = resolve })
    }
  })
  await clock.advance(10000)
  assert.equal(tokenCalls, 2)
  return { clock, f, bot, release: () => release({ access_token: 'synthetic-provider-late', expires_in: 7200 }) }
}

test('token delayed beyond reply deadline cannot trigger a late POST', async t => {
  const { clock, f, bot, release } = await pendingRefresh(t)
  const pending = bot.sendText({ ...TEXT, deadline: clock.now() + 50 })
  await clock.advance(50)
  release()
  assert.deepEqual(await pending, { kind: 'expired' })
  assert.equal(f.posts().length, 0)
})

test('identity guard is rechecked after pending token resolution, before POST', async t => {
  const { clock, f, bot, release } = await pendingRefresh(t)
  let current = true
  const pending = bot.sendText({ ...TEXT, deadline: clock.now() + 10000, isCurrent: () => current })
  current = false
  release()
  assert.deepEqual(await pending, { kind: 'unknown' })
  assert.equal(f.posts().length, 0)
})

test('reply deadline aborts a dispatched HTTP request and late success remains unknown', async t => {
  const clock = new Clock()
  const { f, bot } = await connected(t, { clock })
  f.replies.push({ hold: true })
  const pending = bot.sendText({ ...TEXT, deadline: clock.now() + 100 })
  await until(() => !!f.heldResponse)
  await clock.advance(100)
  assert.deepEqual(await pending, { kind: 'unknown' })
  f.heldResponse.res.end(JSON.stringify({ id: 'SYNTHETIC_LATE_SUCCESS' }))
  assert.equal(f.posts().length, 1)
  assert.equal(bot.status(), 'ready')
})
