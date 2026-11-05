import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const { WebSocketServer } = createRequire(import.meta.url)('ws')

export async function until (predicate, ms = 2500) {
  const end = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > end) throw Error('local_fixture_timeout')
    await delay(5)
  }
}

export class Clock {
  time = 1000000
  next = 0
  timers = new Map()
  now = () => this.time
  setTimeout = (fn, ms) => { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id }
  clearTimeout = id => this.timers.delete(id)
  async advance (ms) {
    const end = this.time + ms
    let loops = 0
    for (;;) {
      const entry = [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!entry) break
      if (++loops > 1000) throw Error('timer_loop')
      this.timers.delete(entry[0]); this.time = entry[1].at; entry[1].fn()
      await new Promise(resolve => setImmediate(resolve))
    }
    this.time = end
    await new Promise(resolve => setImmediate(resolve))
  }
}

export async function fixture (t, options = {}) {
  const f = {
    tokenCalls: 0, requests: [], connections: [], replies: [], interval: 45000,
    tokenStatus: 200, tokenError: 0, tokenExpiry: 7200,
    acknowledgeHeartbeat: true, autoReady: true, onIdentify: null, onResume: null,
    ...options
  }
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = null
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { }
    f.requests.push({ method: req.method, path: req.url, headers: req.headers, body })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/app/getAppAccessToken') {
      f.tokenCalls++
      res.statusCode = f.tokenStatus
      res.end(JSON.stringify(f.tokenError ? { code: f.tokenError, message: 'SYNTHETIC_ERROR_TEXT' } : { access_token: 'synthetic-token-' + f.tokenCalls, expires_in: f.tokenExpiry }))
    } else if (req.url === '/gateway') {
      res.end(JSON.stringify({ url: f.gatewayOverride ?? f.wsUrl }))
    } else if (req.url.startsWith('/v2/users/')) {
      const response = f.replies.shift() ?? { status: 200, body: { id: 'SYNTHETIC_SENT_ID' } }
      if (response.hold) { f.heldResponse = { req, res, response }; return }
      if (response.disconnect) { req.socket.destroy(); return }
      res.statusCode = response.status
      for (const [k, v] of Object.entries(response.headers ?? {})) res.setHeader(k, v)
      res.end(response.raw ?? JSON.stringify(response.body))
    } else { res.statusCode = 404; res.end('{}') }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/socket') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, connection => wss.emit('connection', connection))
  })
  wss.on('connection', socket => {
    const record = { socket, received: [] }
    f.connections.push(record)
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: f.interval } }))
    socket.on('message', data => {
      const payload = JSON.parse(data.toString())
      record.received.push(payload)
      if (payload.op === 2) {
        if (f.onIdentify) f.onIdentify(socket, payload)
        else if (f.autoReady) socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'SYNTHETIC_SESSION' } }))
      } else if (payload.op === 6) {
        if (f.onResume) f.onResume(socket, payload)
        else socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: payload.d.seq, d: null }))
      } else if (payload.op === 1 && f.acknowledgeHeartbeat) socket.send(JSON.stringify({ op: 11 }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  f.apiBase = 'http://127.0.0.1:' + address.port
  f.wsUrl = 'ws://127.0.0.1:' + address.port + '/socket'
  f.testEndpoints = { apiBase: f.apiBase, tokenUrl: f.apiBase + '/app/getAppAccessToken' }
  f.posts = () => f.requests.filter(r => r.path.startsWith('/v2/users/'))
  f.send = (payload, index = f.connections.length - 1) => f.connections[index].socket.send(JSON.stringify(payload))
  t.after(async () => {
    for (const client of wss.clients) client.terminate()
    wss.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return f
}
