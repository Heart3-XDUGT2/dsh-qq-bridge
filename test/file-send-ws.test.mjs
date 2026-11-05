/** 037-A：真实回环WS、合成字节；不连接NapCat/QQ或模型。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createOneBot } from '../lib/onebot.js'

const PRIVATE = 'SYNTHETIC_REMOTE_SECRET_037'
const bytes = value => new TextEncoder().encode(value)
const input = patch => ({
  chatType: 'private', chatId: '11', name: '合成.txt', data: bytes('内容037'),
  signal: new AbortController().signal, isCurrent: () => true, ...patch
})
async function until (condition) {
  const end = Date.now() + 2000
  while (!condition() && Date.now() < end) await delay(2)
  assert.equal(condition(), true, '回环传输须在预算内推进')
}
async function settled (promise, ms = 25) {
  let timer
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })])
  } finally { clearTimeout(timer) }
}
function reply (socket, frame, patch = {}) {
  socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo,
    data: { file_id: 'synthetic-file-confirmation' }, ...patch }))
}
async function fixture (t, { timeoutMs = 800, connected = true } = {}) {
  const probe = createServer()
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const frames = [], logs = [], handles = [], sockets = []
  const server = createOneBot({
    host: '127.0.0.1', port, accessToken: 'synthetic-037', heartbeatMs: 60000,
    fileUploadTimeoutMs: timeoutMs, log: (level, message, extra) => logs.push({ level, message, extra })
  })
  t.after(async () => {
    for (const socket of sockets) { try { socket.close() } catch {} }
    await server.stop()
    await Promise.allSettled(handles.map(h => h.physicalDone))
  })
  await server.start()
  async function connect () {
    const socket = new WebSocket('ws://127.0.0.1:' + port, { headers: { authorization: 'Bearer synthetic-037' } })
    sockets.push(socket)
    socket.on('message', data => frames.push({ socket, frame: JSON.parse(String(data)) }))
    await once(socket, 'open')
    await until(() => server.status().clients === sockets.filter(s => s.readyState === WebSocket.OPEN).length)
    return socket
  }
  const socket = connected ? await connect() : null
  function upload (options = {}) {
    assert.equal(typeof server.beginFileUpload, 'function', '真实OneBot应提供专用文件方法')
    const h = server.beginFileUpload(input(options))
    assert.equal(typeof h?.result?.then, 'function')
    assert.equal(typeof h?.physicalDone?.then, 'function')
    handles.push(h)
    return h
  }
  return { server, frames, logs, handles, sockets, socket, connect, upload }
}
function safe (value, logs = []) {
  const visible = JSON.stringify(value) + JSON.stringify(logs)
  assert.doesNotMatch(visible, /SYNTHETIC_REMOTE_SECRET_037|base64:\/\/|file_id|synthetic-file-confirmation|C:\\synthetic/)
}

for (const chatType of ['private', 'group']) {
  test('037-A WS：' + chatType + '固定上传动作/完整字节/确认，不开放旧call', async t => {
    const f = await fixture(t)
    const original = bytes('中文😀\n合成字节')
    const h = f.upload({ chatType, chatId: chatType === 'private' ? '11' : '33', data: original })
    original.fill(120)
    await until(() => f.frames.length === 1)
    const { frame, socket } = f.frames[0]
    assert.equal(frame.action, chatType === 'private' ? 'upload_private_file' : 'upload_group_file')
    assert.equal(frame.params[chatType === 'private' ? 'user_id' : 'group_id'], chatType === 'private' ? '11' : '33')
    assert.equal(frame.params.upload_file, true)
    assert.equal(frame.params.name, '合成.txt')
    assert.deepEqual(Object.keys(frame.params).sort(),
      [chatType === 'private' ? 'user_id' : 'group_id', 'file', 'name', 'upload_file'].sort())
    assert.match(frame.params.file, /^base64:\/\//)
    assert.equal(Buffer.from(frame.params.file.slice('base64://'.length), 'base64').toString('utf8'), '中文😀\n合成字节')
    const denied = await f.server.call(frame.action, { file: PRIVATE })
    assert.equal(denied.ok, false, '旧call动作白名单不开放上传')
    assert.equal(f.frames.length, 1)
    reply(socket, frame)
    const value = await h.result
    await h.physicalDone
    assert.equal(value.state, 'confirmed')
    assert.equal(value.ok, true)
    safe(value, f.logs)
  })
}

test('037-A WS：真实8MiB上限完整提交，原始字节不被截断', async t => {
  const f = await fixture(t, { timeoutMs: 3000 })
  const data = Buffer.alloc(8 * 1024 * 1024, 90)
  data[0] = 0; data[data.length - 1] = 255
  const h = f.upload({ name: '合成上限.bin', data })
  await until(() => f.frames.length === 1)
  const { socket, frame } = f.frames[0]
  assert.equal(frame.params.file.length, 9 + 4 * Math.ceil(data.length / 3))
  const decoded = Buffer.from(frame.params.file.slice(9), 'base64')
  assert.equal(decoded.length, data.length)
  assert.equal(decoded.equals(data), true)
  reply(socket, frame)
  const value = await h.result
  await h.physicalDone
  assert.equal(value.state, 'confirmed')
  assert.equal(value.bytes, data.length)
})

test('037-A WS：无连接、无效输入、预取消/撤权均确定未提交', async t => {
  const offline = await fixture(t, { connected: false })
  const noConnection = offline.upload()
  assert.equal((await noConnection.result).state, 'not_submitted')
  await noConnection.physicalDone
  const f = await fixture(t)
  const aborted = new AbortController(); aborted.abort()
  for (const options of [
    { chatType: 'official' }, { chatId: '../11' }, { name: '../secret.txt' },
    { data: new Uint8Array(0) }, { data: new Uint8Array(8 * 1024 * 1024 + 1) },
    { signal: aborted.signal }, { isCurrent: () => false }, { deadlineAt: Date.now() - 1 },
    { url: 'http://synthetic.invalid/secret' }, { action: 'upload_group_file' }
  ]) {
    const h = f.upload(options)
    assert.equal((await h.result).state, 'not_submitted')
    await h.physicalDone
  }
  await delay(15)
  assert.equal(f.frames.length, 0)
})

test('037-A WS：begin后立即取消或撤权仍在写前拒绝', async t => {
  const f = await fixture(t)
  const controller = new AbortController(), first = f.upload({ signal: controller.signal })
  controller.abort()
  assert.equal((await first.result).state, 'not_submitted')
  await first.physicalDone
  let current = true
  const second = f.upload({ isCurrent: () => current })
  current = false
  assert.equal((await second.result).state, 'not_submitted')
  await second.physicalDone
  await delay(15)
  assert.equal(f.frames.length, 0)
})

test('037-A WS：null/空/畸形确认及明确拒绝均不泄漏原始响应', async t => {
  const f = await fixture(t)
  for (const [patch, expected] of [
    [{ data: { file_id: null, wording: PRIVATE } }, 'unknown'],
    [{ data: { file_id: '', path: 'C:\\synthetic\\secret.txt' } }, 'unknown'],
    [{ data: { file_id: { private: PRIVATE } } }, 'unknown'],
    [{ data: { file_id: 'x'.repeat(513) } }, 'unknown'],
    [{ status: 'failed', retcode: 1400, wording: PRIVATE,
      data: { file: 'base64://' + PRIVATE, path: 'C:\\synthetic\\secret.txt' } }, 'rejected']
  ]) {
    const count = f.frames.length
    const h = f.upload()
    await until(() => f.frames.length === count + 1)
    reply(f.frames.at(-1).socket, f.frames.at(-1).frame, patch)
    const value = await h.result
    await h.physicalDone
    assert.equal(value.state, expected)
    safe(value, f.logs)
  }
})

test('037-A WS：错echo或其它连接不能确认当前文件', async t => {
  const f = await fixture(t), newer = await f.connect()
  const h = f.upload()
  await until(() => f.frames.length === 1)
  const { frame } = f.frames[0]
  assert.equal(f.frames[0].socket, newer)
  reply(f.socket, frame)
  assert.equal(await settled(h.result), false)
  reply(newer, { ...frame, echo: frame.echo + '-wrong' })
  assert.equal(await settled(h.result), false)
  reply(newer, frame)
  assert.equal((await h.result).state, 'confirmed')
  await h.physicalDone
})

test('037-A WS：写后取消保留物理名额，创建另一OneBot也不能越过全局2', async t => {
  const f = await fixture(t)
  const a = new AbortController(), b = new AbortController()
  const first = f.upload({ signal: a.signal }), second = f.upload({ signal: b.signal })
  await until(() => f.frames.length === 2)
  a.abort(); b.abort()
  const firstValue = await first.result, secondValue = await second.result
  assert.equal(firstValue.state, 'unknown')
  assert.equal(secondValue.state, 'unknown')
  const frozen = JSON.stringify(firstValue)
  assert.equal(await settled(first.physicalDone), false)
  for (let i = 0; i < 5; i++) {
    const busy = f.upload()
    assert.equal((await busy.result).state, 'not_submitted')
    assert.equal((await busy.result).code, 'BUSY')
    await busy.physicalDone
  }
  const other = await fixture(t)
  const stillBusy = other.upload()
  assert.equal((await stillBusy.result).code, 'BUSY')
  await stillBusy.physicalDone
  assert.equal(other.frames.length, 0)
  reply(f.frames[0].socket, f.frames[0].frame)
  await first.physicalDone
  assert.equal(JSON.stringify(firstValue), frozen, '迟到确认不改已返回unknown')
  const next = other.upload()
  await until(() => other.frames.length === 1)
  reply(other.socket, other.frames[0].frame)
  assert.equal((await next.result).state, 'confirmed')
  await next.physicalDone
  reply(f.frames[1].socket, f.frames[1].frame)
  await second.physicalDone
  assert.equal(f.frames.length, 2, '没有取消后自动重发')
})

test('037-A WS：断连与stop/start使旧请求unknown，旧echo不在新连接确认', async t => {
  const f = await fixture(t, { timeoutMs: 350 })
  const first = f.upload()
  await until(() => f.frames.length === 1)
  const oldFrame = f.frames[0].frame
  const closed = once(f.socket, 'close')
  f.socket.close()
  await closed
  assert.equal((await first.result).state, 'unknown')
  assert.equal(await settled(first.physicalDone), false)
  await f.server.stop()
  await f.server.start()
  const currentSocket = await f.connect()
  reply(currentSocket, oldFrame)
  assert.equal(await settled(first.physicalDone), false, '新连接错echo不能释放旧pending额度')
  const current = f.upload()
  await until(() => f.frames.length === 2)
  assert.notEqual(f.frames[1].frame.echo, oldFrame.echo)
  reply(currentSocket, f.frames[1].frame)
  assert.equal((await current.result).state, 'confirmed')
  await current.physicalDone
  await first.physicalDone
  assert.equal(f.frames.length, 2)
})

test('037-A WS：原deadline结算unknown，不自动重放', async t => {
  const f = await fixture(t)
  const h = f.upload({ deadlineAt: Date.now() + 120 })
  await until(() => f.frames.length === 1)
  assert.equal((await h.result).state, 'unknown')
  await h.physicalDone
  await delay(25)
  assert.equal(f.frames.length, 1)
  safe(await h.result, f.logs)
})

test('037-A WS：旧文本call/settle输出和计数保持，文件不挤入文字ACK链', async t => {
  const f = await fixture(t)
  const file = f.upload()
  await until(() => f.frames.length === 1)
  const legacy = f.server.call('get_status', {})
  await until(() => f.frames.length === 2)
  const regular = f.frames.find(x => x.frame.action === 'get_status')
  reply(regular.socket, regular.frame, { data: { online: true } })
  assert.deepEqual(await legacy, { ok: true, data: { online: true } })
  reply(f.frames[0].socket, f.frames[0].frame)
  assert.equal((await file.result).state, 'confirmed')
  await file.physicalDone
  assert.equal(f.server.status().sent, 1, '专用上传不改普通call计数')
  const failure = f.server.call('get_version_info', {})
  await until(() => f.frames.length === 3)
  reply(f.frames[2].socket, f.frames[2].frame, { status: 'failed', retcode: 100,
    wording: 'legacy-output-preserved' })
  const failed = await failure
  assert.equal(failed.ok, false)
  assert.match(failed.error, /legacy-output-preserved/, '旧通用call输出按工单原样保留')
})
