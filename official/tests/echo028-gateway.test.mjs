import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTransport } from '../lib/transport.js'

// All requests are in-memory Responses. FakeWebSocket never opens a socket.
async function checkGateway (t, gateway, accepted, testEndpoints) {
  const requests = [], sockets = []
  class FakeWebSocket {
    constructor (url) { sockets.push(url); this.readyState = 1 }
    addEventListener () {}
    close () { this.readyState = 3 }
  }
  const transport = createTransport({
    appId: 'SYNTHETIC_028_APP', appSecret: 'SYNTHETIC_028_SECRET', testEndpoints,
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async (url, init) => {
      requests.push({ url, method: init.method })
      const body = url.endsWith('/app/getAppAccessToken')
        ? { access_token: 'synthetic-028-token', expires_in: 3600 }
        : { url: gateway }
      return new Response(JSON.stringify(body), { status: 200 })
    }
  })
  t.after(() => transport.stop())
  assert.equal(await transport.start(), accepted)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[1].method, 'GET')
  assert.equal(requests[0].url, (testEndpoints?.apiBase ?? 'https://api.bot.qq.com') + '/app/getAppAccessToken')
  assert.equal(requests[1].url, (testEndpoints?.apiBase ?? 'https://api.bot.qq.com') + '/gateway')
  assert.equal(sockets.length, accepted ? 1 : 0)
  if (accepted) assert.equal(sockets[0], new URL(gateway).href)
  else assert.equal(transport.status(), 'error')
}

for (const host of ['api.bot.qq.com', 'api.sgroup.qq.com']) {
  for (const port of ['', ':443']) test('028 production accepts exact official WSS host ' + host + (port || ' default port'), async t => {
    await checkGateway(t, `wss://${host}${port}/websocket/`, true)
  })
}
for (const [label, url] of [
  ['bot suffix imitation', 'wss://api.bot.qq.com.attacker.example/socket'],
  ['sgroup suffix imitation', 'wss://api.sgroup.qq.com.attacker.example/socket'],
  ['sgroup subdomain', 'wss://sub.api.sgroup.qq.com/socket'],
  ['similar host', 'wss://api-sgroup.qq.com/socket'],
  ['trailing dot', 'wss://api.sgroup.qq.com./socket'],
  ['HTTP', 'http://api.sgroup.qq.com/socket'],
  ['HTTPS', 'https://api.sgroup.qq.com/socket'],
  ['plain WS', 'ws://api.bot.qq.com/socket'],
  ['non-443 port', 'wss://api.sgroup.qq.com:8443/socket'],
  ['zero port', 'wss://api.bot.qq.com:0/socket'],
  ['userinfo', 'wss://user:synthetic@api.sgroup.qq.com/socket'],
  ['host in username', 'wss://api.bot.qq.com@attacker.example/socket'],
  ['fragment', 'wss://api.sgroup.qq.com/socket#fragment'],
  ['production loopback', 'wss://127.0.0.1/socket']
]) test('028 production rejects ' + label + ' before constructing any websocket', async t => {
  await checkGateway(t, url, false)
})
const local = { apiBase: 'http://127.0.0.1:12345', tokenUrl: 'http://127.0.0.1:12345/app/getAppAccessToken' }
test('028 injected test endpoints retain exact loopback WS acceptance', async t => {
  await checkGateway(t, 'ws://127.0.0.1:12345/socket', true, local)
})
for (const url of ['wss://api.bot.qq.com/socket', 'wss://api.sgroup.qq.com/socket', 'ws://localhost:12345/socket']) {
  test('028 injected test endpoints reject non-loopback gateway ' + url, async t => {
    await checkGateway(t, url, false, local)
  })
}
