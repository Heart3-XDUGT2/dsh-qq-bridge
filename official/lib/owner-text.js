import { randomUUID } from 'node:crypto'
import { normalizeConfig, digest, SERVICE, STATES, WINDOW_MS } from './config.js'
import { createTransport } from './transport.js'
import { openManagedMvpJournal } from './managed-journal.js'

const STATUS_SERVICE = 'echo:official-c2c'
const realClock = { now: Date.now, setTimeout, clearTimeout }
const TERMINAL = new Set(['confirmed', 'unknown', 'rejected', 'expired', 'abandoned'])
const requiredCodec = ['deriveMessageIdentity', 'validateScope', 'normalizeMessageIndex', 'inputDigest', 'anchorDeadlineMs']
function capability (service) {
  const c = service?.officialOwnerText
  return c?.version === 1 && c.contract === 'owner-text-mvp-1' && c.keyScheme === 'eqqc2c-lp32-v2' &&
    ['status', 'openBinding'].every(k => typeof c[k] === 'function') && requiredCodec.every(k => typeof c.codec?.[k] === 'function') ? c : null
}
const millis = n => Number.isSafeInteger(n) && n >= 0
const bindingShape = b => b && ['inject', 'takeReply', 'canSendReply', 'confirmReply', 'status', 'close'].every(k => typeof b[k] === 'function')

export function createOwnerTextPlugin ({ transportFactory = createTransport, journalFactory = openManagedMvpJournal, clock = realClock, pollMs = 250 } = {}) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 5000) throw Error('invalid_poll_interval')
  return {
    name: 'dsh-echo-qq-official',
    apply (ctx, rawConfig = {}) {
      const initial = normalizeConfig(rawConfig), config = initial.config
      const generation = digest(initial.reason, config)
      const serviceOf = () => { try { return ctx.get(SERVICE) } catch { return null } }
      let active = !initial.reason, connected = false, blocked = false, code = initial.reason || 'service'
      let service, cap, codec, scope, binding, journal, transport, timer = null, working = false
      let receiving = Promise.resolve(), closePending = false, closeResult = null, outgoing = null
      const tasks = new Set(), counters = { accepted: 0, duplicate: 0, refused: 0 }
      const startup = new AbortController()
      let finalizing = null
      function finishLate () {
        if (active || finalizing || !journal || journal.status().closed) return
        queueMicrotask(() => {
          if (active || finalizing || tasks.size || !journal || journal.status().closed) return
          // Runs only after tracked work has settled, never waits on itself.
          finalizing = dispose({ timeoutMs: 1000 }).catch(() => {}).finally(() => { finalizing = null })
        })
      }
      function track (promise, wake = true) {
        const p = Promise.resolve(promise); tasks.add(p)
        const settled = () => {
          tasks.delete(p)
          if (!active && (wake === true || (typeof wake === 'function' && wake()))) finishLate()
        }
        p.then(settled, settled)
        return p
      }
      function current () {
        try {
          const normalized = normalizeConfig(rawConfig)
          if (!active || blocked || digest(normalized.reason, normalized.config) !== generation ||
            serviceOf() !== service || capability(service) !== cap || cap.status()?.available !== true) return false
          const live = binding?.status()
          return !binding || (live?.active !== false && live?.available !== false)
        } catch { return false }
      }
      const state = value => { code = Object.hasOwn(STATES, value) ? value : 'error' }
      const canSend = () => current() && connected && journal?.status().healthy
      function invalidate () {
        active = false; connected = false
        startup.abort()
        if (timer !== null) { clock.clearTimeout(timer); timer = null }
        outgoing?.abort()
        try { transport?.stop() } catch {}
      }
      function closeBinding () {
        if (!binding || closePending || closeResult?.drained === true) return
        closePending = true
        try {
          track(Promise.resolve(binding.close()).then(result => { closeResult = result }, () => { closeResult = { drained: false } })
            .finally(() => { closePending = false }), () => closeResult?.drained === true)
        } catch { closePending = false; closeResult = { drained: false } }
      }
      async function dispose ({ timeoutMs = 1000, reason } = {}) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw Error('invalid_drain_timeout')
        invalidate(); closeBinding()
        // The timeout bounds observation, never task ownership or lock lifetime.
        const end = Date.now() + timeoutMs
        while (Date.now() < end) {
          if (tasks.size === 0 && (!binding || closeResult?.drained === true)) break
          // A core drain snapshot can be false while its canceled scheduler is
          // settling. Re-observe within this wait budget; never force a lock.
          if (tasks.size === 0 && binding && !closePending) closeBinding()
          await new Promise(resolve => setTimeout(resolve, Math.min(5, Math.max(1, end - Date.now()))))
        }
        const drained = tasks.size === 0 && (!binding || closeResult?.drained === true) && !journal?.status().pendingOperations
        const released = journal ? await journal.close({ drained }) : { closed: drained }
        if (reason) state(reason)
        else if (!blocked) state('stopped')
        return { drained, activeTasks: tasks.size, coreDrained: !binding || closeResult?.drained === true,
          ledgerLockReleased: released.closed === true, lockRetained: released.closed !== true }
      }
      function halt (reason) {
        blocked = true; state(reason); invalidate(); closeBinding()
        void dispose({ reason }).catch(() => {})
      }
      const controller = {
        status: () => ({ code, message: STATES[code], enabled: active, connected, canSend: !!binding && !!canSend(),
          prototype: true, mode: 'owner-text-mvp-1', activeTasks: tasks.size, ...counters }),
        dispose,
        // Caught poll is exposed for deterministic local supervision/tests.
        poll: () => kick()
      }
      const unprovide = ctx.provide(STATUS_SERVICE, controller)
      ctx.effect(() => async () => { await dispose(); try { unprovide?.() } catch {} })

      async function handleEvent (payload) {
        if (!current()) return false
        if (payload?.t !== 'C2C_MESSAGE_CREATE') { state('invalid'); return true }
        const event = payload.d
        if (event?.author?.user_openid !== config.ownerBinding.userOpenid || event.author.bot === true) {
          counters.refused++; state('owner'); return true
        }
        let ids, at, entry
        try {
          if (typeof event.content !== 'string' || !event.content.trim() || !event.content.isWellFormed() ||
            Buffer.byteLength(event.content) > 32768) throw Error('invalid_input')
          ids = codec.deriveMessageIdentity({
            appId: config.appId, rawOpenid: config.ownerBinding.userOpenid, rawMsgId: event.id,
            ...codec.normalizeMessageIndex(event.message_scene?.ext)
          })
          const received = clock.now(), eventAt = event.timestamp === undefined ? received : Date.parse(event.timestamp)
          if (!millis(received) || !millis(eventAt) || eventAt > received + 30000) throw Error('invalid_time')
          at = Math.min(received, eventAt)
          entry = { ...ids, rawMsgId: event.id, text: event.content, firstAtMs: at, deadlineMs: codec.anchorDeadlineMs(at) }
        } catch { counters.refused++; state('invalid'); return true }
        const saved = journal.rememberInput(entry)
        if (saved.input.accepted) { counters.duplicate++; return true }
        if (saved.anchor.firstInboundKey !== ids.inboundKey || TERMINAL.has(saved.anchor.state)) {
          // A different index never starts a second model/send for this raw msg.
          counters.duplicate++; return true
        }
        if (clock.now() >= saved.anchor.deadlineMs) {
          journal.change(d => { d.anchors[ids.replyAnchorKey].state = 'expired' })
          state('expired'); return true
        }
        journal.change(d => { d.inputs[ids.inboundKey].admissionState = 'admitting' })
        let result
        try {
          result = await binding.inject({ inboundKey: ids.inboundKey, replyAnchorKey: ids.replyAnchorKey, text: event.content })
        } catch {
          journal.change(d => { d.inputs[ids.inboundKey].admissionState = 'unknown' })
          state('unknown'); return false
        }
        if (!current()) return false
        if (result?.admissionState !== 'accepted' || result?.everAccepted !== true ||
          typeof result.sourceKey !== 'string' || !result.sourceKey || !result.admissionReceiptId) {
          state(result?.reason === 'storage_unavailable' ? 'storage_error' : 'unknown')
          return false
        }
        journal.change(d => {
          const input = d.inputs[ids.inboundKey]
          input.accepted = true; input.admissionState = 'accepted'
          input.sourceKey = result.sourceKey; input.receipt = result.receipt ?? { id: result.admissionReceiptId }
        })
        counters[result.duplicate ? 'duplicate' : 'accepted']++
        if (outgoing) outgoing.abort() // accepted new input revokes the current reply
        state(connected ? 'ready' : 'connecting')
        void kick()
        return true
      }
      const receive = payload => {
        receiving = receiving.then(() => handleEvent(payload)).catch(() => { halt('storage_error'); return false })
        return track(receiving)
      }
      async function settle (anchorKey) {
        const anchor = journal.snapshot().anchors[anchorKey]
        if (!anchor?.reply || !anchor.outcome || anchor.coreSettled) return true
        let result
        try { result = await binding.confirmReply({ replyId: anchor.reply.replyId, claimKey: anchor.claimKey, outcome: anchor.outcome }) } catch {}
        if (result?.ok !== true) { state('ack_pending'); return false }
        journal.change(d => {
          const a = d.anchors[anchorKey]
          if (a.claimKey !== anchor.claimKey || a.outcome !== anchor.outcome) throw Error('confirmation_conflict')
          a.coreSettled = true
          if (TERMINAL.has(a.state) && d.pendingClaim?.key === a.claimKey) d.pendingClaim = null
        })
        if (anchor.outcome === 'confirmed') state('delivered')
        return true
      }
      function finish (anchorKey, outcome, retryAfterMs) {
        journal.change(d => {
          const a = d.anchors[anchorKey]
          if (TERMINAL.has(a.state)) return
          a.state = outcome; a.outcome = outcome; a.coreSettled = false
          if (a.attempts.at(-1)?.state === 'sending') a.attempts.at(-1).state = outcome
          if (outcome === 'rate_limited') a.retryNotBeforeMs = clock.now() + Math.max(1000, Math.min(60000, retryAfterMs ?? 60000))
        })
      }
      function replyCurrent (reply, claimKey) {
        try { return !!canSend() && binding.canSendReply({ replyId: reply.replyId, claimKey }) === true } catch { return false }
      }
      function finalGate (reply, claimKey) {
        if (!replyCurrent(reply, claimKey)) return { allowed: false }
        const snapshot = journal.snapshot(), a = snapshot.anchors[reply.replyAnchorKey], now = clock.now()
        if (!a || a.bootId !== snapshot.bootId || a.claimKey !== claimKey || TERMINAL.has(a.state) ||
          !millis(now) || now >= a.deadlineMs || a.attempts.length >= 3) return { allowed: false }
        const recentSecond = snapshot.dispatchHistory.filter(t => t > now - 1000)
        const recentMinute = snapshot.dispatchHistory.filter(t => t > now - 60000)
        const retryAtMs = Math.max(recentSecond.length >= 5 ? recentSecond[recentSecond.length - 5] + 1000 : now,
          recentMinute.length >= 20 ? recentMinute[recentMinute.length - 20] + 60000 : now)
        if (retryAtMs > now) return { allowed: false, reason: 'rate_wait', retryAtMs }
        // This sync commit is the irreversible pre-POST boundary and the only
        // budget write. Slow token acquisition cannot reuse an old timestamp.
        journal.change(d => {
          const entry = d.anchors[reply.replyAnchorKey]
          entry.state = 'sending'
          entry.attempts.push({ ordinal: entry.attempts.length + 1, msgSeq: 1, state: 'sending', dispatchedAtMs: now })
          d.dispatchHistory.push(now)
        })
        return { allowed: true }
      }
      async function drainReply () {
        if (!canSend()) return
        let snapshot = journal.snapshot()
        for (const [anchorKey, a] of Object.entries(snapshot.anchors)) {
          if (a.bootId === snapshot.bootId && a.reply && a.outcome && !a.coreSettled && !(await settle(anchorKey))) return
        }
        if (!canSend()) return
        snapshot = journal.snapshot()
        if (!snapshot.pendingClaim) journal.change(d => { d.pendingClaim = { key: 'mvp_claim_' + randomUUID() } })
        const claimKey = journal.snapshot().pendingClaim.key
        let response
        try { response = await binding.takeReply({ claimKey }) } catch { state('unknown'); return }
        if (!current()) return
        const reply = response?.reply
        if (!reply) {
          // A terminal no-reply decision belongs to the core's exact round;
          // surface its safe aggregate reason without guessing another anchor.
          try { if (binding.status()?.reason === 'official_reply_too_long') state('budget') } catch {}
          return
        }
        snapshot = journal.snapshot()
        const input = snapshot.inputs[reply.inboundKey], anchor = snapshot.anchors[reply.replyAnchorKey]
        if (reply.scopeKey !== scope.scopeKey || !input?.accepted || input.replyAnchorKey !== reply.replyAnchorKey ||
          input.sourceKey !== reply.sourceKey || !anchor || !millis(reply.createdAtMs) ||
          typeof reply.replyId !== 'string' || !reply.replyId || typeof reply.text !== 'string' || !reply.text.trim() ||
          !reply.text.isWellFormed() || [...reply.text].length > 1500) { halt('context'); return }
        if (anchor.reply && JSON.stringify(anchor.reply) !== JSON.stringify(reply)) { halt('context'); return }
        if (TERMINAL.has(anchor.state) || anchor.bootId !== snapshot.bootId) return
        if (!anchor.reply) journal.change(d => {
          const a = d.anchors[reply.replyAnchorKey]
          a.reply = structuredClone(reply); a.claimKey = claimKey; a.state = 'claimed'
        })
        let a = journal.snapshot().anchors[reply.replyAnchorKey]
        if (clock.now() >= a.deadlineMs) { finish(reply.replyAnchorKey, 'expired'); await settle(reply.replyAnchorKey); state('expired'); return }
        if (a.attempts.length >= 3) { finish(reply.replyAnchorKey, 'rejected'); await settle(reply.replyAnchorKey); state('budget'); return }
        if (!replyCurrent(reply, claimKey)) { finish(reply.replyAnchorKey, 'rejected'); await settle(reply.replyAnchorKey); return }
        if (clock.now() < (a.retryNotBeforeMs ?? 0) || clock.now() < (a.rateRetryAtMs ?? 0)) return
        outgoing = new AbortController()
        let result
        try {
          result = await transport.sendText({
            openid: config.ownerBinding.userOpenid, msgId: a.rawMsgId, msgSeq: 1, text: reply.text,
            deadline: a.deadlineMs, signal: outgoing.signal, isCurrent: () => replyCurrent(reply, claimKey),
            beforePost: () => finalGate(reply, claimKey)
          })
        } catch { result = { kind: 'unknown' } } finally { outgoing = null }
        if (!journal.status().healthy) { halt('storage_error'); return }
        if (result?.kind === 'not_dispatched' && result.reason === 'rate_wait') {
          journal.change(d => { d.anchors[reply.replyAnchorKey].rateRetryAtMs = result.retryAtMs })
          return
        }
        const tightenedExpired = result?.kind === 'confirmed' && clock.now() >= journal.snapshot().anchors[reply.replyAnchorKey].deadlineMs
        const outcome = !replyCurrent(reply, claimKey) || tightenedExpired ? 'unknown' :
          ['confirmed', 'rate_limited', 'rejected', 'expired'].includes(result?.kind) ? result.kind : 'unknown'
        finish(reply.replyAnchorKey, outcome, result?.retryAfterMs)
        const settled = await settle(reply.replyAnchorKey)
        if (settled) state(outcome === 'confirmed' ? 'delivered' : outcome)
        if (result?.kind === 'token') halt('token')
      }
      function kick () {
        if (!canSend() || working) return Promise.resolve()
        working = true
        return track(drainReply().catch(() => { halt('storage_error') }).finally(() => { working = false }))
      }
      function schedule () {
        if (!active || timer !== null) return
        timer = clock.setTimeout(() => {
          timer = null
          if (!current()) { void dispose(); return }
          void kick(); schedule()
        }, pollMs)
      }
      async function begin () {
        if (!active) return
        service = serviceOf(); cap = capability(service)
        if (!cap) { active = false; state('context'); return }
        try {
          if (cap.status()?.available !== true) { active = false; state('service'); return }
          codec = cap.codec
          const ids = codec.deriveMessageIdentity({ appId: config.appId, rawOpenid: config.ownerBinding.userOpenid,
            rawMsgId: 'binding-scope-only', indexKind: 'missing', indexValue: '' })
          scope = codec.validateScope({ platform: 'qq-official', appId: config.appId, ownerHash: ids.ownerHash, chatId: ids.chatId })
          journal = await journalFactory(config.stateDir, { ...scope, keyScheme: cap.keyScheme },
            { now: clock.now, signal: startup.signal, isCurrent: current })
          if (!current()) { invalidate(); await journal.close({ drained: true }); return }
          binding = await cap.openBinding({ scope, authorization: {
            kind: 'local-explicit-owner', authorized: true, appId: scope.appId, ownerHash: scope.ownerHash
          }, metadataStore: journal.metadataStore })
          if (!bindingShape(binding)) throw Error('contract')
          if (!current()) { invalidate(); closeBinding(); return }
          transport = transportFactory({
            appId: config.appId, appSecret: config.appSecret, clock, onEvent: receive,
            onState: next => {
              if (!current()) return
              connected = next === 'ready'
              if (['token', 'error', 'stopped'].includes(next)) { halt(next); return }
              state(next)
              if (connected) void kick()
            }
          })
          const started = await transport.start()
          if (started === false) { halt('error'); return }
          if (!current()) { invalidate(); closeBinding(); return }
          schedule()
        } catch (error) {
          const allowed = ['storage_busy', 'storage_legacy', 'storage_unsupported', 'storage_recovery']
          const reason = error?.code === 'storage_canceled' ? 'stopped' :
            allowed.includes(error?.code) ? error.code : journal ? 'context' : 'storage_error'
          if (reason !== 'stopped') try { ctx.logger?.warn?.('官方私聊：' + STATES[reason]) } catch {}
          halt(reason)
        }
      }
      controller.ready = track(Promise.resolve().then(begin))
    }
  }
}
