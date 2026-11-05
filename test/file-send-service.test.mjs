/** 037-C2：假配置/客户端与内存A传输；无真实QQ/配置/文件或网络读取。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createQQFileSendService } from '../lib/file-send-service.js'
import { createFileUploadTransport } from '../lib/file-send.js'

const PRIVATE = Object.freeze({ chatType: 'private', chatId: '11', senderId: '11', isMaster: true })
const GROUP = Object.freeze({ chatType: 'group', chatId: '33', senderId: '11', isMaster: true })
const SECRET = 'SYNTHETIC_PRIVATE_MESSAGE_037'
const future = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const argsOf = patch => ({ chatType: 'private', chatId: '11', name: '合成.txt',
  data: new Uint8Array([1, 2, 3]), signal: new AbortController().signal, isCurrent: () => true, ...patch })
const request = source => ({ source: source ?? PRIVATE })
function rig (options = {}) {
  const calls = [], controls = { live: true, awake: true, clients: 1, connected: true }
  const settings = { enabled: true, groupEnabled: true, allowedUsers: ['11', '22'],
    allowedGroups: ['33', '44'], masterId: '11' }
  const physical = future()
  const client = {
    status: () => ({ state: controls.connected ? 'client-connected' : 'closed', clients: controls.clients }),
    beginFileUpload (args) {
      calls.push({ args, self: this })
      return options.begin ? options.begin(args) : {
        result: Promise.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED', bytes: 3 }),
        physicalDone: physical.promise
      }
    }
  }
  let actualClient = client
  const service = createQQFileSendService({
    clientOf: () => actualClient, settingsOf: () => settings,
    isAwake: () => controls.awake, isCurrent: () => controls.live, ...options.factory
  })
  const upload = (args = argsOf(), execution = request()) => service.beginFileUpload(args, execution)
  return { service, upload, client, calls, controls, settings, physical,
    replace: value => { actualClient = value }, close: () => service.dispose() }
}
async function settled (promise, ms = 10) {
  let timer
  try {
    return await Promise.race([promise.then(() => true, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })])
  } finally { clearTimeout(timer) }
}
function safe (value) {
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_PRIVATE_MESSAGE_037|base64:\/\/|file_id|C:\\private|chatId|senderId/)
}

for (const source of [PRIVATE, GROUP]) {
  test('037发送服务：当前owner' + source.chatType + '精确目标通过并原样交付physicalDone', async () => {
    const h = rig(), args = argsOf({ chatType: source.chatType, chatId: source.chatId })
    const before = Date.now(), handle = h.upload(args, request(source))
    const after = Date.now()
    assert.equal(handle.physicalDone, h.physical.promise)
    const result = await handle.result
    assert.equal(result.state, 'confirmed')
    assert.equal(h.calls.length, 1)
    const passed = h.calls[0].args
    assert.equal(h.calls[0].self, h.client)
    assert.equal(passed.chatType, source.chatType)
    assert.equal(passed.chatId, source.chatId)
    assert.equal(passed.data, args.data, 'A负责同步快照，服务不重复复制或读取路径')
    assert.deepEqual(Object.keys(passed).sort(),
      ['chatType', 'chatId', 'name', 'data', 'signal', 'isCurrent', 'deadlineAt'].sort())
    assert.equal(passed.isCurrent(), true)
    assert.equal(passed.deadlineAt >= before + 60000 && passed.deadlineAt <= after + 60000, true)
    safe(result)
    h.physical.resolve(); await handle.physicalDone
  })
}

test('037发送服务：私聊保留白名单owner语义，不能额外要求group的masterId规则', async () => {
  const h = rig(); h.settings.masterId = '99'
  const handle = h.upload()
  assert.equal((await handle.result).state, 'confirmed')
  h.physical.resolve(); await handle.physicalDone
})

for (const source of [
  null, { ...PRIVATE, isMaster: false }, { ...PRIVATE, chatId: '22' },
  { ...PRIVATE, senderId: '22' }, { ...PRIVATE, chatType: 'official' },
  { ...PRIVATE, chatId: '' }, { ...PRIVATE, senderId: 11 },
  { ...PRIVATE, platform: 'qq-official' }
]) test('037发送服务：无可信owner源或源形状不符拒绝 ' + JSON.stringify(source), async () => {
  const h = rig(), result = await h.upload(argsOf(), { source }).result
  assert.equal(result.state, 'not_submitted')
  assert.equal(h.calls.length, 0)
  safe(result)
})

for (const patch of [{ chatType: 'group', chatId: '33' }, { chatId: '22' }]) {
  test('037发送服务：显式目标不等于可信源时不回退 ' + JSON.stringify(patch), async () => {
    const h = rig()
    const result = await h.upload(argsOf(patch), request(PRIVATE)).result
    assert.equal(result.state, 'not_submitted')
    assert.equal(result.code, 'INVALID_TARGET')
    assert.equal(h.calls.length, 0)
  })
}

for (const change of [
  h => { h.settings.enabled = false },
  h => { h.settings.allowedUsers = [] },
  h => { h.controls.live = false },
  h => { h.settings.allowedUsers = ['22'] }
]) test('037发送服务：私聊当前准入撤回拒绝', async () => {
  const h = rig(); change(h)
  assert.equal((await h.upload().result).state, 'not_submitted')
  assert.equal(h.calls.length, 0)
})

for (const change of [
  h => { h.settings.groupEnabled = false },
  h => { h.settings.allowedGroups = [] },
  h => { h.settings.masterId = '22' },
  h => { h.controls.awake = false }
]) test('037发送服务：群当前master/白名单/醒态均须成立', async () => {
  const h = rig(); change(h)
  const result = await h.upload(argsOf({ chatType: 'group', chatId: '33' }), request(GROUP)).result
  assert.equal(result.state, 'not_submitted')
  assert.equal(h.calls.length, 0)
})

for (const client of [
  null, {}, { beginFileUpload: () => {}, status: () => ({ state: 'client-connected', clients: 0 }) },
  { beginFileUpload: () => {}, status: () => ({ state: 'closed', clients: 1 }) },
  { beginFileUpload: () => {}, status: () => { throw Error(SECRET) } }
]) test('037发送服务：实际客户端/连接不足则确定未提交', async () => {
  const h = rig(); h.replace(client)
  const result = await h.upload().result
  assert.equal(result.state, 'not_submitted')
  assert.equal(result.code, 'NO_CONNECTION')
  assert.equal(h.calls.length, 0)
  safe(result)
})

test('037发送服务：源/目标primitive及caller guard在受理时固定，不随输入对象变更跳目标', async () => {
  const h = rig(), source = { ...PRIVATE }, control = { current: true }
  const args = argsOf({ isCurrent: () => control.current })
  const handle = h.upload(args, request(source))
  await handle.result
  source.chatId = '22'; source.senderId = '22'; source.isMaster = false
  args.chatId = '22'; args.isCurrent = () => true
  assert.equal(h.calls[0].args.chatId, '11')
  assert.equal(h.calls[0].args.isCurrent(), true)
  control.current = false
  assert.equal(h.calls[0].args.isCurrent(), false)
  h.physical.resolve(); await handle.physicalDone
})

for (const change of [
  h => { h.settings.enabled = false },
  h => { h.settings.allowedUsers = [] },
  h => { h.controls.live = false },
  h => { h.controls.clients = 0 },
  h => { h.replace({ ...h.client }) },
  h => { h.client.beginFileUpload = () => {} },
  h => { h.close() }
]) test('037发送服务：写后撤权/换客户端/销毁使A guard失效但不释放physicalDone', async () => {
  const h = rig(), handle = h.upload()
  await handle.result
  change(h)
  assert.equal(h.calls[0].args.isCurrent(), false)
  assert.equal(handle.physicalDone, h.physical.promise)
  assert.equal(await settled(handle.physicalDone), false)
  h.physical.resolve(); await handle.physicalDone
})

test('037发送服务：dispose不关闭真实client或提前替换句柄，后续调用CLOSED', async () => {
  const h = rig()
  h.client.stop = () => assert.fail('不能关闭共用OneBot')
  h.client.dispose = () => assert.fail('不能dispose共用客户端')
  const handle = h.upload()
  h.close(); h.close()
  assert.equal(h.calls[0].args.isCurrent(), false)
  assert.equal((await h.upload().result).code, 'CLOSED')
  assert.equal(h.calls.length, 1)
  h.physical.resolve(); await handle.physicalDone
})

for (const during of ['already', 'caller', 'settings', 'status']) {
  test('037发送服务：回调同步abort仍返回true不得提交 ' + during, async () => {
    const controller = new AbortController()
    const h = rig(during === 'settings' ? { factory: {
      settingsOf: () => { controller.abort(); return { enabled: true, allowedUsers: ['11'] } }
    } } : {})
    if (during === 'already') controller.abort()
    if (during === 'status') h.client.status = () => {
      controller.abort(); return { state: 'client-connected', clients: 1 }
    }
    const handle = h.upload(argsOf({ signal: controller.signal, isCurrent: () => {
      if (during === 'caller') controller.abort()
      return true
    } }))
    const result = await handle.result
    assert.equal(result.state, 'not_submitted')
    assert.equal(result.code, 'ABORTED')
    assert.equal(h.calls.length, 0)
  })
}

for (const patch of [
  { path: 'C:\\private\\secret.txt' }, { url: 'https://synthetic.invalid/' }, { action: 'upload_group_file' },
  { folder: 'any' }, { signal: undefined }, { isCurrent: undefined }, { data: 'base64://' + SECRET },
  { deadlineAt: '60' }
]) test('037发送服务：只收A参数，不开放路径/URL/动作 ' + Object.keys(patch).join(','), async () => {
  const h = rig(), result = await h.upload(argsOf(patch)).result
  assert.equal(result.state, 'not_submitted')
  assert.equal(result.code, 'INVALID_INPUT')
  assert.equal(h.calls.length, 0)
  safe(result)
})

test('037发送服务：已过期截止不调客户端，A抛错后保守unknown并占到原截止', async () => {
  const expired = rig()
  assert.equal((await expired.upload(argsOf({ deadlineAt: Date.now() - 1 })).result).code, 'TIMEOUT')
  assert.equal(expired.calls.length, 0)
  const h = rig({ begin: () => { throw Error(SECRET + ' C:\\private\\secret.txt') } })
  const handle = h.upload(argsOf({ deadlineAt: Date.now() + 70 }))
  const result = await handle.result
  assert.equal(result.state, 'unknown')
  assert.equal(result.code, 'SERVICE_UNKNOWN')
  assert.equal(await settled(handle.physicalDone), false)
  h.close()
  await handle.physicalDone
  safe(result)
})

test('037发送服务：畸形A句柄同样unknown，结果拒绝和任意额外字段不泄漏', async () => {
  const malformed = rig({ begin: () => ({ file_id: SECRET }) })
  const first = malformed.upload(argsOf({ deadlineAt: Date.now() + 50 }))
  assert.equal((await first.result).state, 'unknown')
  await first.physicalDone
  const h = rig({ begin: () => ({
    result: Promise.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED', bytes: 3,
      file_id: SECRET, path: 'C:\\private\\secret.txt', body: 'base64://' + SECRET }),
    physicalDone: Promise.resolve()
  }) })
  const value = await h.upload().result
  assert.deepEqual(value, { ok: true, state: 'confirmed', code: 'CONFIRMED', bytes: 3 })
  safe(value)
  const broken = rig({ begin: () => ({ result: Promise.reject(Error(SECRET)), physicalDone: Promise.resolve() }) })
  const result = await broken.upload().result
  assert.equal(result.state, 'unknown')
  safe(result)
})

test('037发送服务：异步/异常授权回调安全拒绝并消费拒绝，不透原始文案', async () => {
  for (const factory of [
    { settingsOf: () => { throw Error(SECRET) } },
    { settingsOf: async () => { throw Error(SECRET) } },
    { clientOf: async () => { throw Error(SECRET) } },
    { isCurrent: async () => { throw Error(SECRET) } }
  ]) {
    const h = rig({ factory }), result = await h.upload().result
    assert.equal(result.state, 'not_submitted')
    assert.equal(h.calls.length, 0)
    safe(result)
  }
  const h = rig(), result = await h.upload(argsOf({ isCurrent: async () => { throw Error(SECRET) } })).result
  assert.equal(result.state, 'not_submitted')
  safe(result)
})

test('037发送服务：隐藏then的原生Promise仍不是同步设置/客户端，拒绝也须消费', async () => {
  const hidden = properties => Object.assign(Object.defineProperty(Promise.reject(Error(SECRET)), 'then', {
    value: undefined
  }), properties)
  for (const factory of [
    { settingsOf: () => hidden({ enabled: true, allowedUsers: ['11'] }) },
    { clientOf: () => hidden({
      status: () => ({ state: 'client-connected', clients: 1 }),
      beginFileUpload: () => assert.fail('异步客户端不能调用')
    }) }
  ]) {
    const h = rig({ factory }), result = await h.upload().result
    assert.equal(result.state, 'not_submitted')
    assert.equal(h.calls.length, 0)
    safe(result)
  }
  await delay(0)
})

test('037发送服务：外部guard/客户端查询/群醒回调内同步取消也不得提交', async () => {
  for (const during of ['external', 'client', 'awake']) {
    const controller = new AbortController()
    let h
    const factory = during === 'external' ? { isCurrent: () => { controller.abort(); return true } }
      : during === 'client' ? { clientOf: () => { controller.abort(); return h.client } }
        : { isAwake: () => { controller.abort(); return true } }
    h = rig({ factory })
    const result = await h.upload(argsOf({ signal: controller.signal, chatType: 'group', chatId: '33' }),
      request(GROUP)).result
    assert.equal(result.code, 'ABORTED')
    assert.equal(result.state, 'not_submitted')
    assert.equal(h.calls.length, 0)
  }
})

test('037发送服务：原截止不能由回调延长，耗尽准备期限则不进入A', async () => {
  const h = rig(), originalDeadline = Date.now() + 500
  const args = argsOf({ deadlineAt: originalDeadline, isCurrent: () => {
    args.deadlineAt = Date.now() + 60000
    return true
  } })
  const handle = h.upload(args)
  assert.equal(h.calls[0].args.deadlineAt, originalDeadline)
  h.physical.resolve(); await handle.physicalDone
  const expired = rig()
  const result = await expired.upload(argsOf({ deadlineAt: Date.now() + 20, isCurrent: () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40)
    return true
  } })).result
  assert.equal(result.code, 'TIMEOUT')
  assert.equal(expired.calls.length, 0)
})

test('037发送服务：回包前异步撤权不改写A已经确认的终态，矛盾结果则保守unknown', async () => {
  const confirmed = future(), h = rig({ begin: () => ({
    result: confirmed.promise, physicalDone: h.physical.promise
  }) })
  const handle = h.upload()
  h.controls.live = false
  confirmed.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED', bytes: 3 })
  assert.equal((await handle.result).state, 'confirmed')
  assert.equal(handle.physicalDone, h.physical.promise)
  h.physical.resolve(); await handle.physicalDone
  const malformed = rig({ begin: () => ({
    result: Promise.resolve({ ok: false, state: 'not_submitted', code: 'WRITE_UNKNOWN' }),
    physicalDone: Promise.resolve()
  }) })
  assert.deepEqual(await malformed.upload().result, { ok: false, state: 'unknown', code: 'SERVICE_UNKNOWN' })
})

test('037发送服务：真正A传输在服务撤权后unknown，物理额度仍等匹配回包', async t => {
  const frames = [], socket = {
    readyState: 1, bufferedAmount: 0,
    send (text, callback) { frames.push(JSON.parse(text)); callback() }
  }
  const binding = { socket, generation: 1 }
  const transport = createFileUploadTransport({
    timeoutMs: 180, connectionOf: () => binding, isConnectionCurrent: one => one === binding && socket.readyState === 1
  })
  const settings = { enabled: true, allowedUsers: ['11'] }
  const client = { status: () => ({ state: 'client-connected', clients: 1 }),
    beginFileUpload: args => transport.beginFileUpload(args) }
  const service = createQQFileSendService({ clientOf: () => client, settingsOf: () => settings, isAwake: () => false })
  const handle = service.beginFileUpload(argsOf(), request())
  t.after(async () => {
    service.dispose(); socket.readyState = 3; transport.disconnect(socket); transport.invalidateAll()
    await handle.physicalDone
  })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(frames.length, 1)
  settings.enabled = false
  const result = await handle.result
  assert.equal(result.state, 'unknown')
  assert.equal(await settled(handle.physicalDone), false)
  assert.equal(transport.stats().active, 1)
  transport.handleResponse(socket, { status: 'ok', retcode: 0, echo: frames[0].echo, data: { file_id: 'synthetic-confirmation' } })
  await handle.physicalDone
  assert.equal(transport.stats().active, 0)
  assert.equal((await handle.result).state, 'unknown')
  safe(result)
})
