/** 034：文件引用收件表，正文与二进制不住这里。 */
import { randomBytes } from 'node:crypto'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_MESSAGE_BYTES = 12 * 1024 * 1024
const MAX_ENTRIES = 32
const MAX_TTL = 30 * 60 * 1000
const LABEL_NAMESPACE = Symbol.for('dsh-echo-qq.file-label.v1')
const TOKEN = /^[0-9a-f]{32}$/i
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum
const failure = reason => ({ ok: false, reason })
const supported = name => /\.(txt|md|pdf|docx)$/i.test(name)
const current = guard => {
  try { return typeof guard === 'function' && guard() === true } catch { return false }
}

function nextLabel () {
  let namespace = globalThis[LABEL_NAMESPACE]
  if (namespace === undefined) {
    namespace = { epoch: new Date().toISOString(), sequence: 0 }
    try {
      Object.defineProperty(globalThis, LABEL_NAMESPACE, {
        value: namespace, enumerable: false, writable: false, configurable: false
      })
    } catch { return null }
  }
  if (!object(namespace) || typeof namespace.epoch !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(namespace.epoch)
    || !integer(namespace.sequence, 0, Number.MAX_SAFE_INTEGER - 1)) return null
  namespace.sequence++
  return '文件' + namespace.epoch + '-' + namespace.sequence
}

function leafName (value) {
  if (typeof value !== 'string' || /:\/\//.test(value)) return '未提供'
  const name = value.split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/session-[0-9a-f]{8,}/ig, '<标识>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, '<标识>').trim()
  if (!name || name === '.' || name === '..' || /[:?]/.test(name)) return '未提供'
  if (name.length <= 160) return name
  const extension = /\.[a-z0-9]{1,10}$/i.exec(name)?.[0] || ''
  let end = 160 - extension.length
  if (end > 0 && /[\uD800-\uDBFF]/.test(name[end - 1]) && /[\uDC00-\uDFFF]/.test(name[end])) end--
  return name.slice(0, end) + extension
}

function identifier (value, limit = 128) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return null
  const text = String(value).trim()
  return text !== '' && text.length <= limit && !/[\u0000-\u0020\u007f]/.test(text) ? text : null
}

function sourceOf (value) {
  if (!object(value) || !['private', 'group'].includes(value.chatType)) return null
  const chatId = identifier(value.chatId), senderId = identifier(value.senderId)
  if (chatId === null || senderId === null) return null
  return { chatType: value.chatType, chatId, senderId, isMaster: value.isMaster === true }
}

const sameOriginal = (a, b) => !!a && !!b && a.chatType === b.chatType && a.chatId === b.chatId
  && a.senderId === b.senderId && a.isMaster === b.isMaster
const sameScope = (a, b) => !!a && !!b && a.chatType === b.chatType && a.chatId === b.chatId
  && (a.chatType !== 'private' || (a.isMaster && b.isMaster && a.senderId === b.senderId))

function httpUrl (value) {
  if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//i.test(value)
    || /[\u0000-\u0020\u007f\\]/.test(value)) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? value : null
  } catch { return null }
}

function fileReference (raw, source) {
  if (!object(raw) || !sameOriginal(sourceOf(raw), source)) return null
  const reference = { ...source }
  const fileId = identifier(raw.fileId, 512), fileHash = identifier(raw.fileHash, 512), url = httpUrl(raw.url)
  if (fileId) reference.fileId = fileId
  if (fileHash) reference.fileHash = fileHash
  if (url) reference.url = url
  if (integer(raw.busid, 0, Number.MAX_SAFE_INTEGER)) reference.busid = raw.busid
  else if (typeof raw.busid === 'string' && /^\d{1,20}$/.test(raw.busid)) reference.busid = raw.busid
  return fileId || fileHash || url ? reference : null
}

function metadataOf (raw) {
  const result = { received: true, name: leafName(raw.name) }
  if (integer(raw.declaredSize, 0, Number.MAX_SAFE_INTEGER)) result.declaredSize = raw.declaredSize
  if (typeof raw.declaredType === 'string' && raw.declaredType.length <= 100
    && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(raw.declaredType)) result.declaredType = raw.declaredType
  return result
}

/**
 * 只有同一消息批次串行取得正文读取权，真实下载字节由finish结算。
 * 原件只允许尝试一次；缓存正文的继续读使用inspect，不重新取得下载权。
 */
export function createFileReceipts (options = {}) {
  if (!object(options)) throw Error('INVALID_FILE_RECEIPT_OPTIONS')
  const {
    now = Date.now, maxEntries = MAX_ENTRIES, ttlMs = MAX_TTL,
    maxMessageBytes = MAX_MESSAGE_BYTES, maxFileBytes = MAX_FILE_BYTES,
    resolve = async () => failure('unavailable')
  } = options
  if (typeof now !== 'function' || typeof resolve !== 'function'
    || !integer(maxEntries, 1, MAX_ENTRIES) || !integer(ttlMs, 1, MAX_TTL)
    || !integer(maxMessageBytes, 1, MAX_MESSAGE_BYTES) || !integer(maxFileBytes, 1, MAX_FILE_BYTES)) {
    throw Error('INVALID_FILE_RECEIPT_OPTIONS')
  }
  const entries = new Map(), batches = new Map()

  function time () {
    const value = now()
    if (!Number.isFinite(value)) throw Error('CLOCK_UNAVAILABLE')
    return value
  }

  function invalidate (batch) {
    if (batch.revoked) return 0
    batch.revoked = true
    batch.active?.cancel()
    batches.delete(batch)
    let removed = 0
    for (const entry of batch.entries) {
      if (entries.get(entry.ref) === entry) { entries.delete(entry.ref); removed++ }
    }
    return removed
  }

  function purge () {
    const at = time()
    for (const batch of batches.values()) {
      if (batch.expiresAt <= at || !current(batch.guard)) invalidate(batch)
    }
    return at
  }

  function touch (batch) {
    batches.delete(batch)
    batches.set(batch, batch)
  }

  function put (files, rawSource, { isCurrent } = {}) {
    const source = sourceOf(rawSource)
    if (!source || (source.chatType === 'private' && !source.isMaster) || !current(isCurrent) || !Array.isArray(files)) return []
    let at
    try { at = purge() } catch { return [] }
    const rows = []
    for (const raw of files.slice(0, 64)) {
      if (!object(raw) || raw.received !== true) continue
      rows.push({ metadata: metadataOf(raw), reference: fileReference(raw.reference, source) })
      if (rows.length === 2) break
    }
    const valid = rows.filter(row => row.reference)
    // 受控容量低于本批引用数时仍交元数据，不部分注册一个放不下的批次。
    if (!valid.length || valid.length > maxEntries) return rows.map(row => ({ ...row.metadata }))
    while (entries.size + valid.length > maxEntries) invalidate(batches.values().next().value)
    const batch = {
      source, guard: isCurrent, expiresAt: at + ttlMs,
      chatKey: source.chatType + ':' + source.chatId,
      entries: [], spent: 0, active: null, revoked: false
    }
    for (const row of valid) {
      const label = nextLabel()
      if (label === null) continue
      let ref
      do { ref = randomBytes(16).toString('hex') } while (entries.has(ref))
      const metadata = { ...row.metadata, ref, label }
      const file = { ...row.metadata, reference: row.reference }
      const entry = { ref, metadata, file, source, batch, attempted: false }
      row.metadata = metadata
      batch.entries.push(entry)
      entries.set(ref, entry)
    }
    if (batch.entries.length) batches.set(batch, batch)
    return rows.map(row => ({ ...row.metadata }))
  }

  function lookup (ref, rawSource) {
    const source = sourceOf(rawSource)
    if (!source || (source.chatType === 'private' && !source.isMaster)) return failure('unproven-origin')
    if (typeof ref !== 'string' || !TOKEN.test(ref)) return failure('expired')
    try { purge() } catch { return failure('unavailable') }
    const entry = entries.get(ref.toLowerCase())
    if (!entry || entry.batch.revoked) return failure('expired')
    if (!sameScope(source, entry.source)) return failure('unproven-origin')
    touch(entry.batch)
    return { ok: true, entry }
  }

  function inspectFile ({ ref, source } = {}) {
    const found = lookup(ref, source)
    return found.ok ? { ok: true, ...found.entry.metadata } : found
  }

  async function openFile ({ ref, source, signal, isCurrent } = {}) {
    if (!current(isCurrent)) return failure('unproven-origin')
    if (signal !== undefined && !(signal instanceof AbortSignal)) return failure('unproven-origin')
    if (signal?.aborted) return failure('canceled')
    const found = lookup(ref, source)
    if (!found.ok) return found
    const { entry } = found, { batch } = entry
    if (!supported(entry.metadata.name)) return failure('unsupported')
    if (entry.metadata.declaredSize > maxFileBytes) return failure('too-large')
    if (entry.attempted) return failure('expired')
    if (batch.active) return failure('busy')
    const byteLimit = Math.min(maxFileBytes, maxMessageBytes - batch.spent)
    if (byteLimit <= 0 || entry.metadata.declaredSize > byteLimit) return failure('too-large')
    let remaining
    try {
      remaining = batch.expiresAt - time()
      if (remaining <= 0) { invalidate(batch); return failure('expired') }
    } catch { return failure('unavailable') }
    const controller = new AbortController()
    let finished = false, timer, watch
    const onAbort = () => active.cancel()
    const cleanup = () => {
      clearTimeout(timer); clearInterval(watch)
      signal?.removeEventListener('abort', onAbort)
    }
    const active = {
      cancel () {
        if (!controller.signal.aborted) controller.abort()
        cleanup()
      },
      finish (bytesRead) {
        if (finished) return
        finished = true
        cleanup()
        // 无效结算不能按零字节重置预算；真实超限触发块亦可大于byteLimit。
        batch.spent = integer(bytesRead, 0, Number.MAX_SAFE_INTEGER)
          ? Math.min(maxMessageBytes, batch.spent + bytesRead) : maxMessageBytes
        if (batch.active === active) batch.active = null
      }
    }
    const isStillCurrent = () => {
      try {
        return !finished && !controller.signal.aborted && signal?.aborted !== true && !batch.revoked && entries.get(entry.ref) === entry
          && time() < batch.expiresAt && current(batch.guard) && current(isCurrent)
      } catch { return false }
    }
    entry.attempted = true
    batch.active = active
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => active.cancel(), remaining)
    timer.unref?.()
    watch = setInterval(() => { if (!isStillCurrent()) active.cancel() }, 50)
    watch.unref?.()
    let abortListener
    const aborted = new Promise(done => {
      abortListener = () => done(null)
      controller.signal.addEventListener('abort', abortListener, { once: true })
    })
    let success = false
    try {
      if (!isStillCurrent()) { active.cancel(); return failure('canceled') }
      // 传解析器一份有界快照；同群后来发言者不能替换原收件来源。
      const file = { ...entry.file, reference: { ...entry.file.reference } }
      const operation = Promise.resolve().then(() => resolve(file, { ...entry.source }, {
        signal: controller.signal, isCurrent: isStillCurrent
      })).catch(() => null)
      const result = await Promise.race([operation, aborted])
      if (!isStillCurrent()) return failure('canceled')
      const url = result?.ok === true ? httpUrl(result.url) : null
      if (!url) return failure('unavailable')
      success = true
      return {
        ok: true, ...entry.metadata, url, byteLimit,
        signal: controller.signal, isCurrent: isStillCurrent, finish: active.finish
      }
    } catch {
      return failure(controller.signal.aborted ? 'canceled' : 'unavailable')
    } finally {
      controller.signal.removeEventListener('abort', abortListener)
      if (!success) active.finish(0)
    }
  }

  function clear () {
    let removed = 0
    for (const batch of [...batches.values()]) removed += invalidate(batch)
    return removed
  }

  function invalidateChat (key) {
    let removed = 0
    for (const batch of [...batches.values()]) if (batch.chatKey === key) removed += invalidate(batch)
    return removed
  }

  return { put, inspectFile, openFile, clear, invalidateChat }
}
