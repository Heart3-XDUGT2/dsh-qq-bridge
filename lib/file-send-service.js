/**
 * 037-C2：当前原生QQ主人来源的文件提交授权；只接受控字节，不读路径。
 * A负责快照与物理额度；本层销毁只撤销guard，绝不替换A的physicalDone。
 */
import { isPromise } from 'node:util/types'
import { allowsInbound } from './config.js'

const HARD_TIMEOUT = 60000
const INPUT_KEYS = new Set(['chatType', 'chatId', 'name', 'data', 'signal', 'isCurrent', 'deadlineAt'])
const SAFE_CODES = Object.freeze({
  confirmed: new Set(['CONFIRMED']),
  rejected: new Set(['REMOTE_REJECTED']),
  not_submitted: new Set([
    'INVALID_INPUT', 'INVALID_TARGET', 'INVALID_NAME', 'FILE_TOO_LARGE', 'ABORTED',
    'ORIGIN_UNAVAILABLE', 'TIMEOUT', 'NO_CONNECTION', 'BUSY', 'BACKPRESSURE',
    'PREPARE_FAILED', 'CONNECTION_LOST', 'INVALIDATED', 'CLOSED'
  ]),
  unknown: new Set([
    'UNCONFIRMED', 'ABORTED', 'ORIGIN_UNAVAILABLE', 'TIMEOUT', 'WRITE_UNKNOWN',
    'CONNECTION_LOST', 'INVALIDATED', 'SERVICE_UNKNOWN'
  ])
})
const UNAVAILABLE = Symbol('unavailable')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
const positiveInteger = value => Number.isSafeInteger(value) && value > 0
const safeResult = (state, code, bytes) => Object.freeze({
  ok: state === 'confirmed', state, code,
  ...(positiveInteger(bytes) ? { bytes } : {})
})
const immediate = code => Object.freeze({
  result: Promise.resolve(safeResult('not_submitted', code)),
  physicalDone: Promise.resolve()
})
const unknown = () => safeResult('unknown', 'SERVICE_UNKNOWN')

// 所有授权查询必须同步。错误异步回调仍需消费rejection，不能留下后台拒绝。
function synchronous (value) {
  try {
    if (isPromise(value)) { consume(value); return UNAVAILABLE }
    if (value !== null && (typeof value === 'object' || typeof value === 'function')
      && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {})
      return UNAVAILABLE
    }
    return value
  } catch { return UNAVAILABLE }
}
function read (callback, receiver, args = []) {
  try { return synchronous(Reflect.apply(callback, receiver, args)) } catch { return UNAVAILABLE }
}
function consume (value) {
  // 畸形句柄也可能携带已经reject的Promise；只消费，不把其当作结算证据。
  try {
    if (isPromise(value)) Promise.prototype.then.call(value, undefined, () => {})
    else synchronous(value)
  } catch {}
}
function sanitize (value) {
  try {
    if (!object(value)) return unknown()
    const { state, code, ok, bytes } = value
    if (!Object.hasOwn(SAFE_CODES, state) || ok !== (state === 'confirmed')
      || !SAFE_CODES[state].has(code)) return unknown()
    return safeResult(state, code, bytes)
  } catch { return unknown() }
}

export function createQQFileSendService (options = {}) {
  if (!object(options)) throw Error('INVALID_FILE_SEND_SERVICE_OPTIONS')
  const { clientOf, settingsOf, isAwake, isCurrent: externalCurrent } = options
  if (typeof clientOf !== 'function' || typeof settingsOf !== 'function'
    || typeof isAwake !== 'function'
    || (externalCurrent !== undefined && typeof externalCurrent !== 'function')) {
    throw Error('INVALID_FILE_SEND_SERVICE_OPTIONS')
  }
  let disposed = false

  function beginFileUpload (input, execution) {
    if (disposed) return immediate('CLOSED')
    const wallStart = Date.now(), monotonicStart = performance.now()
    let chatType, chatId, name, data, signal, callerCurrent, source
    let wallDeadline, monotonicDeadline
    try {
      if (!object(input) || Reflect.ownKeys(input).some(key => !INPUT_KEYS.has(key))) {
        return immediate('INVALID_INPUT')
      }
      // 在调用任何注入回调之前，固定所有来源、目标和取消约束。
      ;({ chatType, chatId, name, data, signal, isCurrent: callerCurrent } = input)
      const deadlineAt = input.deadlineAt
      if (!(signal instanceof AbortSignal) || typeof callerCurrent !== 'function'
        || typeof name !== 'string' || !(data instanceof Uint8Array)
        || (deadlineAt !== undefined && !positiveInteger(deadlineAt))) return immediate('INVALID_INPUT')
      if (!['private', 'group'].includes(chatType) || !id(chatId)) return immediate('INVALID_TARGET')
      const remaining = Math.min(HARD_TIMEOUT, deadlineAt === undefined ? HARD_TIMEOUT : deadlineAt - wallStart)
      wallDeadline = wallStart + remaining
      monotonicDeadline = monotonicStart + remaining
      const original = execution?.source
      if (!object(original)) return immediate('ORIGIN_UNAVAILABLE')
      source = Object.freeze({
        chatType: original.chatType, chatId: original.chatId, senderId: original.senderId,
        isMaster: original.isMaster, platform: original.platform
      })
    } catch { return immediate('INVALID_INPUT') }
    if (source.isMaster !== true || !['private', 'group'].includes(source.chatType)
      || !id(source.chatId) || !id(source.senderId)
      || (source.platform !== undefined && source.platform !== 'qq')
      || (source.chatType === 'private' && source.chatId !== source.senderId)) {
      return immediate('ORIGIN_UNAVAILABLE')
    }
    if (chatType !== source.chatType || chatId !== source.chatId) return immediate('INVALID_TARGET')

    function remaining () {
      return Math.min(wallDeadline - Date.now(), monotonicDeadline - performance.now())
    }
    function stopped () {
      if (disposed) return 'CLOSED'
      if (signal.aborted) return 'ABORTED'
      return remaining() <= 0 ? 'TIMEOUT' : null
    }
    function denied (code) { return stopped() ?? code }
    const firstStop = stopped()
    if (firstStop) return immediate(firstStop)

    const client = read(clientOf)
    const clientStop = stopped()
    if (clientStop) return immediate(clientStop)
    let begin
    try { begin = object(client) ? client.beginFileUpload : null } catch {}
    if (typeof begin !== 'function') return immediate(denied('NO_CONNECTION'))

    // A在快照、编码、写入及回包处重用该guard；从不重新选取目标或客户实例。
    function permissionCode () {
      try {
        let stop = stopped()
        if (stop) return stop
        if (read(callerCurrent) !== true) return denied('ORIGIN_UNAVAILABLE')
        if ((stop = stopped())) return stop
        if (externalCurrent !== undefined && read(externalCurrent) !== true) return denied('ORIGIN_UNAVAILABLE')
        if ((stop = stopped())) return stop

        const settings = read(settingsOf)
        if ((stop = stopped())) return stop
        if (!object(settings)) return 'ORIGIN_UNAVAILABLE'
        const allowed = allowsInbound(settings, {
          chatType: source.chatType, userId: source.senderId,
          groupId: source.chatType === 'group' ? source.chatId : undefined
        })
        if ((stop = stopped())) return stop
        if (allowed.ok !== true) return 'ORIGIN_UNAVAILABLE'
        if (source.chatType === 'group') {
          if (settings.masterId !== source.senderId) return denied('ORIGIN_UNAVAILABLE')
          if (read(isAwake, undefined, [source.chatId]) !== true) return denied('ORIGIN_UNAVAILABLE')
          if ((stop = stopped())) return stop
        }

        const currentClient = read(clientOf)
        if ((stop = stopped())) return stop
        if (currentClient !== client || client.beginFileUpload !== begin) return denied('NO_CONNECTION')
        const status = typeof client.status === 'function' ? read(client.status, client) : UNAVAILABLE
        if ((stop = stopped())) return stop
        if (!object(status) || status.state !== 'client-connected' || !positiveInteger(status.clients)) {
          return denied('NO_CONNECTION')
        }
        return stopped()
      } catch { return denied('ORIGIN_UNAVAILABLE') }
    }
    const code = permissionCode()
    if (code) return immediate(code)
    const guard = () => permissionCode() === null

    function uncertain () {
      // 可能已跨A调用边界，不能假称未写或立即归还调用方的物理名额。
      const physicalDone = new Promise(resolve => {
        function finish () {
          const budget = remaining()
          if (budget <= 0) resolve()
          else setTimeout(finish, Math.max(1, budget))
        }
        finish()
      })
      return Object.freeze({ result: Promise.resolve(unknown()), physicalDone })
    }
    let handle, result, physicalDone
    try {
      handle = Reflect.apply(begin, client, [{
        chatType, chatId, name, data, signal, isCurrent: guard, deadlineAt: wallDeadline
      }])
      if (!object(handle)) { consume(handle); return uncertain() }
      ;({ result, physicalDone } = handle)
      if (!isPromise(result) || !isPromise(physicalDone)) {
        consume(handle); consume(result); consume(physicalDone)
        return uncertain()
      }
      // 只规范result；不因异步撤权改写已经确认的结果，不改变物理结算身份。
      consume(physicalDone)
      return Object.freeze({
        result: Promise.prototype.then.call(result, sanitize, unknown),
        physicalDone
      })
    } catch {
      consume(handle); consume(result); consume(physicalDone)
      return uncertain()
    }
  }

  return Object.freeze({ beginFileUpload, dispose: () => { disposed = true } })
}
