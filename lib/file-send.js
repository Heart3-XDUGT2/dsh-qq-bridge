/**
 * 037-A：仅接已获准的有界字节与固定QQ目标；不读取路径、不落盘、不重发。
 * result为调用方的终态；physicalDone才释放本端未决额度，不表示远端任务可撤销。
 */
import { randomBytes } from 'node:crypto'

const HARD_BYTES = 8 * 1024 * 1024
const HARD_CONCURRENT = 2
const HARD_TIMEOUT = 60000
const HARD_FRAME_BYTES = 4 * Math.ceil(HARD_BYTES / 3) + 4096
const HARD_BUFFERED_BYTES = HARD_CONCURRENT * HARD_FRAME_BYTES
const RUNTIME = Symbol.for('dsh-echo-qq.file-upload-runtime.v1')
const INPUT_KEYS = new Set(['chatType', 'chatId', 'name', 'data', 'signal', 'isCurrent', 'deadlineAt'])
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype)
const VIEW_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'buffer').get
const VIEW_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'byteOffset').get
const VIEW_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'byteLength').get
const BUFFER_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const BUFFER_RESIZABLE = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum
const safeResult = (state, code, bytes) => Object.freeze({
  ok: state === 'confirmed', state, code,
  ...(integer(bytes, 1, Number.MAX_SAFE_INTEGER) ? { bytes } : {})
})
const immediate = (code, bytes) => Object.freeze({
  result: Promise.resolve(safeResult('not_submitted', code, bytes)),
  physicalDone: Promise.resolve()
})

function runtime () {
  let value = globalThis[RUNTIME]
  if (value === undefined) {
    value = { version: 1, nonce: randomBytes(16).toString('hex'), sequence: 0, slots: new Set(), frames: new Map() }
    Object.defineProperty(globalThis, RUNTIME, { value, writable: false, configurable: false, enumerable: false })
  }
  if (!object(value) || value.version !== 1 || !(value.slots instanceof Set)
    || typeof value.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(value.nonce)
    || !integer(value.sequence, 0, Number.MAX_SAFE_INTEGER)) throw Error('INVALID_FILE_UPLOAD_RUNTIME')
  if (value.frames === undefined) value.frames = new Map()
  if (!(value.frames instanceof Map)) throw Error('INVALID_FILE_UPLOAD_RUNTIME')
  return value
}

function exactlyTrue (callback, argument) {
  try {
    const answer = callback(argument)
    // 不接受异步准入；同时消费错误异步guard的rejection。
    if (answer !== true && answer !== null && typeof answer === 'object' && typeof answer.then === 'function') {
      Promise.resolve(answer).catch(() => {})
    }
    return answer === true
  } catch { return false }
}

function validName (name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 160
    || name.trim() !== name || name === '.' || name === '..'
    || /[\\/:?\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)) return false
  for (const character of name) {
    const code = character.codePointAt(0)
    if (code >= 0xd800 && code <= 0xdfff) return false
  }
  return true
}

function admittedView (data) {
  if (!(data instanceof Uint8Array)) return null
  const buffer = VIEW_BUFFER.call(data)
  if (!(buffer instanceof ArrayBuffer) || BUFFER_RESIZABLE?.call(buffer) === true) return null
  const offset = VIEW_OFFSET.call(data), length = VIEW_LENGTH.call(data)
  if (!integer(length, 1, Number.MAX_SAFE_INTEGER) || !integer(offset, 0, Number.MAX_SAFE_INTEGER)
    || BUFFER_LENGTH.call(buffer) < offset + length) return null
  return { buffer, offset, length }
}
function sameView (data, admitted) {
  try {
    const current = admittedView(data)
    return current !== null && current.buffer === admitted.buffer
      && current.offset === admitted.offset && current.length === admitted.length
  } catch { return false }
}

function responseOf (response) {
  try {
    if (!object(response)) return ['unknown', 'UNCONFIRMED']
    if (response.status === 'ok' && response.retcode === 0) {
      const fileId = object(response.data) ? response.data.file_id : null
      if (typeof fileId === 'string' && fileId.length > 0 && fileId.length <= 512
        && fileId.trim() === fileId && !/[\u0000-\u0020\u007f-\u009f]/.test(fileId)) return ['confirmed', 'CONFIRMED']
      return ['unknown', 'UNCONFIRMED']
    }
    if (response.status === 'failed' && integer(response.retcode, 1, 2147483647)) return ['rejected', 'REMOTE_REJECTED']
    return ['unknown', 'UNCONFIRMED']
  } catch { return ['unknown', 'UNCONFIRMED'] }
}

export function createFileUploadTransport (options = {}) {
  if (!object(options)) throw Error('INVALID_FILE_UPLOAD_OPTIONS')
  const {
    connectionOf, isConnectionCurrent, maxFileBytes = HARD_BYTES,
    maxConcurrent = HARD_CONCURRENT, timeoutMs = HARD_TIMEOUT, maxBufferedBytes = HARD_BUFFERED_BYTES,
    now = Date.now, monotonicNow = () => performance.now()
  } = options
  if (typeof connectionOf !== 'function' || typeof isConnectionCurrent !== 'function'
    || typeof now !== 'function' || typeof monotonicNow !== 'function'
    || !integer(maxFileBytes, 1, HARD_BYTES) || !integer(maxConcurrent, 1, HARD_CONCURRENT)
    || !integer(timeoutMs, 1, HARD_TIMEOUT)
    || !integer(maxBufferedBytes, 1, HARD_BUFFERED_BYTES)) throw Error('INVALID_FILE_UPLOAD_OPTIONS')
  const shared = runtime(), tasks = new Map()
  const echoPrefix = 'echo-file-' + shared.nonce + '-'

  function clearClosedFrames () {
    for (const [token, lease] of shared.frames) {
      try { if (lease.socket.readyState === 3) shared.frames.delete(token) } catch {}
    }
  }
  function bufferedBytes (binding) {
    try {
      const bytes = binding.socket.bufferedAmount
      return integer(bytes, 0, Number.MAX_SAFE_INTEGER) ? bytes : null
    } catch { return null }
  }
  function releaseFrame (task) {
    shared.frames.delete(task.frameLease)
  }

  function clock () {
    const wall = now(), monotonic = monotonicNow()
    if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) throw Error('CLOCK_UNAVAILABLE')
    return { wall, monotonic }
  }
  function expired (task) {
    try {
      const time = clock()
      return time.wall >= task.wallDeadline || time.monotonic >= task.monotonicDeadline
    } catch { return true }
  }
  function live (task) {
    if (task.invalidated || task.physicalEnded || task.signal.aborted) return false
    const permitted = exactlyTrue(task.isCurrent)
    if (!permitted || task.signal.aborted) return false
    if (!exactlyTrue(isConnectionCurrent, task.binding) || task.signal.aborted) return false
    try { return task.binding.socket.readyState === 1 && !task.signal.aborted } catch { return false }
  }
  function logical (task, state, code) {
    if (task.resultDone) return
    task.resultDone = true
    clearInterval(task.watch)
    task.signal.removeEventListener('abort', task.onAbort)
    task.resolveResult(safeResult(state, code, task.bytes))
  }
  function physical (task) {
    if (task.physicalEnded) return
    task.physicalEnded = true
    clearTimeout(task.timer); clearInterval(task.watch)
    task.signal.removeEventListener('abort', task.onAbort)
    tasks.delete(task.echo)
    shared.slots.delete(task.slot)
    // 原deadline不代表ws发送缓存已释放。已提交帧只由成功写回调/真正close回收。
    if (!task.submitted) releaseFrame(task)
    task.snapshot = null
    task.name = null
    task.chatId = null
    task.isCurrent = null
    task.resolvePhysical()
  }
  function stopTask (task, code) {
    logical(task, task.submitted ? 'unknown' : 'not_submitted', code)
    if (!task.submitted) physical(task)
  }
  function onDeadline (task) {
    if (task.physicalEnded) return
    if (!expired(task)) {
      let remaining = 1
      try { remaining = Math.max(1, Math.min(task.wallDeadline - now(), task.monotonicDeadline - monotonicNow())) } catch {}
      task.timer = setTimeout(() => onDeadline(task), remaining)
      return
    }
    logical(task, task.submitted ? 'unknown' : 'not_submitted', 'TIMEOUT')
    physical(task)
  }
  function dispatch (task) {
    if (task.physicalEnded) return
    let frame
    try {
      if (!live(task)) { stopTask(task, task.signal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE'); return }
      if (expired(task)) { stopTask(task, 'TIMEOUT'); return }
      const action = task.chatType === 'private' ? 'upload_private_file' : 'upload_group_file'
      const targetKey = task.chatType === 'private' ? 'user_id' : 'group_id'
      frame = JSON.stringify({
        action,
        params: { [targetKey]: task.chatId, file: 'base64://' + task.snapshot.toString('base64'),
          name: task.name, upload_file: true },
        echo: task.echo
      })
      task.snapshot = null
      task.name = null
      task.chatId = null
      if (Buffer.byteLength(frame, 'utf8') !== task.frameBytes || task.frameBytes > HARD_FRAME_BYTES) {
        stopTask(task, 'PREPARE_FAILED'); return
      }
      // 包含编码时间；guard自身也可能同步触发取消。
      if (!live(task)) { stopTask(task, task.signal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE'); return }
      if (expired(task)) { stopTask(task, 'TIMEOUT'); return }
      if (task.signal.aborted || task.physicalEnded) { stopTask(task, 'ABORTED'); return }
      const buffered = bufferedBytes(task.binding)
      if (buffered === null || buffered + task.frameBytes > maxBufferedBytes) { stopTask(task, 'BACKPRESSURE'); return }
      const socket = task.binding.socket
      task.submitted = true // 紧贴可能写WS的调用；之后的异常不能承诺没有副作用。
      socket.send(frame, error => {
        // ws错误回调发生时，内部队列仍可能保留帧；错误不能提前解除字节预算。
        if (error) { if (!task.physicalEnded) logical(task, 'unknown', 'WRITE_UNKNOWN') }
        else releaseFrame(task)
      })
    } catch {
      if (!task.physicalEnded) {
        if (task.submitted) logical(task, 'unknown', 'WRITE_UNKNOWN')
        else { logical(task, 'not_submitted', 'PREPARE_FAILED'); physical(task) }
      }
    } finally {
      frame = null
      task.snapshot = null
    }
  }

  function beginFileUpload (input) {
    let signal, isCurrent, chatType, chatId, name, data, deadlineAt, started, admitted
    try {
      started = clock()
      if (!object(input) || Object.keys(input).some(key => !INPUT_KEYS.has(key))) return immediate('INVALID_INPUT')
      ;({ signal, isCurrent, chatType, chatId, name, data, deadlineAt } = input)
      if (!['private', 'group'].includes(chatType) || typeof chatId !== 'string'
        || !/^[1-9][0-9]{0,19}$/.test(chatId)) return immediate('INVALID_TARGET')
      if (!validName(name)) return immediate('INVALID_NAME')
      // 在任何调用方callback前固定视图；拒RAB，不让guard扩容后重新取动态length。
      admitted = admittedView(data)
      if (admitted === null) return immediate('INVALID_INPUT')
      if (admitted.length > maxFileBytes) return immediate('FILE_TOO_LARGE', admitted.length)
      if (!(signal instanceof AbortSignal) || typeof isCurrent !== 'function'
        || (deadlineAt !== undefined && !integer(deadlineAt, 1, Number.MAX_SAFE_INTEGER))) return immediate('INVALID_INPUT')
      if (signal.aborted) return immediate('ABORTED')
      if (!exactlyTrue(isCurrent) || signal.aborted) return immediate(signal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE')
      if (!sameView(data, admitted)) return immediate('INVALID_INPUT')
    } catch { return immediate('INVALID_INPUT') }
    const remaining = Math.min(timeoutMs, deadlineAt === undefined ? timeoutMs : deadlineAt - started.wall)
    if (remaining <= 0) return immediate('TIMEOUT')
    let binding
    try {
      binding = connectionOf()
      if (!object(binding) || !object(binding.socket) || !exactlyTrue(isConnectionCurrent, binding)
        || binding.socket.readyState !== 1) return immediate('NO_CONNECTION')
    } catch { return immediate('NO_CONNECTION') }
    if (signal.aborted) return immediate('ABORTED')
    if (!sameView(data, admitted)) return immediate('INVALID_INPUT')
    if (tasks.size >= maxConcurrent || shared.slots.size >= HARD_CONCURRENT
      || shared.sequence >= Number.MAX_SAFE_INTEGER) return immediate('BUSY')
    clearClosedFrames()
    const echo = echoPrefix + (shared.sequence + 1)
    let frameBytes
    try {
      const targetKey = chatType === 'private' ? 'user_id' : 'group_id'
      frameBytes = Buffer.byteLength(JSON.stringify({
        action: chatType === 'private' ? 'upload_private_file' : 'upload_group_file',
        params: { [targetKey]: chatId, file: 'base64://', name, upload_file: true }, echo
      }), 'utf8') + 4 * Math.ceil(admitted.length / 3)
    } catch { return immediate('PREPARE_FAILED') }
    const buffered = bufferedBytes(binding)
    const heldBytes = [...shared.frames.values()].reduce((sum, lease) => sum + lease.bytes, 0)
    if (buffered === null || buffered + frameBytes > maxBufferedBytes || frameBytes > HARD_FRAME_BYTES
      || shared.frames.size >= HARD_CONCURRENT || heldBytes + frameBytes > HARD_BUFFERED_BYTES) return immediate('BACKPRESSURE')

    const slot = Symbol('file-upload-slot')
    const frameLease = Symbol('file-upload-frame')
    shared.slots.add(slot)
    shared.frames.set(frameLease, { socket: binding.socket, bytes: frameBytes })
    shared.sequence++
    let resolveResult, resolvePhysical
    const result = new Promise(resolve => { resolveResult = resolve })
    const physicalDone = new Promise(resolve => { resolvePhysical = resolve })
    const task = {
      slot, frameLease, frameBytes, binding, chatType, chatId, name, signal, isCurrent, bytes: admitted.length,
      echo, submitted: false, invalidated: false,
      resultDone: false, physicalEnded: false, resolveResult, resolvePhysical, snapshot: null,
      timer: null, watch: null, onAbort: null,
      wallDeadline: started.wall + remaining, monotonicDeadline: started.monotonic + remaining
    }
    task.onAbort = () => stopTask(task, 'ABORTED')
    tasks.set(task.echo, task)
    signal.addEventListener('abort', task.onAbort, { once: true })
    // 不unref此截止计时器：即使调用者已取消，physicalDone仍须可靠结算。
    task.timer = setTimeout(() => onDeadline(task), remaining)
    task.watch = setInterval(() => {
      if (!live(task)) stopTask(task, task.signal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE')
    }, 25)
    task.watch.unref?.()
    try {
      // 复制明确视图；不detach caller，不保留池化Buffer周围字节。
      if (!sameView(data, admitted)) {
        logical(task, 'not_submitted', 'INVALID_INPUT')
        physical(task)
        return Object.freeze({ result, physicalDone })
      }
      task.snapshot = Buffer.from(new Uint8Array(admitted.buffer, admitted.offset, admitted.length))
      if (!live(task)) stopTask(task, signal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE')
      else if (expired(task)) stopTask(task, 'TIMEOUT')
      else queueMicrotask(() => dispatch(task))
    } catch {
      logical(task, 'not_submitted', 'PREPARE_FAILED')
      physical(task)
    }
    return Object.freeze({ result, physicalDone })
  }

  function handleResponse (socket, response) {
    let key
    try { key = response?.echo } catch { return false }
    if (typeof key !== 'string' || !key.startsWith(echoPrefix)) return false
    const task = tasks.get(key)
    // 消费专用echo（也包括错socket、重复及迟到），不落到旧普通call/错误JSON路径。
    if (!task || task.physicalEnded || !task.submitted || task.binding.socket !== socket) return true
    if (task.resultDone) { physical(task); return true }
    if (expired(task)) logical(task, 'unknown', 'TIMEOUT')
    else if (!live(task)) logical(task, 'unknown', task.signal.aborted ? 'ABORTED' : 'ORIGIN_UNAVAILABLE')
    else {
      const [state, code] = responseOf(response)
      if (expired(task)) logical(task, 'unknown', 'TIMEOUT')
      else if (task.signal.aborted || task.invalidated) logical(task, 'unknown', 'ABORTED')
      else logical(task, state, code)
    }
    physical(task)
    return true
  }
  function disconnect (socket) {
    for (const task of tasks.values()) if (task.binding.socket === socket) {
      task.invalidated = true
      stopTask(task, 'CONNECTION_LOST')
    }
    // error事件也可能调用disconnect；OPEN/CLOSING都不能伪称缓存已释放。
    clearClosedFrames()
  }
  function invalidateAll () {
    for (const task of tasks.values()) {
      task.invalidated = true
      stopTask(task, 'INVALIDATED')
    }
  }
  return Object.freeze({
    beginFileUpload, handleResponse, disconnect, invalidateAll,
    stats: () => ({ active: tasks.size, globalActive: shared.slots.size,
      bufferedFrames: shared.frames.size, bufferedFrameBytes: [...shared.frames.values()].reduce((sum, lease) => sum + lease.bytes, 0) })
  })
}
