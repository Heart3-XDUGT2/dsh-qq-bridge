/**
 * QQ合并转发的有界只读展开。网络能力由已准入的调用方注入。
 * OneBot11: api/public.md#get_forward_msg 与 message/segment.md 的forward/node。
 * QQ multimsg卡片仅认app与meta.detail.resid；不读取卡片URL。
 */
export const FORWARD_LIMITS = Object.freeze({
  maxDepth: 2, maxMessages: 20, maxChars: 6000, maxImages: 4,
  maxRequests: 3, timeoutMs: 2000, totalTimeoutMs: 5000, maxSegments: 256
})

export const FORWARD_NOTICES = Object.freeze({
  invalidReference: '转发引用无效，未展开。',
  invalidResponse: '转发响应格式无法识别，未展开。',
  requestFailed: '转发读取失败，未展开这一部分。',
  requestTimeout: '转发读取超时，未展开这一部分。',
  unavailable: '当前无法读取转发记录。',
  empty: '转发记录为空。',
  depth: '嵌套转发超出深度限制，未展开。',
  messages: '转发消息过多，仅展开预算内部分。',
  chars: '转发文字过长，已截断。',
  images: '转发图片超过预算，部分图片未读取。',
  requests: '转发查询次数已达上限，部分记录未展开。',
  deadline: '转发读取已达总时限，剩余内容未展开。',
  duplicate: '重复或循环的转发引用已跳过。',
  segments: '转发消息段过多，部分内容未展开。',
  invalidNode: '部分转发节点格式无法识别，未展开。',
  imageMissing: '转发内有图片，但缺少可读取的图片引用。',
  nodeReference: '转发节点仅有消息引用，未展开。',
  unsupported: '转发内含暂不读取的内容。',
  contentLimit: '转发节点原始内容过长，未展开。'
})

const MAX_RAW_CHARS = 65536
const HARD_LIMITS = {
  maxDepth: 3, maxMessages: 80, maxChars: 24000, maxImages: 4,
  maxRequests: 3, timeoutMs: 2000, totalTimeoutMs: 5000, maxSegments: 1024
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : ''
const field = (segment, key) => segment?.[key] ?? (object(segment?.data) ? segment.data[key] : undefined)

function httpImageSource (value) {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (candidate.length > 2048 || !/^https?:\/\//i.test(candidate)) return ''
  try {
    const url = new URL(candidate)
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== '' ? candidate : ''
  } catch { return '' }
}

function forwardId (value) {
  const id = scalar(value).trim()
  return /^[A-Za-z0-9_+/.=-]{1,256}$/.test(id) && !id.includes('..') ? id : ''
}

function forwardCard (segment) {
  if (segment?.type !== 'json') return null
  const value = typeof segment.data === 'string' ? segment.data : segment.data?.data
  if (typeof value !== 'string' || value.length > MAX_RAW_CHARS) return null
  try {
    const card = JSON.parse(value)
    if (!object(card) || card.app !== 'com.tencent.multimsg') return null
    return { id: typeof card.meta?.detail?.resid === 'string' ? forwardId(card.meta.detail.resid) : '' }
  } catch { return null }
}

export function hasForwardContent (segments) {
  return Array.isArray(segments) && segments.some(segment =>
    object(segment) && (segment.type === 'forward' || segment.type === 'node' || forwardCard(segment) !== null))
}

function limitsOf (raw) {
  const result = {}
  for (const key of Object.keys(FORWARD_LIMITS)) {
    const value = Number(raw?.[key])
    const minimum = ['maxDepth', 'maxImages', 'maxRequests'].includes(key) ? 0 : 1
    result[key] = Number.isFinite(value) ? Math.max(minimum, Math.min(HARD_LIMITS[key], Math.floor(value))) : FORWARD_LIMITS[key]
  }
  return result
}

function clip (value, max) {
  let end = Math.max(0, Math.min(value.length, max))
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1
  return value.slice(0, end)
}

function cqDecode (value) {
  return value.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
}

/** API返回的node.content也可能是CQ字符串；不把媒体URL当正文。 */
function cqSegments (value) {
  const out = []
  const re = /\[CQ:([A-Za-z_][A-Za-z0-9_]*)(,[^\]]*)?\]/g
  let cursor = 0
  for (const match of value.matchAll(re)) {
    if (out.length >= HARD_LIMITS.maxSegments) break
    if (match.index > cursor) out.push({ type: 'text', text: cqDecode(value.slice(cursor, match.index)) })
    const data = {}
    for (const pair of (match[2] ?? '').slice(1).split(',').slice(0, 32)) {
      const separator = pair.indexOf('=')
      if (separator > 0) data[pair.slice(0, separator)] = cqDecode(pair.slice(separator + 1))
    }
    out.push({ type: match[1].toLowerCase(), data })
    cursor = match.index + match[0].length
  }
  if (cursor < value.length && out.length < HARD_LIMITS.maxSegments) out.push({ type: 'text', text: cqDecode(value.slice(cursor)) })
  return out
}

export async function expandForwardContent (segments, { getForward, limits: rawLimits } = {}) {
  if (!hasForwardContent(segments)) return { forwardContent: null, images: [] }
  const limits = limitsOf(rawLimits)
  const nodes = []
  const images = []
  const notices = []
  const seenIds = new Set()
  const seenNodes = new WeakSet()
  const imageKeys = new Map()
  const state = { requests: 0, chars: 0, segments: 0, scannedNodes: 0, truncated: false }
  const deadline = Date.now() + limits.totalTimeoutMs

  function note (key, incomplete = true) {
    const message = FORWARD_NOTICES[key]
    if (message && !notices.includes(message)) notices.push(message)
    if (incomplete) state.truncated = true
  }

  function take (value, cap = limits.maxChars) {
    const full = scalar(value)
    const valueLimit = Math.min(cap, limits.maxChars - state.chars)
    const result = clip(full, valueLimit)
    state.chars += result.length
    if (result.length < full.length) note('chars')
    return result
  }

  function withinTime () {
    if (Date.now() < deadline) return true
    note('deadline')
    return false
  }

  function imageOf (segment, node) {
    const image = {}
    for (const key of ['url', 'file']) {
      const value = httpImageSource(field(segment, key))
      if (value !== '') image[key] = value
    }
    if (image.url === undefined && image.file === undefined) {
      note('imageMissing')
      return
    }
    const key = (image.url ?? '') + '\n' + (image.file ?? '')
    let index = imageKeys.get(key)
    if (index === undefined) {
      if (images.length >= limits.maxImages) { note('images'); return }
      const subType = field(segment, 'sub_type')
      if (subType !== null && subType !== undefined && subType !== '' && Number.isFinite(Number(subType))) image.sub_type = Number(subType)
      const summary = scalar(field(segment, 'summary')).trim()
      if (summary !== '') image.summary = clip(summary, 40)
      index = images.length
      images.push(image)
      imageKeys.set(key, index)
    }
    if (!node.imageIndexes.includes(index)) node.imageIndexes.push(index)
  }

  async function readReference (rawId, depth) {
    if (depth > limits.maxDepth) { note('depth'); return }
    if (state.scannedNodes >= limits.maxMessages) { note('messages'); return }
    if (state.chars >= limits.maxChars) { note('chars'); return }
    const id = forwardId(rawId)
    if (id === '') { note('invalidReference'); return }
    if (seenIds.has(id)) { note('duplicate'); return }
    seenIds.add(id)
    if (!withinTime()) return
    if (state.requests >= limits.maxRequests) { note('requests'); return }
    if (typeof getForward !== 'function') { note('unavailable'); return }
    const timeoutMs = Math.max(1, Math.min(limits.timeoutMs, deadline - Date.now()))
    let timer
    state.requests += 1
    const request = Promise.resolve().then(() => getForward(id, { timeoutMs })).then(value => ({ value }), () => ({ error: true }))
    const response = await Promise.race([
      request,
      new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs) })
    ]).finally(() => clearTimeout(timer))
    if (response.timeout) { note('requestTimeout'); return }
    if (response.error || response.value?.ok !== true) { note('requestFailed'); return }
    const data = response.value.data
    const messages = Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.message) ? data.message : null
    if (messages === null) { note('invalidResponse'); return }
    if (messages.length === 0) { note('empty', false); return }
    for (const raw of messages) {
      if (!withinTime()) break
      if (state.scannedNodes >= limits.maxMessages) { note('messages'); break }
      if (state.chars >= limits.maxChars) { note('chars'); break }
      await addNode(raw, depth)
    }
  }

  async function addNode (raw, depth) {
    if (depth > limits.maxDepth) { note('depth'); return }
    if (state.scannedNodes >= limits.maxMessages) { note('messages'); return }
    state.scannedNodes += 1 // 坏节点也消耗预算，不能借格式错误绕开扫描上限。
    if (!object(raw)) { note('invalidNode'); return }
    if (seenNodes.has(raw)) { note('duplicate'); return }
    seenNodes.add(raw)
    if (state.chars >= limits.maxChars) { note('chars'); return }
    const data = raw.type === 'node' && object(raw.data) ? raw.data : raw
    const content = data.content ?? data.message
    if (typeof content !== 'string' && !Array.isArray(content)) {
      note(data.id !== undefined ? 'nodeReference' : 'invalidNode')
      return
    }
    const sender = object(data.sender) ? data.sender : {}
    const name = scalar(sender.card).trim() || sender.nickname || data.nickname || data.name || ''
    const id = sender.user_id ?? data.user_id ?? data.uin
    const timestamp = scalar(data.time).trim()
    const time = timestamp !== '' && Number.isFinite(Number(timestamp)) && Number(timestamp) >= 0 ? Number(timestamp) : null
    const node = { sender: { id: take(id, 40), name: take(name, 40) }, time, text: '', depth, at: [], imageIndexes: [] }
    nodes.push(node)
    if (typeof content === 'string' && content.length > MAX_RAW_CHARS) { note('contentLimit'); return }
    await walk(typeof content === 'string' ? cqSegments(content) : content, depth, node)
  }

  async function walk (list, depth, owner = null) {
    for (const segment of list) {
      if (!withinTime()) break
      if (state.segments >= limits.maxSegments) { note('segments'); break }
      state.segments += 1
      if (!object(segment)) { if (owner) note('unsupported'); continue }
      const nestedDepth = owner ? depth + 1 : depth
      if (segment.type === 'forward') await readReference(field(segment, 'id'), nestedDepth)
      else if (segment.type === 'node') await addNode(segment, nestedDepth)
      else if (segment.type === 'json') {
        const card = forwardCard(segment)
        if (card) await readReference(card.id, nestedDepth)
        else if (owner) note('unsupported')
      } else if (owner && segment.type === 'text') owner.text += take(field(segment, 'text'))
      else if (owner && segment.type === 'image') imageOf(segment, owner)
      else if (owner && segment.type === 'at') {
        if (owner.at.length >= 8) { note('segments'); continue }
        owner.at.push({ qq: take(field(segment, 'qq'), 20), name: take(field(segment, 'name'), 40) })
      } else if (owner && segment.type === 'record') {
        owner.voice = { count: Math.min(8, (owner.voice?.count ?? 0) + 1), transcribed: false }
      } else if (owner) note('unsupported')
    }
  }

  await walk(segments, 0)
  return {
    forwardContent: {
      source: 'qq-forward-quote', present: true, nodes, notices, truncated: state.truncated,
      stats: { requests: state.requests, nodes: nodes.length, chars: state.chars, images: images.length }
    },
    images
  }
}
