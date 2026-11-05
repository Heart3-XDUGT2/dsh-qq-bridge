/** 033：仅保存已准入转发的短期内存页；不含QQ查询或附件二进制。 */
import { randomBytes } from 'node:crypto'
import { FORWARD_NOTICES } from './forward-content.js'

const MAX_NODES = 80
const MAX_CHARS = 24000
const MAX_IMAGES = 4
const NOTICE_SET = new Set(Object.values(FORWARD_NOTICES))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : ''
const LABEL_NAMESPACE = Symbol.for('dsh-echo-qq.forward-label.v1')
const LABEL_EPOCH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** 仅两个小标量跨同进程模块重载保留；TTL、淘汰及实例重建不回收旧名称。 */
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
  if (!object(namespace) || typeof namespace.epoch !== 'string' || !LABEL_EPOCH.test(namespace.epoch)
    || !Number.isSafeInteger(namespace.sequence) || namespace.sequence < 0
    || namespace.sequence >= Number.MAX_SAFE_INTEGER) return null
  namespace.sequence += 1
  return '转发' + namespace.epoch + '-' + namespace.sequence
}

function httpImageSource (value) {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (candidate.length > 2048 || !/^https?:\/\//i.test(candidate)) return ''
  try {
    const url = new URL(candidate)
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== '' ? candidate : ''
  } catch { return '' }
}

function endOf (text, end) {
  if (end > 0 && end < text.length
    && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1
  return end
}

const clip = (value, limit) => {
  const text = scalar(value)
  return text.slice(0, endOf(text, Math.min(text.length, limit)))
}

function bounded (value, fallback, minimum, maximum) {
  return Number.isFinite(Number(value)) ? Math.max(minimum, Math.min(maximum, Math.floor(Number(value)))) : fallback
}

function sourceOf (raw) {
  if (!object(raw) || !['private', 'group'].includes(raw.chatType)) return null
  const chatId = scalar(raw.chatId).trim()
  const senderId = scalar(raw.senderId).trim()
  if (chatId === '' || senderId === '' || chatId.length > 128 || senderId.length > 128) return null
  return { chatId, chatType: raw.chatType, senderId, isMaster: raw.isMaster === true }
}

function sanitize (input) {
  const raw = input?.forwardContent
  if (!object(raw) || raw.source !== 'qq-forward-quote' || raw.present !== true || !Array.isArray(raw.nodes)) return null
  const notices = Array.isArray(raw.notices) ? [...new Set(raw.notices.filter(value => NOTICE_SET.has(value)))] : []
  let truncated = raw.truncated === true
  const note = key => {
    const value = FORWARD_NOTICES[key]
    if (!notices.includes(value)) notices.push(value)
    truncated = true
  }
  const images = []
  const imageMap = new Map()
  const providedImages = Array.isArray(input.images) ? input.images : []
  if (providedImages.length > MAX_IMAGES) note('images')
  for (let i = 0; i < Math.min(MAX_IMAGES, providedImages.length); i++) {
    const value = providedImages[i]
    if (!object(value)) { note('imageMissing'); continue }
    const image = {}
    for (const key of ['url', 'file']) {
      const source = httpImageSource(value[key])
      if (source !== '') image[key] = source
    }
    if (image.url === undefined && image.file === undefined) { note('imageMissing'); continue }
    if (typeof value.sub_type === 'number' && Number.isFinite(value.sub_type)) image.sub_type = value.sub_type
    if (typeof value.summary === 'string' && value.summary !== '') image.summary = clip(value.summary, 40)
    imageMap.set(i, images.length)
    images.push(image)
  }
  const nodes = []
  let chars = 0
  if (raw.nodes.length > MAX_NODES) note('messages')
  for (let index = 0; index < Math.min(MAX_NODES, raw.nodes.length); index++) {
    const value = raw.nodes[index]
    if (!object(value) || typeof value.text !== 'string') { note('invalidNode'); continue }
    if (value.text.length > 0 && chars >= MAX_CHARS) { note('chars'); break }
    const text = clip(value.text, MAX_CHARS - chars)
    const cut = text.length < value.text.length
    if (cut) note('chars')
    chars += text.length
    const timeValue = scalar(value.time).trim()
    const time = timeValue !== '' && Number.isFinite(Number(timeValue)) && Number(timeValue) >= 0 ? Number(timeValue) : null
    const sender = object(value.sender) ? value.sender : {}
    const at = Array.isArray(value.at) ? value.at.slice(0, 8).filter(object).map(target => ({
      qq: clip(target.qq, 20), name: clip(target.name, 40)
    })) : []
    const imageIndexes = []
    if (Array.isArray(value.imageIndexes)) {
      for (const originalIndex of value.imageIndexes.slice(0, MAX_IMAGES)) {
        const mapped = imageMap.get(originalIndex)
        if (mapped === undefined) { note('imageMissing'); continue }
        if (!imageIndexes.includes(mapped)) imageIndexes.push(mapped)
      }
    }
    const node = {
      sender: { id: clip(sender.id, 40), name: clip(sender.name, 40) },
      time, text, depth: bounded(value.depth, 0, 0, 3), at, imageIndexes,
      sourceIndex: index, originalTextLength: value.text.length
    }
    if (object(value.voice) && Number.isSafeInteger(value.voice.count) && value.voice.count > 0) {
      node.voice = { count: Math.min(8, value.voice.count), transcribed: false }
    }
    nodes.push(node)
    if (cut) break
  }
  const requests = Number.isSafeInteger(raw.stats?.requests) ? Math.max(0, Math.min(3, raw.stats.requests)) : 0
  return { nodes, images, notices, truncated, requests }
}

/** 每段只保存源范围描述；正文只在缓存原节点里保存一份。 */
function paginate (nodes, pageNodes, pageChars) {
  const pages = []
  let page = []
  let chars = 0
  const next = () => {
    if (page.length > 0) pages.push(page)
    page = []
    chars = 0
  }
  for (let index = 0; index < nodes.length; index++) {
    const text = nodes[index].text
    if (text.length === 0) {
      if (page.length >= pageNodes) next()
      page.push({ index, start: 0, end: 0 })
      continue
    }
    let start = 0
    while (start < text.length) {
      if (page.length >= pageNodes || chars >= pageChars) next()
      const end = endOf(text, Math.min(text.length, start + pageChars - chars))
      if (end <= start) { next(); continue }
      page.push({ index, start, end })
      chars += end - start
      start = end
    }
  }
  next()
  return pages.length > 0 ? pages : [[]]
}

export function createForwardCache ({
  now = () => Date.now(), ttlMs = 600000, maxEntries = 16, pageNodes = 20, pageChars = 6000
} = {}) {
  const ttl = bounded(ttlMs, 600000, 1, 600000)
  const capacity = bounded(maxEntries, 16, 1, 16)
  const nodesPerPage = bounded(pageNodes, 20, 1, 20)
  const charsPerPage = bounded(pageChars, 6000, 2, 6000)
  const entries = new Map()

  function purge () {
    const at = now()
    for (const [ref, entry] of entries) if (entry.expiresAt <= at) entries.delete(ref)
    return at
  }

  function pageOf (entry, ref, page) {
    const images = []
    const imageMap = new Map()
    const nodes = entry.pages[page - 1].map(fragment => {
      const original = entry.content.nodes[fragment.index]
      const first = fragment.start === 0
      const imageIndexes = []
      if (first) {
        for (const index of original.imageIndexes) {
          if (!imageMap.has(index)) {
            imageMap.set(index, images.length)
            images.push({ ...entry.content.images[index] })
          }
          imageIndexes.push(imageMap.get(index))
        }
      }
      return {
        sender: { ...original.sender }, time: original.time,
        text: original.text.slice(fragment.start, fragment.end), depth: original.depth,
        at: first ? original.at.map(target => ({ ...target })) : [], imageIndexes,
        sourceIndex: original.sourceIndex, textStart: fragment.start, textEnd: fragment.end,
        continued: fragment.start > 0, hasMoreText: fragment.end < original.originalTextLength,
        ...(first && original.voice ? { voice: { ...original.voice } } : {})
      }
    })
    return {
      source: 'qq-forward-quote', present: true, nodes, images,
      notices: [...entry.content.notices], truncated: entry.content.truncated,
      stats: {
        requests: entry.content.requests, nodes: nodes.length,
        chars: nodes.reduce((sum, node) => sum + node.text.length, 0), images: images.length
      },
      ref, label: entry.label, page, totalPages: entry.pages.length, hasMore: page < entry.pages.length
    }
  }

  function put (input, rawSource) {
    const source = sourceOf(rawSource)
    const content = sanitize(input)
    if (source === null || content === null) return null
    const at = purge()
    const label = nextLabel()
    if (label === null) return null
    while (entries.size >= capacity) entries.delete(entries.keys().next().value)
    const chatKey = source.chatType + ':' + source.chatId
    let ref
    do { ref = randomBytes(16).toString('hex') } while (entries.has(ref))
    const entry = {
      source, content, pages: paginate(content.nodes, nodesPerPage, charsPerPage),
      expiresAt: at + ttl, chatKey, label
    }
    entries.set(ref, entry)
    return pageOf(entry, ref, 1)
  }

  function readForward ({ ref, page = 1, source: rawSource } = {}) {
    const source = sourceOf(rawSource)
    if (source === null) return { ok: false, reason: 'invalid-source' }
    if (typeof ref !== 'string' || !/^[0-9a-f]{32}$/i.test(ref)) return { ok: false, reason: 'invalid-ref' }
    purge()
    const key = ref.toLowerCase()
    const entry = entries.get(key)
    if (!entry) return { ok: false, reason: 'not-found' }
    if (source.chatId !== entry.source.chatId || source.chatType !== entry.source.chatType) return { ok: false, reason: 'source-mismatch' }
    if (source.chatType === 'private' && (!source.isMaster || !entry.source.isMaster || source.senderId !== entry.source.senderId)) {
      return { ok: false, reason: 'owner-required' }
    }
    if (!Number.isSafeInteger(page) || page < 1 || page > entry.pages.length) return { ok: false, reason: 'invalid-page' }
    entries.delete(key)
    entries.set(key, entry) // 只更新LRU，不延长绝对TTL。
    return { ok: true, forwardContent: pageOf(entry, key, page) }
  }

  function clear () {
    const count = entries.size
    entries.clear()
    return count
  }

  function invalidateChat (key) {
    let removed = 0
    for (const [ref, entry] of entries) {
      if (entry.chatKey !== key) continue
      entries.delete(ref)
      removed += 1
    }
    return removed
  }
  return { put, readForward, clear, invalidateChat }
}
