/**
 * 034：QQ 文件协议纯模块。网络/准入由调用方注入，本模块不取文件字节。
 * group_upload：OneBot11 event/notice.md；offline_file：go-cqhttp event 文档。
 * file 段和两个只读 URL 动作：SnowLuma element-codecs.ts / actions/group-file.ts。
 * file 字段是声明文件名，不能把它当本机路径或下载地址。
 */
import { createHash } from 'node:crypto'

export const FILE_NOTICES = Object.freeze({
  invalidSource: '文件来源无效，无法读取。',
  sourceMismatch: '文件不属于当前聊天，无法读取。',
  missingReference: '已收到文件，但缺少可读取的文件引用。',
  invalidReference: '文件引用无效，无法读取。',
  unsupportedNotice: '暂不处理这类通知。',
  invalidNotice: '文件通知格式不完整，未接收。',
  unavailable: '当前无法读取文件。',
  cancelled: '文件读取已取消。',
  requestFailed: '文件下载地址查询失败。',
  requestTimeout: '文件下载地址查询超时。',
  invalidResponse: '文件下载地址响应无效。'
})

const MAX_FILES = 2
const MAX_SEGMENTS = 256
const MAX_TIMEOUT_MS = 15_000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined
const fail = key => ({ ok: false, reason: FILE_NOTICES[key] })

function fields (segment, names) {
  for (const name of names) {
    const value = own(segment, name) ?? own(own(segment, 'data'), name)
    if (value !== null && value !== undefined) return value
  }
}

function integer (value) {
  if (typeof value === 'string') {
    if (!/^[0-9]{1,16}$/.test(value)) return undefined
    value = Number(value)
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : undefined
}

function qqId (value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value)
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value.trim())
    ? value.trim() : ''
}

function scopeOf (source) {
  if (!object(source) || !['group', 'private'].includes(source.chatType)) return null
  const chatId = qqId(source.chatId)
  const senderId = qqId(source.senderId)
  if (chatId === '' || senderId === '' || (source.chatType === 'private' && chatId !== senderId)) return null
  return { chatType: source.chatType, chatId, senderId, isMaster: source.isMaster === true }
}

function clip (value, limit) {
  let end = Math.min(value.length, limit)
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--
  return value.slice(0, end)
}

function displayName (value) {
  if (typeof value !== 'string' || value.length > 8192) return ''
  const text = value.trim()
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|data:|base64:)/i.test(text)) return ''
  const leaf = text.replace(/\\/g, '/').split('/').at(-1).replace(/^[a-z]:/i, '')
  const clean = leaf.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim()
  return clean === '.' || clean === '..' ? '' : clip(clean, 240)
}

function mimeType (value) {
  return typeof value === 'string' && value.length <= 120 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
    ? value.toLowerCase() : ''
}

function token (value, limit) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value)
  if (typeof value !== 'string' || value.length > limit) return ''
  const text = value.trim()
  if (text === '' || /[\s\u0000-\u001f\u007f-\u009f]/.test(text) ||
      /^(?:[a-z][a-z0-9+.-]*:\/\/|[a-z]:\\|data:|base64:)/i.test(text)) return ''
  return text
}

function httpUrl (value) {
  if (typeof value !== 'string' || value.length > 8192) return ''
  const text = value.trim()
  if (!/^https?:\/\//i.test(text) || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(text)) return ''
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '' ||
        url.username !== '' || url.password !== '') return ''
    url.hash = ''
    return url.href
  } catch { return '' }
}

function fileFact (segment, source) {
  const name = displayName(fields(segment, ['name', 'file', 'filename', 'fileName']))
  const declaredSize = integer(fields(segment, ['file_size', 'size', 'fileSize']))
  const declaredType = mimeType(fields(segment, ['mime_type', 'mimeType', 'content_type', 'mime']))
  const reference = { ...(scopeOf(source) ?? {}) }
  const fileId = token(fields(segment, ['file_id', 'fileId', 'id']), 4096)
  const fileHash = token(fields(segment, ['file_hash', 'fileHash']), 512)
  const busid = integer(fields(segment, ['busid']))
  const url = httpUrl(fields(segment, ['url']))
  if (fileId !== '') reference.fileId = fileId
  if (fileHash !== '') reference.fileHash = fileHash
  if (busid !== undefined) reference.busid = busid
  if (url !== '') reference.url = url
  return {
    received: true, name,
    ...(declaredSize === undefined ? {} : { declaredSize }),
    ...(declaredType === '' ? {} : { declaredType }),
    reference
  }
}

/**
 * 只看消息外层 file；不能把转发作者的文件归到当前发送人名下。
 * 缺引用不抹掉收件事实；无效来源只留下无法读取的内部引用。
 */
export function filesOfSegments (segments, source) {
  if (!Array.isArray(segments)) return []
  const files = []
  for (let index = 0; index < Math.min(MAX_SEGMENTS, segments.length); index++) {
    const segment = segments[index]
    if (object(segment) && segment.type === 'file') files.push(fileFact(segment, source))
    if (files.length === MAX_FILES) break
  }
  return files
}

function identityFact (value) {
  if (typeof value === 'string') return value.length <= 8192 ? value : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * 通知只是已接收文件的另一种传输形状；准入、群醒、队列仍由现有入口处理。
 * ID 只由有界协议事实得出，重放不依赖本地时钟。无共同 ID 时不承诺跨
 * message/notice 两种传输去重；协议本身完全相同的同秒通知不可再区分。
 */
export function fileNoticeEvent (raw) {
  if (!object(raw)) return fail('invalidNotice')
  if (raw.post_type !== 'notice' || !['group_upload', 'offline_file'].includes(raw.notice_type)) {
    return fail('unsupportedNotice')
  }
  const chatType = raw.notice_type === 'group_upload' ? 'group' : 'private'
  const userId = qqId(raw.user_id)
  const selfId = qqId(raw.self_id)
  const groupId = chatType === 'group' ? qqId(raw.group_id) : ''
  const time = integer(raw.time)
  if (userId === '' || selfId === '' || userId === selfId ||
      (chatType === 'group' && groupId === '') ||
      time === undefined || time === 0 || !Number.isSafeInteger(time * 1000) || !object(raw.file)) {
    return fail('invalidNotice')
  }
  const declared = {
    name: own(raw.file, 'name'), size: own(raw.file, 'size'), url: own(raw.file, 'url'),
    ...(chatType === 'group' ? { file_id: own(raw.file, 'id'), busid: own(raw.file, 'busid') } : {})
  }
  const normalized = fileFact(declared, null)
  const data = {}
  if (normalized.name !== '') data.name = normalized.name
  if (normalized.declaredSize !== undefined) data.size = normalized.declaredSize
  if (normalized.reference.fileId !== undefined) data.file_id = normalized.reference.fileId
  if (normalized.reference.busid !== undefined) data.busid = normalized.reference.busid
  if (normalized.reference.url !== undefined) data.url = normalized.reference.url
  if (Object.keys(data).length === 0) return fail('invalidNotice')
  const facts = [
    raw.notice_type, selfId, String(time), chatType, groupId || userId, userId,
    ...['id', 'name', 'size', 'busid', 'url'].map(key => identityFact(own(raw.file, key)))
  ]
  const messageId = 'file-notice-' + createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32)
  return {
    ok: true,
    event: {
      userId, messageId, text: '', segments: [{ type: 'file', data }],
      chatType, groupId, selfId, userName: '', ts: time * 1000
    }
  }
}

/**
 * 这里只制定已核只读动作/直链，不调用网络。private 需要同主人和发送人，
 * group 需要同群。isMaster 来自上层准入，文件元数据不能提供此权力。
 */
export function fileDownloadPlan (file, source) {
  if (!object(file) || file.received !== true || !object(file.reference)) return fail('invalidReference')
  const original = scopeOf(file.reference)
  const current = scopeOf(source)
  if (original === null || current === null) return fail('invalidSource')
  if (original.chatType !== current.chatType || original.chatId !== current.chatId ||
      (original.chatType === 'private' &&
        (!original.isMaster || !current.isMaster || original.senderId !== current.senderId))) {
    return fail('sourceMismatch')
  }
  const fileId = token(file.reference.fileId, 4096)
  if (file.reference.fileId !== undefined && fileId === '') return fail('invalidReference')
  if (fileId !== '') {
    if (original.chatType === 'group') {
      const busid = integer(file.reference.busid)
      return {
        ok: true, action: 'get_group_file_url',
        params: { group_id: original.chatId, file_id: fileId,
          ...(busid === undefined ? {} : { busid }) }
      }
    }
    const fileHash = token(file.reference.fileHash, 512)
    return {
      ok: true, action: 'get_private_file_url',
      params: { user_id: original.senderId, file_id: fileId,
        ...(fileHash === '' ? {} : { file_hash: fileHash }) }
    }
  }
  const url = httpUrl(file.reference.url)
  return url === '' ? fail('missingReference') : { ok: true, url }
}

/**
 * 只经注入 call 查询 URL；没有 fetch、任意 action 或本机路径读取能力。
 * OneBot call 不支持取消 pending，故这里独立结算取消/超时并消费迟到结果。
 */
export async function resolveFileDownload (file, source, options = {}) {
  const plan = fileDownloadPlan(file, source)
  if (!plan.ok) return plan
  if (!object(options)) return fail('unavailable')
  const { call, isCurrent, signal } = options
  if (signal !== undefined && !(signal instanceof AbortSignal)) return fail('unavailable')

  function guard () {
    if (signal?.aborted) return fail('cancelled')
    if (typeof isCurrent !== 'function') return fail('unavailable')
    try {
      const verdict = isCurrent()
      // 拒绝异步 guard，同时消费错误的异步 guard 可能产生的 rejection。
      if (verdict !== true && verdict !== null && typeof verdict === 'object' && typeof verdict.then === 'function') {
        Promise.resolve(verdict).catch(() => {})
      }
      // guard 也可能同步触发取消；不能在检查后再发一次请求。
      if (signal?.aborted) return fail('cancelled')
      return verdict === true ? null : fail('cancelled')
    } catch { return fail(signal?.aborted ? 'cancelled' : 'unavailable') }
  }

  const blocked = guard()
  if (blocked) return blocked
  if (plan.url !== undefined) return { ok: true, url: plan.url }
  if (typeof call !== 'function') return fail('unavailable')
  const requested = integer(options.timeoutMs)
  const timeoutMs = requested === undefined ? MAX_TIMEOUT_MS : Math.max(1, Math.min(MAX_TIMEOUT_MS, requested))
  const deadline = Date.now() + timeoutMs

  return new Promise(resolve => {
    let settled = false
    let timer
    const abort = () => finish(fail('cancelled'))
    function finish (result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    function afterAwait () {
      return guard() ?? (Date.now() >= deadline ? fail('requestTimeout') : null)
    }
    signal?.addEventListener('abort', abort, { once: true })
    const revoked = guard()
    if (revoked) { finish(revoked); return }
    if (settled) return
    timer = setTimeout(() => finish(guard() ?? fail('requestTimeout')), timeoutMs)
    let pending
    try { pending = call(plan.action, plan.params, { timeoutMs }) } catch {
      finish(afterAwait() ?? fail('requestFailed'))
      return
    }
    Promise.resolve(pending).then(response => {
      if (settled) return
      const revokedAfterAwait = afterAwait()
      if (revokedAfterAwait) { finish(revokedAfterAwait); return }
      if (!object(response) || response.ok !== true) { finish(fail('requestFailed')); return }
      const url = httpUrl(own(response.data, 'url'))
      finish(url === '' ? fail('invalidResponse') : { ok: true, url })
    }, () => {
      if (!settled) finish(afterAwait() ?? fail('requestFailed'))
    })
  })
}
