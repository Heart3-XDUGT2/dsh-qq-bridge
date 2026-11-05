import { normalizeConfig, basicService, replyService, identity, inboundKey, digest, PLATFORM, SERVICE, STATES, WINDOW_MS } from './config.js'
import { openLedger, ledgerNamespace } from './ledger.js'
import { createDelivery } from './delivery.js'
import { createTransport } from './transport.js'
import { createOwnerTextPlugin } from './owner-text.js'

export const name = 'dsh-echo-qq-official'
export const STATUS_SERVICE = 'echo:official-c2c'
const defaultClock = { now: () => Date.now(), setTimeout, clearTimeout }

export function createPlugin ({ transportFactory = createTransport, ledgerFactory = openLedger, clock = defaultClock } = {}) {
  return {
    name,
    apply (ctx, rawConfig = {}) {
      const initial = normalizeConfig(rawConfig)
      const c = initial.config
      c.chatId = c.ownerBinding ? identity(c.appId, c.ownerBinding.userOpenid) : ''
      const stamp = () => {
        const n = normalizeConfig(rawConfig)
        return digest(n.reason, n.config)
      }
      const generation = stamp()
      let code = initial.reason || 'service'
      let active = !initial.reason
      let connected = false
      let networkBlocked = false
      let timer = null
      let transport = null
      let ledger = null
      let service = null
      let replies = null
      let unregister = null
      let unsubscribe = null
      let work = Promise.resolve()
      let working = false
      let receiving = Promise.resolve(true)
      let stopPromise = null
      const counters = { accepted: 0, duplicate: 0, refused: 0 }
      const setState = value => { code = Object.hasOwn(STATES, value) ? value : 'error'; if (['token', 'error', 'stopped', 'storage_error'].includes(code)) networkBlocked = true }
      const serviceOf = () => { try { return ctx.get(SERVICE) } catch { return null } }
      const current = () => active && stamp() === generation && serviceOf() === service && replyService(service) === replies
      const sendAlive = () => current() && connected && !networkBlocked
      const status = () => ({ code, message: STATES[code], enabled: active, connected, canSend: !!replies && sendAlive(), prototype: true, ...counters })
      async function stop () {
        if (stopPromise) return stopPromise
        active = false
        connected = false
        if (timer !== null) { clock.clearTimeout(timer); timer = null }
        try { unsubscribe?.() } catch {}
        try { unregister?.() } catch {}
        unsubscribe = unregister = null
        try { transport?.stop() } catch {}
        stopPromise = Promise.allSettled([work, receiving]).then(() => { try { ledger?.close() } catch {}; ledger = null; code = 'stopped' })
        return stopPromise
      }
      function halt (reason) {
        setState(reason)
        // stop synchronously invalidates this generation. Do not await it from
        // receiving/work: stop itself waits for those tasks to settle.
        void stop().then(() => { code = reason })
      }
      const controller = { status, dispose: stop }
      const disposeStatus = ctx.provide(STATUS_SERVICE, controller)
      ctx.effect(() => async () => { await stop(); try { disposeStatus?.() } catch {} })

      async function handleEvent (payload) {
        // Transport gates authenticated dispatch, including replay before
        // RESUMED. connected grants outbound permission only.
        if (!current() || networkBlocked) return false
        if (payload?.t !== 'C2C_MESSAGE_CREATE') { setState('invalid'); return true }
        const event = payload.d
        if (!event || event.author?.user_openid !== c.ownerBinding.userOpenid || event.author?.bot === true) { counters.refused++; setState('owner'); return true }
        if (typeof event.id !== 'string' || !event.id || event.id.length > 180 || typeof event.content !== 'string' || !event.content.trim() || event.content.length > 8000) { counters.refused++; setState('invalid'); return true }
        const received = clock.now()
        const ts = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : received
        if (!Number.isFinite(ts) || ts > received + 30000) { setState('invalid'); return true }
        let at = Math.min(ts, received)
        if (received >= at + WINDOW_MS) { setState('expired'); return true }
        const index = Array.isArray(event.message_scene?.ext) ? event.message_scene.ext.find(v => typeof v === 'string' && v.startsWith('msg_idx=')) ?? '' : ''
        const key = inboundKey(c.appId, event.id, index)
        const replyKey = inboundKey(c.appId, event.id)
        at = Math.min(at, ledger.snapshot().replyAt[replyKey] ?? at)
        if (received >= at + WINDOW_MS) { setState('expired'); return true }
        let old = ledger.snapshot().inbound[key]
        if (old?.accepted) { counters.duplicate++; setState('duplicate'); return true }
        if (!old) ledger.remember({ key, replyKey, msgId: event.id, receivedAt: at, chatId: c.chatId })
        if (!current() || networkBlocked) return false
        ledger.change(d => { d.inbound[key].state = 'injecting' })
        let result
        try {
          result = await service.inject({ v: 1, platform: PLATFORM, chat: { id: c.chatId, type: 'private' }, sender: { id: c.chatId, name: '', isMaster: true }, text: event.content, msgId: key, ts: at / 1000 })
        } catch {
          if (!current() || networkBlocked) return false
          ledger.change(d => { d.inbound[key].state = 'unknown' })
          setState('unknown')
          return false
        }
        if (!current() || networkBlocked) return false
        if (result?.ok !== true || (result.accepted !== true && result.duplicate !== true)) { setState('service'); return false }
        ledger.change(d => { const e = d.inbound[key]; e.accepted = true; e.state = 'accepted' })
        counters.accepted++
        setState(connected ? (replies ? 'ready' : 'inbound_only') : 'connecting')
        if (replies) void kick()
        return true
      }
      const receive = payload => {
        receiving = receiving.then(() => handleEvent(payload)).catch(() => { halt('storage_error'); return false })
        return receiving
      }
      let delivery = null
      function kick () {
        if (!sendAlive() || !delivery || working) return work
        working = true
        work = delivery.drain().catch(() => { halt('storage_error') }).finally(() => { working = false })
        return work
      }
      function schedule () {
        if (!active || timer !== null) return
        timer = clock.setTimeout(() => { timer = null; if (!current()) { void stop(); return }; void kick(); schedule() }, 1000)
      }
      async function begin () {
        if (!active) return
        service = serviceOf()
        if (!basicService(service)) { active = false; setState('service'); return }
        replies = replyService(service)
        // Registering even an inbound-only channel changes core routing.
        // Correlation is required before ANY network, storage or registration.
        if (!replies) { active = false; setState('context'); return }
        try { ledger = ledgerFactory(c.stateDir, ledgerNamespace(c)) } catch { active = false; setState('storage_error'); return }
        try {
          unregister = service.registerChannel({ name: 'echo-qq-official-' + digest(c.appId).slice(0, 12), platform: PLATFORM, canSend: !!replies, status, send: async () => ({ ok: false, reason: 'confirmed-reply-contract-only' }) })
          transport = transportFactory({
            appId: c.appId,
            appSecret: c.appSecret,
            clock,
            onEvent: receive,
            onState: state => {
              if (!current() || networkBlocked) return
              connected = state === 'ready'
              if (['error', 'token', 'stopped'].includes(state)) { halt(state); return }
              setState(connected ? (replies ? 'ready' : 'inbound_only') : state)
              if (connected && replies) void kick()
            }
          })
          if (replies) {
            delivery = createDelivery({ config: c, ledger, transport, service: replies, clock, alive: () => current() && !networkBlocked, canSend: sendAlive, onState: setState })
            if (typeof service.subscribeOutbound === 'function') unsubscribe = service.subscribeOutbound(() => { void kick() })
          }
          setState('connecting')
          const started = await transport.start()
          if (started === false) { await stop(); code = 'error'; return }
          if (!current()) { await stop(); return }
          schedule()
        } catch { setState('error'); await stop(); code = 'error' }
      }
      // Publish a caught startup task for tests/supervisors; no profile file IO.
      controller.ready = begin()
    }
  }
}
// Default production discovery uses only the narrow owner-text MVP contract.
// Explicit createPlugin remains the frozen v1 regression/compatibility factory.
export { createOwnerTextPlugin }
export function apply (ctx, config) { return createOwnerTextPlugin().apply(ctx, config) }
