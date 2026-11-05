import { PLATFORM, MAX_REPLY, WINDOW_MS, digest } from './config.js'

const MAX_CHARS = 1500 // local conservative contract, not claimed platform max
const codepoints = s => [...s].length
function groupRows (rows, count) {
  const groups = Array.from({ length: Math.min(rows.length, count) }, () => [])
  rows.forEach((row, i) => groups[Math.floor(i * groups.length / rows.length)].push(row))
  return groups.map(group => ({ ids: group.map(r => r.id), text: group.map(r => r.text).join('\n'), notBefore: Math.max(0, ...group.map(r => Number(r.notBefore) || 0)) * 1000 }))
}
export function createDelivery ({ config, ledger, transport, service, clock, alive, canSend = alive, onState }) {
  const scope = { platform: PLATFORM, appId: config.appId, chatId: config.chatId }
  function freeze (candidate) {
    const d = ledger.snapshot()
    const entry = d.inbound[candidate?.inboundKey]
    if (!candidate || candidate.platform !== PLATFORM || candidate.appId !== config.appId || candidate.chatId !== scope.chatId || candidate.complete !== true || typeof candidate.planKey !== 'string' || !candidate.planKey || candidate.planKey.length > 200 || typeof candidate.turnId !== 'string' || !candidate.turnId || candidate.kind !== 'reply' || !entry?.accepted || entry.chatId !== scope.chatId) return { code: 'context' }
    const rows = candidate.rows
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100 || rows.some(r => !Number.isSafeInteger(r.id) || r.id < 1 || r.kind !== 'reply' || r.chatId !== scope.chatId || r.platform !== PLATFORM || typeof r.text !== 'string' || !r.text.trim() || typeof r.turnId !== 'string' || !(r.turnId === candidate.turnId || r.turnId.startsWith(candidate.turnId + '#')) || !Number.isFinite(Number(r.notBefore ?? 0)))) return { code: 'context' }
    const ids = rows.map(r => r.id)
    if (new Set(ids).size !== ids.length) return { code: 'context' }
    const key = digest(config.appId, scope.chatId, candidate.planKey)
    const fingerprint = digest(candidate)
    if (d.plans[key]) return d.plans[key].fingerprint === fingerprint ? { key } : { code: 'context' }
    if (ids.some(id => d.rows[id])) return { code: 'context' }
    if (clock.now() >= (d.replyAt[entry.replyKey] ?? entry.receivedAt) + WINDOW_MS) return { code: 'expired' }
    // Event msg_idx is useful for dedup, but the platform's reply budget and
    // sequence numbers are shared by ALL events for the same original msg_id.
    const used = Number(d.budgets[entry.replyKey] ?? 0)
    const remaining = MAX_REPLY - used
    if (remaining <= 0) return { code: 'budget' }
    const parts = groupRows(rows, remaining)
    if (parts.some(p => codepoints(p.text) > MAX_CHARS)) return { code: 'budget' }
    ledger.change(next => {
      const e = next.inbound[candidate.inboundKey]
      const allocated = Number(next.budgets[e.replyKey] ?? 0)
      parts.forEach((p, i) => Object.assign(p, { msgSeq: allocated + i + 1, state: 'planned', attempts: 0, nextTryAt: 0 }))
      next.budgets[e.replyKey] = allocated + parts.length
      next.plans[key] = { fingerprint, planKey: candidate.planKey, inboundKey: candidate.inboundKey, turnId: candidate.turnId, ids, parts, acked: false, ackAttempts: 0, nextAckAt: 0 }
      ids.forEach(id => { next.rows[id] = key })
    })
    return { key }
  }
  async function processPlan (key) {
    let d = ledger.snapshot()
    let p = d.plans[key]
    if (!p || p.acked) return
    const entry = d.inbound[p.inboundKey]
    for (let i = 0; i < p.parts.length; i++) {
      p = ledger.snapshot().plans[key]
      const part = p.parts[i]
      if (!alive()) return
      if (part.state === 'confirmed') continue
      if (['unknown', 'sending', 'rejected', 'token', 'expired'].includes(part.state)) { onState(part.state === 'sending' ? 'unknown' : part.state); return }
      if (!canSend()) return
      const deadline = (ledger.snapshot().replyAt[entry.replyKey] ?? entry.receivedAt) + WINDOW_MS
      if (clock.now() >= deadline) { ledger.change(n => { n.plans[key].parts[i].state = 'expired' }); onState('expired'); return }
      if (part.notBefore > clock.now() || part.nextTryAt > clock.now()) return
      if (part.attempts >= 3) { onState('rate_limited'); return }
      // Local prototype ceiling across the one owner/account: 5 HTTP attempts
      // per second and 20 per minute, including retries and uncertain sends.
      // These conservative local limits are not a claimed Tencent passive SLA.
      const history = (ledger.snapshot().sendHistory ?? []).filter(at => at > clock.now() - 60000)
      if (history.length >= 20 || history.filter(at => at > clock.now() - 1000).length >= 5) { onState('rate_limited'); return }
      // Persist BEFORE the request. A crash at this boundary is uncertain,
      // not a reason to send it again with another sequence number.
      ledger.change(n => { const v = n.plans[key].parts[i]; v.state = 'sending'; v.attempts++; n.sendHistory = [...history, clock.now()] })
      let result
      try { result = await transport.sendText({ openid: config.ownerBinding.userOpenid, msgId: entry.msgId, msgSeq: part.msgSeq, text: part.text, deadline, isCurrent: canSend }) } catch { result = { kind: 'unknown' } }
      if (!alive()) { ledger.change(n => { n.plans[key].parts[i].state = 'unknown' }); return }
      const kind = ['confirmed', 'rate_limited', 'token', 'rejected', 'expired'].includes(result?.kind) ? result.kind : 'unknown'
      ledger.change(n => {
        const v = n.plans[key].parts[i]
        v.state = kind
        if (kind === 'rate_limited') v.nextTryAt = clock.now() + Math.max(1000, Math.min(60000, Number(result.retryAfterMs) || 5000))
      })
      if (kind !== 'confirmed') { onState(kind); return }
    }
    p = ledger.snapshot().plans[key]
    if (!alive() || p.parts.some(v => v.state !== 'confirmed') || p.nextAckAt > clock.now() || p.ackAttempts >= 3) return
    ledger.change(n => { const v = n.plans[key]; v.ackAttempts++; v.nextAckAt = clock.now() + 1000 })
    let ack
    try { ack = await service.ackReplies({ ...scope, planKey: p.planKey, ids: [...p.ids] }) } catch { onState('ack_pending'); return }
    if (!alive()) return
    const validIds = Array.isArray(ack?.ids) && ack.ids.length === p.ids.length && new Set(ack.ids).size === p.ids.length && p.ids.every(id => ack.ids.includes(id))
    if (ack?.ok === true && validIds) { ledger.change(n => { n.plans[key].acked = true }); onState('delivered') } else onState('ack_pending')
  }
  async function drain () {
    if (!alive()) return
    // Confirmed sends are recovered before requesting any more rows.
    for (const key of Object.keys(ledger.snapshot().plans)) { await processPlan(key); if (!alive()) return }
    if (!canSend()) return
    let leased
    try { leased = await service.leaseReplies({ ...scope, kind: 'reply', complete: true, limit: 1 }) } catch { onState('context'); return }
    if (!alive()) return
    const plans = leased?.plans
    if (!Array.isArray(plans) || plans.length > 1) { onState('context'); return }
    for (const candidate of plans) {
      const r = freeze(candidate)
      if (r.code) onState(r.code)
      else await processPlan(r.key)
    }
  }
  return { drain }
}
