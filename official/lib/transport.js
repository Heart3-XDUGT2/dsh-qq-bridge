// Protocol reference: bot.q.qq.com/wiki, accessed 2026-10-29.
// Deliberately text/C2C/passive only. No automatic HTTP send retry.
const API = 'https://api.bot.qq.com'
const TOKEN_PATH = '/app/getAppAccessToken'
const INTENTS = 1 << 25
const MAX_RECONNECTS = 3
const FATAL_CLOSES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])
const REJECT_CODES = new Set([40054004, 40054006, 40054013, 40034105])
const EXPIRED_CODES = new Set([40034005, 40034128])
const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) }

function businessCode (body) {
  const codes = [body?.err_code, body?.code].filter(v => v !== undefined).map(Number)
  return codes.some(v => !Number.isFinite(v)) ? NaN : (codes.find(v => v !== 0) ?? 0)
}

function loopbackHttp (value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash || url.search) throw Error('invalid_test_endpoint')
  return url
}

/**
 * tokenProvider, when supplied, receives {appId, appSecret, signal} and returns
 * {access_token, expires_in}. Test endpoints are dependency injection only;
 * the plugin's user config is never forwarded here as endpoint overrides.
 */
export function createTransport ({
  appId, appSecret, onEvent = async () => true, onState = () => {},
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
  clock = realClock, testEndpoints, tokenProvider
} = {}) {
  let apiBase = API
  let tokenUrl = API + TOKEN_PATH
  if (testEndpoints !== undefined) {
    const base = loopbackHttp(testEndpoints.apiBase)
    const token = loopbackHttp(testEndpoints.tokenUrl)
    if (base.pathname !== '/' || base.origin !== token.origin) throw Error('invalid_test_endpoint')
    apiBase = base.origin
    tokenUrl = token.href
  }
  const timers = new Set()
  let state = 'stopped'
  let active = false
  let stopped = false
  let started = false
  let generation = 0
  let socketGeneration = 0
  let socket = null
  let controller = null
  let token = ''
  let tokenExpiresAt = 0
  let tokenPromise = null
  let refreshTimer = null
  let heartbeatTimer = null
  let handshakeTimer = null
  let reconnectTimer = null
  let heartbeatPending = false
  let reconnects = 0
  let sessionId = ''
  let lastSeq = null
  let ready = false

  function notify (code) {
    state = code
    try { onState(code) } catch { /* No external error text reaches status. */ }
  }
  function later (fn, ms) {
    const id = clock.setTimeout(() => { timers.delete(id); fn() }, ms)
    timers.add(id)
    return id
  }
  function cancel (id) {
    if (id !== null && id !== undefined) { clock.clearTimeout(id); timers.delete(id) }
  }
  function clearConnectionTimers () {
    cancel(heartbeatTimer); heartbeatTimer = null
    cancel(handshakeTimer); handshakeTimer = null
    heartbeatPending = false
  }
  function terminate (code = 'stopped') {
    if (!active && stopped) return
    active = false
    ready = false
    stopped = true
    generation++
    socketGeneration++
    controller?.abort()
    for (const id of timers) clock.clearTimeout(id)
    timers.clear()
    refreshTimer = heartbeatTimer = handshakeTimer = reconnectTimer = null
    const old = socket
    socket = null
    try { old?.close(1000) } catch { }
    token = ''
    tokenExpiresAt = 0
    tokenPromise = null
    sessionId = ''
    lastSeq = null
    notify(code)
  }
  const valid = gen => active && !stopped && generation === gen
  function authHeaders (access) { return { Authorization: 'QQBot ' + access, 'X-Union-Appid': appId, 'Content-Type': 'application/json' } }

  async function request (url, init, signal) {
    const timeout = new AbortController()
    const timeoutId = later(() => timeout.abort(), 10000)
    const signals = [controller?.signal, signal, timeout.signal].filter(Boolean)
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.any(signals) })
      const raw = await response.text()
      if (raw.length > 1024 * 1024) throw Error('response_too_large')
      let body = null
      try { body = JSON.parse(raw) } catch { }
      return { status: response.status, headers: response.headers, body }
    } finally { cancel(timeoutId) }
  }

  function scheduleRefresh (gen) {
    cancel(refreshTimer)
    refreshTimer = null
    if (!valid(gen)) return
    const delay = Math.max(1000, tokenExpiresAt - clock.now() - 60000)
    refreshTimer = later(() => {
      if (!valid(gen)) return
      tokenExpiresAt = 0
      getToken(gen).catch(() => { if (valid(gen)) terminate('token') })
    }, delay)
  }

  async function getToken (gen) {
    if (!valid(gen)) throw Error('stopped')
    if (token && tokenExpiresAt > clock.now() + 1000) return token
    if (tokenPromise) return tokenPromise
    tokenPromise = (async () => {
      let body
      if (tokenProvider) body = await tokenProvider({ appId, appSecret, signal: controller.signal })
      else {
        const response = await request(tokenUrl, { method: 'POST', body: JSON.stringify({ appId, clientSecret: appSecret }), headers: { 'Content-Type': 'application/json' } })
        if (response.status !== 200) throw Error('token_failed')
        body = response.body
      }
      const expiresIn = Number(body?.expires_in)
      if (!valid(gen)) throw Error('stopped')
      if ((body?.code !== undefined && Number(body.code) !== 0) || (body?.err_code !== undefined && Number(body.err_code) !== 0) || typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 7200) throw Error('token_failed')
      token = body.access_token
      tokenExpiresAt = clock.now() + expiresIn * 1000
      scheduleRefresh(gen)
      return token
    })()
    try { return await tokenPromise } finally { tokenPromise = null }
  }

  function validateGateway (url) {
    const parsed = new URL(url)
    if (parsed.username || parsed.password || parsed.hash) throw Error('invalid_gateway')
    if (testEndpoints !== undefined) {
      if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') throw Error('invalid_gateway')
    } else if (parsed.protocol !== 'wss:' || !['api.bot.qq.com', 'api.sgroup.qq.com'].includes(parsed.hostname) || (parsed.port && parsed.port !== '443')) throw Error('invalid_gateway')
    return parsed.href
  }

  function sendGateway (payload, connection) {
    if (!active || !socket || socket !== connection || socket.readyState !== 1) return false
    try { socket.send(JSON.stringify(payload)); return true } catch { return false }
  }

  function queueReconnect (code, clearSession = false) {
    if (!active || stopped || reconnectTimer !== null) return
    if (FATAL_CLOSES.has(code)) { terminate('error'); return }
    if (clearSession || code === 4006 || code === 4007) { sessionId = ''; lastSeq = null }
    ready = false
    clearConnectionTimers()
    const old = socket
    socket = null
    socketGeneration++
    try { old?.close(4000) } catch { }
    if (reconnects >= MAX_RECONNECTS) { terminate('error'); return }
    const delay = [250, 1000, 3000][reconnects++]
    const gen = generation
    notify('connecting')
    reconnectTimer = later(() => {
      reconnectTimer = null
      if (valid(gen)) connect(gen).catch(() => { if (valid(gen)) queueReconnect(1006) })
    }, delay)
  }

  function heartbeat (interval, gen, connection, sg) {
    cancel(heartbeatTimer)
    heartbeatTimer = later(() => {
      if (!valid(gen) || socketGeneration !== sg || connection !== socket) return
      if (heartbeatPending || !sendGateway({ op: 1, d: lastSeq }, connection)) { queueReconnect(1006); return }
      heartbeatPending = true
      heartbeat(interval, gen, connection, sg)
    }, interval)
  }

  async function connect (gen) {
    const access = await getToken(gen)
    const gateway = await request(apiBase + '/gateway', { method: 'GET', headers: authHeaders(access) })
    if (!valid(gen)) return
    if (gateway.status !== 200 || businessCode(gateway.body) !== 0) throw Error('gateway_failed')
    const url = validateGateway(gateway.body?.url)
    const connection = new WebSocketImpl(url)
    socket = connection
    const sg = ++socketGeneration
    let chain = Promise.resolve()
    let helloReceived = false
    let awaitingResume = false
    const live = () => valid(gen) && socketGeneration === sg && socket === connection
    const handshakeDeadline = () => {
      cancel(handshakeTimer)
      handshakeTimer = later(() => { if (live()) queueReconnect(1006) }, 15000)
    }
    handshakeDeadline()
    connection.addEventListener('message', event => {
      if (!live()) return
      let payload
      try {
        if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw Error('invalid')
        payload = JSON.parse(event.data)
      } catch { queueReconnect(4002); return }
      if (payload?.op === 11) { heartbeatPending = false; return }
      chain = chain.then(async () => {
        if (!live()) return
        if (payload.op === 10) {
          if (helloReceived) { queueReconnect(4002); return }
          helloReceived = true
          const interval = Number(payload.d?.heartbeat_interval)
          if (!Number.isFinite(interval) || interval < 10 || interval > 120000) { queueReconnect(4002); return }
          const currentToken = await getToken(gen)
          if (!live()) return
          const auth = sessionId && lastSeq !== null
            ? { op: 6, d: { token: 'QQBot ' + currentToken, session_id: sessionId, seq: lastSeq } }
            : { op: 2, d: { token: 'QQBot ' + currentToken, intents: INTENTS, shard: [0, 1], properties: {} } }
          if (!sendGateway(auth, connection)) { queueReconnect(1006); return }
          awaitingResume = auth.op === 6
          heartbeat(interval, gen, connection, sg)
          handshakeDeadline()
          return
        }
        if (payload.op === 7) { queueReconnect(1000); return }
        if (payload.op === 9) { queueReconnect(1000, payload.d !== true); return }
        if (payload.op === 1) {
          if (!sendGateway({ op: 1, d: lastSeq }, connection)) queueReconnect(1006)
          return
        }
        if (payload.op !== 0 || !helloReceived) return
        if (payload.t === 'READY') {
          if (awaitingResume || typeof payload.d?.session_id !== 'string' || !payload.d.session_id || !Number.isSafeInteger(payload.s)) { queueReconnect(4002); return }
          sessionId = payload.d.session_id
          lastSeq = payload.s
          ready = true
          cancel(handshakeTimer); handshakeTimer = null
          notify('ready')
        } else if (payload.t === 'RESUMED') {
          if (!awaitingResume || !sessionId || !Number.isSafeInteger(payload.s)) { queueReconnect(4002); return }
          awaitingResume = false
          lastSeq = lastSeq === null ? payload.s : Math.max(lastSeq, payload.s)
          ready = true
          cancel(handshakeTimer); handshakeTimer = null
          notify('ready')
        } else if (payload.t === 'C2C_MESSAGE_CREATE' && (ready || awaitingResume)) {
          if (!Number.isSafeInteger(payload.s)) { queueReconnect(4002); return }
          if (lastSeq !== null && payload.s <= lastSeq) return
          let accepted = false
          try { accepted = (await onEvent(payload)) === true } catch { }
          if (!live()) return
          if (!accepted) { queueReconnect(1006); return }
          lastSeq = payload.s
        } else if ((ready || awaitingResume) && Number.isSafeInteger(payload.s) && (lastSeq === null || payload.s > lastSeq)) {
          // Known irrelevant events are deliberately ignored, not forwarded.
          lastSeq = payload.s
        }
      }).catch(() => { if (live()) queueReconnect(1006) })
    })
    connection.addEventListener('close', event => {
      if (!live()) return
      if (event.code === 4004) { token = ''; tokenExpiresAt = 0; cancel(refreshTimer); refreshTimer = null }
      queueReconnect(event.code)
    })
    connection.addEventListener('error', () => { if (live()) queueReconnect(1006) })
  }

  async function start () {
    if (started || stopped) return active
    started = true
    if (typeof appId !== 'string' || !appId || typeof appSecret !== 'string' || !appSecret || typeof fetchImpl !== 'function' || typeof WebSocketImpl !== 'function') { notify('error'); return false }
    active = true
    controller = new AbortController()
    const gen = ++generation
    notify('connecting')
    try { await connect(gen); return valid(gen) } catch { if (valid(gen)) terminate('error'); return false }
  }

  async function sendText ({ openid, msgId, msgSeq, text, signal, deadline = Infinity, isCurrent = () => true, beforePost } = {}) {
    const current = () => { try { return isCurrent() === true } catch { return false } }
    if (!current()) return { kind: 'unknown' }
    if (deadline !== Infinity && (!Number.isFinite(deadline) || clock.now() >= deadline)) return { kind: 'expired' }
    if (!active || !ready || stopped || signal?.aborted || typeof openid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(openid) || /^\d+$/.test(openid) || typeof msgId !== 'string' || !msgId || msgId.length > 200 || !Number.isInteger(msgSeq) || msgSeq < 1 || msgSeq > 4 || typeof text !== 'string' || !text.trim() || [...text].length > 1500) return { kind: 'rejected' }
    const gen = generation
    let deadlineTimer = null
    try {
      const access = await getToken(gen)
      if (!valid(gen) || !ready || signal?.aborted || !current()) return { kind: 'unknown' }
      if (clock.now() >= deadline) return { kind: 'expired' }
      const windowAbort = new AbortController()
      if (Number.isFinite(deadline)) deadlineTimer = later(() => windowAbort.abort(), deadline - clock.now())
      const sendSignal = signal ? AbortSignal.any([signal, windowAbort.signal]) : windowAbort.signal
      // getToken may resolve long after the caller's identity/config or reply
      // window changed. Keep this final guard adjacent to the HTTP dispatch.
      if (!valid(gen) || !ready || sendSignal.aborted || !current()) return { kind: 'unknown' }
      if (clock.now() >= deadline) return { kind: 'expired' }
      // Optional MVP single-writer gate: synchronous journal flush and current
      // account-rate check after token waits, immediately before this one POST.
      // Omitted on the frozen explicit v1 path, preserving its old behavior.
      if (beforePost !== undefined) {
        if (typeof beforePost !== 'function') return { kind: 'not_dispatched', reason: 'revoked' }
        const gate = beforePost()
        if (gate?.allowed !== true) return {
          kind: 'not_dispatched', reason: gate?.reason === 'rate_wait' ? 'rate_wait' : 'revoked',
          ...(Number.isSafeInteger(gate?.retryAtMs) ? { retryAtMs: gate.retryAtMs } : {})
        }
        if (!valid(gen) || !ready || sendSignal.aborted || !current()) return { kind: 'unknown' }
        if (clock.now() >= deadline) return { kind: 'expired' }
      }
      const response = await request(apiBase + '/v2/users/' + encodeURIComponent(openid) + '/messages', {
        method: 'POST', headers: authHeaders(access), body: JSON.stringify({ content: text, msg_type: 0, msg_id: msgId, msg_seq: msgSeq })
      }, sendSignal)
      if (!valid(gen) || sendSignal.aborted || !current() || clock.now() >= deadline) return { kind: 'unknown' }
      const code = businessCode(response.body)
      if (response.status === 401 || code === 11252) {
        token = ''; tokenExpiresAt = 0; cancel(refreshTimer); refreshTimer = null
        terminate('token')
        return { kind: 'token' }
      }
      if (response.status === 429 || code === 40034100) {
        const seconds = Number(response.headers?.get?.('retry-after'))
        return { kind: 'rate_limited', retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.max(1000, Math.min(60000, seconds * 1000)) : 60000 }
      }
      if (EXPIRED_CODES.has(code)) return { kind: 'expired' }
      if (REJECT_CODES.has(code) || (response.status >= 400 && response.status < 500)) return { kind: 'rejected' }
      if (response.status >= 200 && response.status < 300 && code === 0 && typeof response.body?.id === 'string' && response.body.id) return { kind: 'confirmed', id: response.body.id }
      return { kind: 'unknown' }
    } catch { return { kind: 'unknown' } } finally { cancel(deadlineTimer) }
  }

  return { start, stop: () => terminate('stopped'), sendText, status: () => state }
}
