/** 037-A纯传输合成测试：假socket，无网络、用户文件或产品apply。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFileUploadTransport } from '../lib/file-send.js'

const tick = async () => { await Promise.resolve(); await Promise.resolve() }
function rig (t, options = {}) {
  const calls = [], handles = []
  let live = true
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send (text, callback) {
      calls.push(JSON.parse(text))
      if (options.send) options.send(text, callback)
      else callback?.()
    }
  }
  let binding = { socket, generation: 1 }
  const transport = createFileUploadTransport({
    connectionOf: () => binding,
    isConnectionCurrent: one => live && one === binding && one.socket.readyState === 1,
    timeoutMs: 160, ...options.factory
  })
  const begin = patch => {
    const controller = new AbortController()
    const handle = transport.beginFileUpload({
      chatType: 'private', chatId: '12345678901234567890', name: '合成资料.bin',
      data: new Uint8Array([0, 1, 2, 255]), signal: controller.signal, isCurrent: () => live, ...patch
    })
    handles.push(handle)
    return { ...handle, controller }
  }
  const ack = (patch = {}, on = socket, frame = calls.at(-1)) => transport.handleResponse(on, {
    echo: frame?.echo, status: 'ok', retcode: 0, data: { file_id: 'synthetic-file-id' }, ...patch
  })
  t.after(async () => {
    transport.invalidateAll()
    socket.readyState = 3
    transport.disconnect(socket)
    await Promise.all(handles.map(handle => handle.physicalDone))
  })
  return { socket, transport, calls, begin, ack,
    live: value => { live = value },
    connection: value => { binding = value } }
}

for (const chatType of ['private', 'group']) {
  test('037传输：固定' + chatType + '上传参数和成功安全回执', async t => {
    const h = rig(t), task = h.begin({ chatType })
    assert.equal(typeof task.result.then, 'function')
    assert.equal(typeof task.physicalDone.then, 'function')
    await tick()
    assert.equal(h.calls.length, 1)
    const frame = h.calls[0]
    assert.equal(frame.action, chatType === 'private' ? 'upload_private_file' : 'upload_group_file')
    assert.deepEqual(Object.keys(frame.params).sort(), ['file', chatType === 'private' ? 'user_id' : 'group_id', 'name', 'upload_file'].sort())
    assert.equal(frame.params[chatType === 'private' ? 'user_id' : 'group_id'], '12345678901234567890')
    assert.equal(frame.params.name, '合成资料.bin')
    assert.equal(frame.params.upload_file, true)
    assert.deepEqual(Buffer.from(frame.params.file.slice('base64://'.length), 'base64'), Buffer.from([0, 1, 2, 255]))
    h.ack()
    const value = await task.result
    assert.equal(value.state, 'confirmed')
    assert.equal(value.ok, true)
    assert.equal(value.bytes, 4)
    assert.doesNotMatch(JSON.stringify(value), /synthetic-file-id|base64|123456789|合成资料/)
    await task.physicalDone
    assert.equal(h.transport.stats().active, 0)
  })
}

test('037传输：只复制Uint8Array视图，caller修改和池化Buffer周围字节不影响快照', async t => {
  const h = rig(t), data = Buffer.from([9, 1, 2, 3, 9]), view = data.subarray(1, 4)
  const size = data.buffer.byteLength
  const task = h.begin({ data: view })
  view.fill(7)
  assert.equal(data.buffer.byteLength, size)
  await tick()
  assert.equal(h.calls.length, 1)
  assert.deepEqual(Buffer.from(h.calls[0].params.file.slice(9), 'base64'), Buffer.from([1, 2, 3]))
  h.ack()
  assert.equal((await task.result).state, 'confirmed')
})

test('037传输：8MiB整边界实际编码并保留字节，不用额外路径或URL', async t => {
  const h = rig(t, { factory: { timeoutMs: 2000 } })
  const data = new Uint8Array(8 * 1024 * 1024).fill(90), task = h.begin({ data })
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].params.file.length, 'base64://'.length + 4 * Math.ceil(data.length / 3))
  const decoded = Buffer.from(h.calls[0].params.file.slice(9), 'base64')
  assert.equal(decoded.byteLength, data.byteLength)
  assert.equal(decoded.equals(Buffer.from(data)), true)
  h.ack()
  assert.equal((await task.result).state, 'confirmed')
  await task.physicalDone
})

test('037传输：ResizableArrayBuffer不能借guard扩容绕过已准入大小', async t => {
  const h = rig(t, { factory: { maxFileBytes: 4 } })
  const buffer = new ArrayBuffer(1, { maxByteLength: 8 })
  assert.equal(buffer.resizable, true)
  const task = h.begin({ data: new Uint8Array(buffer), isCurrent: () => { buffer.resize(8); return true } })
  await tick()
  // 旧实现会写出8字节；这里只在旧实现仍提交时及时回包，避免红测占额超时。
  if (h.calls.length) h.ack()
  assert.equal((await task.result).state, 'not_submitted')
  assert.equal(h.calls.length, 0)
  await task.physicalDone
})

test('037传输：guard转移detach源ArrayBuffer后不能分配或提交空/变长快照', async t => {
  const h = rig(t), data = new Uint8Array([1, 2, 3])
  const task = h.begin({ data, isCurrent: () => {
    if (data.buffer.byteLength) structuredClone(data.buffer, { transfer: [data.buffer] })
    return true
  } })
  assert.equal((await task.result).state, 'not_submitted')
  await task.physicalDone
  assert.equal(h.calls.length, 0)
  assert.equal(h.transport.stats().active, 0)
})

const invalid = [
  ['empty', { data: new Uint8Array() }],
  ['oversize', { data: new Uint8Array(8 * 1024 * 1024 + 1) }],
  ['array', { data: [1, 2, 3] }],
  ['shared', { data: new Uint8Array(new SharedArrayBuffer(4)) }],
  ['target-kind', { chatType: 'guild' }],
  ['target-zero', { chatId: '0' }],
  ['target-number', { chatId: 11 }],
  ['target-space', { chatId: '11 ' }],
  ['target-arbitrary', { chatId: 'private:11' }],
  ['missing-signal', { signal: undefined }],
  ['missing-guard', { isCurrent: undefined }],
  ['false-guard', { isCurrent: () => false }],
  ['truthy-guard', { isCurrent: () => 1 }],
  ['async-guard', { isCurrent: async () => { throw Error('synthetic-secret') } }],
  ['arbitrary-action', { action: 'send_private_msg' }],
  ['url', { url: 'https://synthetic.invalid/private' }],
  ['folder', { folder: '/synthetic' }],
  ['invalid-deadline', { deadlineAt: 'tomorrow' }]
]
for (const [name, patch] of invalid) test('037传输：前置拒绝不编码发送 ' + name, async t => {
  const h = rig(t), task = h.begin(patch)
  const value = await task.result
  assert.equal(value.state, 'not_submitted')
  assert.equal(value.ok, false)
  await task.physicalDone
  assert.equal(h.calls.length, 0)
  assert.doesNotMatch(JSON.stringify(value), /synthetic-secret|synthetic\.invalid|tomorrow/)
})

for (const name of ['', '.', '..', '../file.txt', 'C:\\private\\file.txt', 'file:///fake', 'bad\nname.txt', ' bad.txt', 'bad.txt ', '\ud800.txt']) {
  test('037传输：安全叶名拒绝 ' + JSON.stringify(name), async t => {
    const h = rig(t), task = h.begin({ name })
    assert.equal((await task.result).state, 'not_submitted')
    assert.equal(h.calls.length, 0)
    await task.physicalDone
  })
}

test('037传输：没有连接和已过期截止不写socket', async t => {
  for (const configure of [h => h.connection(null), () => {}]) {
    const h = rig(t); configure(h)
    const task = h.begin(configure.toString().includes('connection') ? {} : { deadlineAt: Date.now() - 1 })
    assert.equal((await task.result).state, 'not_submitted')
    await task.physicalDone
    assert.equal(h.calls.length, 0)
  }
})

test('037传输：写前同步取消，包括guard同步abort后仍true，都不能提交', async t => {
  const h = rig(t)
  const early = new AbortController(); early.abort()
  assert.equal((await h.begin({ signal: early.signal }).result).state, 'not_submitted')
  const during = new AbortController()
  const task = h.begin({ signal: during.signal, isCurrent: () => { during.abort(); return true } })
  assert.equal((await task.result).state, 'not_submitted')
  const immediate = h.begin(); immediate.controller.abort()
  assert.equal((await immediate.result).state, 'not_submitted')
  assert.equal(h.calls.length, 0)
})

for (const fileId of [null, '', ' ', 1, {}, 'x'.repeat(513), 'bad\nid']) {
  test('037传输：空/畸形file_id只记unknown ' + typeof fileId, async t => {
    const h = rig(t), task = h.begin()
    await tick()
    h.ack({ data: { file_id: fileId, token: 'synthetic-secret', file: 'base64://private' } })
    const value = await task.result
    assert.equal(value.state, 'unknown')
    assert.doesNotMatch(JSON.stringify(value), /synthetic-secret|base64|file_id/)
    await task.physicalDone
  })
}

test('037传输：明确拒绝安全分类，不返回远端wording/路径/base64', async t => {
  const h = rig(t), task = h.begin()
  await tick()
  h.ack({ status: 'failed', retcode: 100, wording: 'C:\\private\\secret base64://opaque token=fiction',
    data: { file_id: 'should-not-confirm' } })
  const value = await task.result
  assert.equal(value.state, 'rejected')
  assert.equal(value.ok, false)
  assert.doesNotMatch(JSON.stringify(value), /private|secret|base64|fiction|should-not-confirm/)
  await task.physicalDone
})

test('037传输：错socket/错echo不能确认；重复/迟到回包不改终态', async t => {
  const h = rig(t), task = h.begin()
  await tick()
  const other = { readyState: 1 }
  h.ack({}, other)
  h.ack({ echo: 'echo-ordinary' })
  let settled = false
  task.result.then(() => { settled = true })
  await tick()
  assert.equal(settled, false)
  h.ack()
  const value = await task.result, saved = JSON.stringify(value)
  assert.equal(value.state, 'confirmed')
  h.ack({ status: 'failed', retcode: 1 })
  assert.equal(JSON.stringify(value), saved)
  assert.equal(h.calls.length, 1)
})

test('037传输：写后取消立即unknown，物理pending保持，匹配回包仅释放额度', async t => {
  const h = rig(t), task = h.begin()
  await tick(); task.controller.abort()
  const value = await task.result
  assert.equal(value.state, 'unknown')
  let physical = false
  task.physicalDone.then(() => { physical = true })
  await tick()
  assert.equal(physical, false)
  assert.equal(h.transport.stats().active, 1)
  const saved = JSON.stringify(value)
  h.ack()
  await task.physicalDone
  assert.equal(h.transport.stats().active, 0)
  assert.equal(JSON.stringify(value), saved)
  assert.equal(h.calls.length, 1)
})

for (const method of ['disconnect', 'invalidateAll', 'guard']) {
  test('037传输：写后' + method + '不能伪称未发送或重连重放', async t => {
    const h = rig(t), task = h.begin()
    await tick()
    if (method === 'disconnect') h.transport.disconnect(h.socket)
    else if (method === 'invalidateAll') h.transport.invalidateAll()
    else h.live(false)
    assert.equal((await task.result).state, 'unknown')
    assert.equal(h.transport.stats().active, 1)
    await task.physicalDone
    assert.equal(h.calls.length, 1)
    assert.equal(h.transport.stats().active, 0)
  })
}

test('037传输：取消后全局2额度跨工厂/模块实例保持，不能第三次提交', async t => {
  const a = rig(t), b = rig(t), c = rig(t)
  const first = a.begin(), second = b.begin()
  await tick()
  first.controller.abort(); second.controller.abort()
  assert.equal((await first.result).state, 'unknown')
  assert.equal((await second.result).state, 'unknown')
  const third = c.begin()
  assert.equal((await third.result).code, 'BUSY')
  assert.equal(c.calls.length, 0)
  await third.physicalDone
  const { createFileUploadTransport: alternate } = await import('../lib/file-send.js?scope-independent')
  const alternateTransport = alternate({
    connectionOf: () => ({ socket: c.socket, generation: 99 }), isConnectionCurrent: () => true, timeoutMs: 160
  })
  const fourth = alternateTransport.beginFileUpload({
    chatType: 'private', chatId: '11', name: '合成.bin', data: new Uint8Array([1]),
    signal: new AbortController().signal, isCurrent: () => true
  })
  assert.equal((await fourth.result).code, 'BUSY')
  a.ack(); await first.physicalDone
  const accepted = c.begin()
  await tick(); c.ack()
  assert.equal((await accepted.result).state, 'confirmed')
  b.ack(); await second.physicalDone
})

for (const failure of ['throw', 'callback']) {
  test('037传输：send ' + failure + '进入边界后为unknown，持有物理名额至原期限', async t => {
    const h = rig(t, { send: (_text, callback) => {
      const error = Error('C:\\secret\\path token=fiction base64://private')
      if (failure === 'throw') throw error
      callback(error)
    } })
    const task = h.begin()
    assert.equal((await task.result).state, 'unknown')
    assert.equal(h.transport.stats().active, 1)
    await task.physicalDone
    assert.equal(h.transport.stats().active, 0)
    assert.equal(h.calls.length, 1)
    assert.doesNotMatch(JSON.stringify(await task.result), /secret|fiction|base64/)
  })
}

test('037传输：期限涵盖等待，迟到成功不能抢先过期计时器', async t => {
  const h = rig(t, { factory: { timeoutMs: 80 } }), task = h.begin()
  await tick()
  const until = performance.now() + 100
  while (performance.now() < until) {}
  h.ack()
  assert.equal((await task.result).state, 'unknown')
  await task.physicalDone
  assert.equal(h.calls.length, 1)
})

test('037传输：原deadline释放额度后，不drain的WS缓存仍阻止反复堆积文件帧', async t => {
  let pendingBytes = 0
  const h = rig(t, { factory: { timeoutMs: 60, maxBufferedBytes: 600 }, send: text => {
    pendingBytes += Buffer.byteLength(text)
    h.socket.bufferedAmount = pendingBytes
  } })
  const first = h.begin()
  assert.equal((await first.result).state, 'unknown')
  await first.physicalDone
  const second = h.begin()
  assert.equal((await second.result).state, 'unknown')
  await second.physicalDone
  assert.equal(h.calls.length, 2)
  const third = h.begin()
  assert.equal((await third.result).state, 'not_submitted')
  assert.equal((await third.result).code, 'BACKPRESSURE')
  await third.physicalDone
  assert.equal(h.calls.length, 2)
  assert.ok(h.socket.bufferedAmount <= 600)
})

test('037传输：不可验证bufferedAmount或连接getter异常仍只返回安全handle', async t => {
  const h = rig(t)
  h.socket.bufferedAmount = undefined
  assert.equal((await h.begin().result).state, 'not_submitted')
  assert.equal(h.calls.length, 0)
  const throwing = createFileUploadTransport({
    connectionOf: () => ({ get socket () { throw Error('private-path') } }), isConnectionCurrent: () => true
  })
  const handle = throwing.beginFileUpload({
    chatType: 'private', chatId: '11', name: '合成.bin', data: new Uint8Array([1]),
    signal: new AbortController().signal, isCurrent: () => true
  })
  assert.equal((await handle.result).state, 'not_submitted')
  await handle.physicalDone
  assert.doesNotMatch(JSON.stringify(await handle.result), /private-path/)
})

test('037传输：不同socket/新实例不能绕过未写完帧的全局内存名额', async t => {
  const slow = text => { /* 模拟send接受帧但从不调用本地写完成callback */ }
  const a = rig(t, { factory: { timeoutMs: 60 }, send: slow })
  const b = rig(t, { factory: { timeoutMs: 60 }, send: slow })
  const c = rig(t)
  const first = a.begin(), second = b.begin()
  await Promise.all([first.physicalDone, second.physicalDone])
  assert.equal((await first.result).state, 'unknown')
  assert.equal((await second.result).state, 'unknown')
  assert.equal(a.transport.stats().globalActive, 0)
  const third = c.begin()
  assert.equal((await third.result).code, 'BACKPRESSURE')
  assert.equal(c.calls.length, 0)
  a.socket.readyState = 3
  a.transport.disconnect(a.socket)
  const accepted = c.begin()
  await tick(); c.ack()
  assert.equal((await accepted.result).state, 'confirmed')
})

test('037传输：配置只可降低硬上限', () => {
  for (const patch of [{ maxFileBytes: 8388609 }, { maxConcurrent: 3 }, { timeoutMs: 60001 },
    { timeoutMs: 0 }, { maxConcurrent: 0 }, { maxBufferedBytes: 999999999 }]) {
    assert.throws(() => createFileUploadTransport({ connectionOf: () => null, isConnectionCurrent: () => false, ...patch }),
      /INVALID_FILE_UPLOAD_OPTIONS/)
  }
})
