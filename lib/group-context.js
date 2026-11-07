/** 044: bounded in-memory observations, never a listener or a source of identity. */
export const GROUP_CONTEXT_LIMITS = Object.freeze({
  groups: 128, entries: 20, text: 400, chars: 4000, ttlMs: 600000
})
const str = (value, limit = 120) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
export const messageIdOf = value => typeof value === 'string' ? (value.trim().length <= 120 ? value.trim() : '')
  : Number.isSafeInteger(value) ? String(value) : ''
export function replyIdOfSegments (segments) {
  if (!Array.isArray(segments)) return ''
  for (const item of segments) {
    if (item?.type !== 'reply') continue
    const id = messageIdOf(item.messageId ?? item.data?.id ?? item.id)
    if (id) return id
  }
  return ''
}
function entryOf (value) {
  if (!value || !['incoming', 'outgoing'].includes(value.direction)) return null
  const messageId = messageIdOf(value.messageId)
  if (!messageId && value.direction !== 'outgoing') return null
  const text = str(value.text, GROUP_CONTEXT_LIMITS.text)
  const senderId = messageIdOf(value.senderId)
  const senderName = str(value.senderName, 40)
  const ts = Number(value.ts)
  const row = {
    messageId, senderId, senderName, ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
    text, direction: value.direction, source: value.source === 'wake-history' ? 'wake-history' : 'live',
    isMaster: value.isMaster === true
  }
  if (typeof value.atMe === 'boolean') row.atMe = value.atMe
  if (Array.isArray(value.atOthers)) row.atOthers = value.atOthers.slice(0, 8).map(one => ({
    qq: str(one?.qq), name: str(one?.name, 40)
  })).filter(one => one.qq || one.name)
  const reply = messageIdOf(value.replyToMessageId)
  if (reply) row.replyToMessageId = reply
  return row
}
export function normalizeGroupContext (value, chatId) {
  if (!value || value.v !== 1 || value.chatId !== chatId || !Array.isArray(value.recent)) return null
  let truncated = value.truncated === true || value.recent.length > GROUP_CONTEXT_LIMITS.entries
  const replyId = messageIdOf(value.reply?.messageId)
  const textBudget = GROUP_CONTEXT_LIMITS.chars - (replyId ? GROUP_CONTEXT_LIMITS.text : 0)
  const recent = []
  let chars = 0
  for (const raw of value.recent.slice(-GROUP_CONTEXT_LIMITS.entries).reverse()) {
    const row = entryOf(raw)
    if (!row) { truncated = true; continue }
    if (String(raw.text ?? '').trim().length > row.text.length) truncated = true
    if (chars + row.text.length > textBudget) { truncated = true; continue }
    chars += row.text.length
    recent.unshift(row)
  }
  const result = { v: 1, chatId, recent }
  if (replyId) {
    const found = recent.find(row => row.messageId === replyId)
    result.reply = found ? {
      messageId: replyId, resolved: true, senderId: found.senderId,
      senderName: found.senderName, text: found.text, isEcho: found.direction === 'outgoing'
    } : { messageId: replyId, resolved: false }
  }
  if (truncated) result.truncated = true
  return result
}
export function historyBefore (entries, messageId, ts) {
  const current = entries.findIndex(row => row.messageId === messageIdOf(messageId))
  return {
    entries: current >= 0 ? entries.slice(0, current)
      : entries.filter(row => row.at > 0 && row.at < Number(ts)),
    truncated: current < 0
  }
}
export function createGroupContext ({ now = () => Date.now() } = {}) {
  const groups = new Map()
  function sweep () {
    const cutoff = now() - GROUP_CONTEXT_LIMITS.ttlMs
    for (const [id, state] of groups) {
      state.rows = state.rows.filter(one => one.observedAt > cutoff)
      if (!state.rows.length) groups.delete(id)
    }
  }
  function record (chatId, raw) {
    sweep()
    const id = str(chatId)
    const row = entryOf(raw)
    if (!id || !row) return false
    let state = groups.get(id) ?? { rows: [], truncated: false }
    if (row.messageId && state.rows.some(one => one.row.messageId === row.messageId)) return false
    groups.delete(id)
    while (groups.size >= GROUP_CONTEXT_LIMITS.groups) groups.delete(groups.keys().next().value)
    state.truncated ||= String(raw.text ?? '').trim().length > GROUP_CONTEXT_LIMITS.text
    state.rows.push({ row, observedAt: now() })
    while (state.rows.length > GROUP_CONTEXT_LIMITS.entries ||
        state.rows.reduce((n, one) => n + one.row.text.length, 0) > GROUP_CONTEXT_LIMITS.chars) {
      state.rows.shift()
      state.truncated = true
    }
    groups.set(id, state)
    return true
  }
  return {
    record,
    snapshot (chatId, { excludeMessageId = '', replyMessageId = '' } = {}) {
      sweep()
      const state = groups.get(chatId)
      return normalizeGroupContext({
        v: 1, chatId,
        recent: (state?.rows ?? []).map(one => one.row).filter(row => !excludeMessageId || row.messageId !== excludeMessageId),
        ...(replyMessageId ? { reply: { messageId: replyMessageId } } : {}),
        truncated: state?.truncated === true
      }, chatId)
    },
    forget: chatId => groups.delete(String(chatId)),
    clear: () => groups.clear(),
    status () { sweep(); return { groups: groups.size, entries: [...groups.values()].reduce((n, one) => n + one.rows.length, 0) } }
  }
}
