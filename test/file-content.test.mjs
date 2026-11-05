/**
 * 034：仅合成协议对象和注入假 call；不加载配置、不连接 QQ、不取附件字节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filesOfSegments, fileNoticeEvent, fileDownloadPlan, resolveFileDownload,
  FILE_NOTICES as N
} from '../lib/file-content.js'

const group = { chatType: 'group', chatId: '22', senderId: '11', isMaster: false }
const owner = { chatType: 'private', chatId: '11', senderId: '11', isMaster: true }
const directUrl = 'https://files.example.invalid/a.txt?token=synthetic'
const file = data => ({ type: 'file', data })
const fact = (data = { name: '甲.txt', file_id: 'file-a' }, source = group) =>
  filesOfSegments([file(data)], source)[0]
const accepted = url => ({ ok: true, data: { url } })
const options = call => ({ call, isCurrent: () => true, timeoutMs: 100 })
const groupNotice = extra => ({
  post_type: 'notice', notice_type: 'group_upload',
  time: 1700000000, self_id: 99, user_id: 11, group_id: 22,
  file: { id: 'file-a', name: '甲.txt', size: 3, busid: 102 },
  ...extra
})
const privateNotice = extra => ({
  post_type: 'notice', notice_type: 'offline_file',
  time: 1700000000, self_id: 99, user_id: 11,
  file: { name: '甲.txt', size: 3, url: directUrl },
  ...extra
})
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('034文件：canonical与legacy字段只保留实有元数据和内部来源', () => {
  const input = [
    file({ file: '甲.txt', file_id: 'id-a', file_size: '3', file_hash: 'hash-a', mime_type: 'text/plain' }),
    { type: 'file', name: '乙.md', id: 'id-b', size: 4, busid: '102' }
  ]
  const original = structuredClone(input)
  assert.deepEqual(filesOfSegments(input, group), [
    { received: true, name: '甲.txt', declaredSize: 3, declaredType: 'text/plain',
      reference: { ...group, fileId: 'id-a', fileHash: 'hash-a' } },
    { received: true, name: '乙.md', declaredSize: 4,
      reference: { ...group, fileId: 'id-b', busid: 102 } }
  ])
  assert.deepEqual(input, original)
})

test('034文件：只认外层file，不扁平化node/forward，不读取语音图像或文字URL', () => {
  assert.deepEqual(filesOfSegments(null, group), [])
  assert.deepEqual(filesOfSegments([
    { type: 'record', data: { file: 'voice', url: directUrl } },
    { type: 'image', data: { file: 'image', url: directUrl } },
    { type: 'text', text: directUrl },
    { type: 'node', data: { content: [file({ name: '内层.txt', url: directUrl })] } },
    { type: 'forward', data: { content: [file({ name: '内层.txt', url: directUrl })] } }
  ], group), [])
})

test('034文件：一条最多两文件，扫描也有硬上限', () => {
  assert.equal(filesOfSegments([
    file({}), file({}), file({ name: '超出.txt' })
  ], group).length, 2)
  assert.deepEqual(filesOfSegments([
    ...Array.from({ length: 256 }, () => ({ type: 'text', text: '' })),
    file({ name: '扫描预算外.txt' })
  ], group), [])
})

test('034文件：缺引用/大小/类型仍保留收件事实，不推断类型或零大小', () => {
  const result = fact({ name: '甲.pdf' })
  assert.deepEqual(result, { received: true, name: '甲.pdf', reference: group })
  assert.deepEqual(fileDownloadPlan(result, group), { ok: false, reason: N.missingReference })
  assert.equal(fact({}).name, '')
})

test('034文件：声明大小只接受实际非负安全整数，零是真实声明', () => {
  assert.equal(fact({ size: 0 }).declaredSize, 0)
  assert.equal(fact({ file_size: '12' }).declaredSize, 12)
  for (const size of [-1, 1.5, NaN, Infinity, '1e3', '', ' ', {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal('declaredSize' in fact({ size }), false)
  }
})

test('034文件：文件名只保留叶名并去控制符，不把URL或缺失名伪装为声明名', () => {
  assert.equal(fact({ name: 'C:\\synthetic\\甲.txt' }).name, '甲.txt')
  assert.equal(fact({ file: '/synthetic/乙.md' }).name, '乙.md')
  assert.equal(fact({ name: '丙\u0000\u202e.txt' }).name, '丙.txt')
  for (const name of [directUrl, 'file:///synthetic/a.txt', 'data:text/plain,abc', null, {}]) {
    assert.equal(fact({ name }).name, '')
  }
  const name = fact({ name: '甲'.repeat(239) + '😀.txt' }).name
  assert.ok(name.length <= 240)
  assert.doesNotMatch(name, /[\uD800-\uDBFF]$/)
})

test('034文件：类型只保留实际MIME声明，不从扩展名或段type推断', () => {
  assert.equal(fact({ name: '甲.txt', mime_type: 'TEXT/PLAIN' }).declaredType, 'text/plain')
  for (const mime_type of ['', 'text', 'text/plain\nsecret', {}, 'x'.repeat(200)]) {
    assert.equal('declaredType' in fact({ mime_type }), false)
  }
  assert.equal('declaredType' in fact({ name: '甲.txt' }), false)
})

test('034文件：不变更原始来源，返回引用不与调用者对象共享', () => {
  const source = { ...group }
  const input = [file({ name: '甲.txt', id: 'id-a' })]
  const result = filesOfSegments(input, source)
  result[0].reference.chatId = '33'
  assert.equal(source.chatId, '22')
  assert.deepEqual(input, [file({ name: '甲.txt', id: 'id-a' })])
})

test('034文件：无效来源仍记已收到，但不能生成可用下载计划', () => {
  const result = fact({ name: '甲.txt', file_id: 'id-a' }, null)
  assert.equal(result.received, true)
  assert.deepEqual(fileDownloadPlan(result, group), { ok: false, reason: N.invalidSource })
  for (const source of [
    { ...group, chatType: 'guild' }, { ...group, chatId: {} },
    { ...group, senderId: '' }, { ...owner, chatId: '22' }
  ]) assert.equal(fileDownloadPlan(fact({}, source), source).ok, false)
})

test('034文件：标准群上传通知转为现有事件形状，时间来自协议', () => {
  const raw = groupNotice()
  const original = structuredClone(raw)
  const result = fileNoticeEvent(raw)
  assert.equal(result.ok, true)
  assert.deepEqual({
    ...result.event, messageId: '<stable-id>'
  }, {
    userId: '11', messageId: '<stable-id>', text: '',
    segments: [file({ name: '甲.txt', size: 3, file_id: 'file-a', busid: 102 })],
    chatType: 'group', groupId: '22', selfId: '99', userName: '', ts: 1700000000000
  })
  assert.match(result.event.messageId, /^file-notice-[0-9a-f]{32}$/)
  assert.deepEqual(raw, original)
})

test('034文件：已核offline_file只用实际收到的name/size/url', () => {
  const result = fileNoticeEvent(privateNotice())
  assert.equal(result.ok, true)
  assert.equal(result.event.chatType, 'private')
  assert.equal(result.event.groupId, '')
  assert.equal(result.event.userId, '11')
  assert.deepEqual(result.event.segments, [file({ name: '甲.txt', size: 3, url: directUrl })])
  const normalized = filesOfSegments(result.event.segments, owner)[0]
  assert.deepEqual(fileDownloadPlan(normalized, owner), { ok: true, url: directUrl })
})

test('034文件：其它notice/message不开放，缺核心身份/时间/文件对象拒绝', () => {
  for (const raw of [
    { ...groupNotice(), notice_type: 'group_increase' },
    { ...privateNotice(), notice_type: 'friend_recall' },
    { ...groupNotice(), post_type: 'message' }
  ]) assert.deepEqual(fileNoticeEvent(raw), { ok: false, reason: N.unsupportedNotice })
  for (const raw of [
    null, [], groupNotice({ time: null }), groupNotice({ time: -1 }),
    groupNotice({ time: 1.5 }), groupNotice({ self_id: '' }),
    groupNotice({ user_id: {} }), groupNotice({ group_id: '' }),
    groupNotice({ file: null }), groupNotice({ file: [] }), groupNotice({ file: {} }),
    groupNotice({ user_id: 99 })
  ]) assert.equal(fileNoticeEvent(raw).ok, false)
})

test('034文件：notice没有可读引用时保留实际声明，但无字段不凭空补值', () => {
  const result = fileNoticeEvent(groupNotice({ file: { name: '甲.txt' } }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.event.segments, [file({ name: '甲.txt' })])
  assert.deepEqual(fileDownloadPlan(filesOfSegments(result.event.segments, group)[0], group),
    { ok: false, reason: N.missingReference })
})

test('034文件：同一通知重放幂等，与本地时钟/对象键顺序无关', () => {
  const first = fileNoticeEvent(privateNotice()).event.messageId
  const reordered = privateNotice({ file: { url: directUrl, size: 3, name: '甲.txt' } })
  assert.equal(fileNoticeEvent(reordered).event.messageId, first)
  assert.equal(fileNoticeEvent(structuredClone(reordered)).event.messageId, first)
  assert.doesNotMatch(first, /token|example|甲|synthetic/)
})

test('034文件：通知身份包括源聊天/发送人/时间及原始文件事实', () => {
  const base = fileNoticeEvent(groupNotice()).event.messageId
  for (const extra of [
    { group_id: 33 }, { user_id: 33 }, { self_id: 88 }, { time: 1700000001 },
    { file: { id: 'file-b', name: '甲.txt', size: 3, busid: 102 } },
    { file: { id: 'file-a', name: '乙.txt', size: 3, busid: 102 } },
    { file: { id: 'file-a', name: '甲.txt', size: 4, busid: 102 } }
  ]) assert.notEqual(fileNoticeEvent(groupNotice(extra)).event.messageId, base)
  const privateA = fileNoticeEvent(privateNotice()).event.messageId
  const privateB = fileNoticeEvent(privateNotice({
    file: { name: '甲.txt', size: 3, url: directUrl + '2' }
  })).event.messageId
  assert.notEqual(privateA, privateB)
})

test('034文件：群下载计划只用实际group_id/file_id/busid，不能改取私聊动作', () => {
  const received = fact({ name: '甲.txt', file_id: 'a+/=_-.', busid: 102 })
  assert.deepEqual(fileDownloadPlan(received, group), {
    ok: true, action: 'get_group_file_url',
    params: { group_id: '22', file_id: 'a+/=_-.', busid: 102 }
  })
  assert.deepEqual(fileDownloadPlan(fact({ id: 'id-a' }), group), {
    ok: true, action: 'get_group_file_url', params: { group_id: '22', file_id: 'id-a' }
  })
})

test('034文件：私聊按真实sender/file_id/hash查询，不编busid/hash', () => {
  assert.deepEqual(fileDownloadPlan(fact({ file_id: 'id-a', file_hash: 'hash-a' }, owner), owner), {
    ok: true, action: 'get_private_file_url',
    params: { user_id: '11', file_id: 'id-a', file_hash: 'hash-a' }
  })
  assert.deepEqual(fileDownloadPlan(fact({ id: 'id-a' }, owner), owner), {
    ok: true, action: 'get_private_file_url', params: { user_id: '11', file_id: 'id-a' }
  })
})

test('034文件：同群可由另一准入sender继续读，跨群/跨类型永不返回计划', () => {
  const received = fact()
  assert.equal(fileDownloadPlan(received, { ...group, senderId: '33' }).ok, true)
  for (const source of [{ ...group, chatId: '33' }, owner]) {
    assert.deepEqual(fileDownloadPlan(received, source), { ok: false, reason: N.sourceMismatch })
  }
})

test('034文件：私聊必须原始及当前都是主人，且同sender和chat', () => {
  const received = fact({ id: 'id-a', url: directUrl }, owner)
  for (const source of [
    { ...owner, isMaster: false },
    { ...owner, chatId: '33', senderId: '33' },
    group
  ]) assert.deepEqual(fileDownloadPlan(received, source), { ok: false, reason: N.sourceMismatch })
  assert.deepEqual(fileDownloadPlan(fact({ id: 'id-a' }, { ...owner, isMaster: false }), owner),
    { ok: false, reason: N.sourceMismatch })
})

test('034文件：只认实际HTTP(S)地址，拒绝本机路径/其它协议/凭据URL', () => {
  assert.deepEqual(fileDownloadPlan(fact({ url: directUrl + '#fragment' }), group),
    { ok: true, url: directUrl })
  for (const url of [
    'C:\\synthetic\\甲.txt', '/synthetic/甲.txt', '\\\\synthetic\\甲.txt',
    'file:///synthetic/a.txt', 'data:text/plain,abc', '//example.invalid/a.txt',
    'https://u:p@example.invalid/a.txt', 'https://example.invalid/a.txt\nsecret',
    'https:\\\\example.invalid\\a.txt', 'ftp://example.invalid/a.txt'
  ]) assert.equal(fileDownloadPlan(fact({ url }), group).ok, false)
  assert.equal(fileDownloadPlan(fact({ file: directUrl }), group).ok, false)
})

test('034文件：有fileId时优先已核动作，坏ID/hash/busid不进入查询参数', () => {
  const received = fact({ file_id: 'id-a', url: directUrl, file_hash: 'hash\nsecret', busid: -1 })
  assert.deepEqual(fileDownloadPlan(received, group), {
    ok: true, action: 'get_group_file_url', params: { group_id: '22', file_id: 'id-a' }
  })
  for (const file_id of [{}, 'id\nsecret', 'x'.repeat(4097), 'file:///synthetic/a']) {
    assert.equal(fileDownloadPlan(fact({ file_id }), group).ok, false)
  }
})

test('034文件：计划需要真实received/reference形状，不把任意对象当文件', () => {
  for (const received of [null, {}, { reference: group }, { received: true }, {
    received: false, reference: { ...group, fileId: 'id-a' }
  }]) assert.deepEqual(fileDownloadPlan(received, group), { ok: false, reason: N.invalidReference })
})

test('034文件：注入call收到唯一白名单动作与有界timeout，原输入不变', async () => {
  const received = fact({ file_id: 'id-a', busid: 102 })
  const original = structuredClone(received)
  const calls = []
  const result = await resolveFileDownload(received, group, options(async (...args) => {
    calls.push(args)
    return accepted(directUrl)
  }))
  assert.deepEqual(result, { ok: true, url: directUrl })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 2), [
    'get_group_file_url', { group_id: '22', file_id: 'id-a', busid: 102 }
  ])
  assert.equal(calls[0][2].timeoutMs, 100)
  assert.deepEqual(received, original)
})

test('034文件：实际收到的direct URL不发OneBot动作，但同样要求准入guard', async () => {
  let calls = 0
  const received = fact({ url: directUrl }, owner)
  const result = await resolveFileDownload(received, owner, options(() => { calls++ }))
  assert.deepEqual(result, { ok: true, url: directUrl })
  assert.equal(calls, 0)
  assert.deepEqual(await resolveFileDownload(received, owner, {
    isCurrent: () => false
  }), { ok: false, reason: N.cancelled })
})

test('034文件：来源不符/已撤权/已取消均零call，guard缺失或抛错安全拒绝', async () => {
  let calls = 0
  const received = fact()
  const call = () => { calls++; return accepted(directUrl) }
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await resolveFileDownload(received, { ...group, chatId: '33' }, options(call)),
    { ok: false, reason: N.sourceMismatch })
  assert.deepEqual(await resolveFileDownload(received, group, { call, isCurrent: () => false }),
    { ok: false, reason: N.cancelled })
  assert.deepEqual(await resolveFileDownload(received, group, { ...options(call), signal: controller.signal }),
    { ok: false, reason: N.cancelled })
  assert.deepEqual(await resolveFileDownload(received, group, { call }),
    { ok: false, reason: N.unavailable })
  assert.deepEqual(await resolveFileDownload(received, group, {
    call, isCurrent: () => { throw new Error('synthetic-private') }
  }), { ok: false, reason: N.unavailable })
  assert.equal(calls, 0)
})

test('034文件：guard必须精确true，不能由truthy异步对象冒充当前准入', async () => {
  let calls = 0
  for (const isCurrent of [
    () => 1, () => 'true', () => Promise.resolve(true),
    async () => { throw new Error('synthetic-private') }
  ]) {
    const result = await resolveFileDownload(fact(), group, {
      call: () => { calls++ }, isCurrent
    })
    assert.deepEqual(result, { ok: false, reason: N.cancelled })
  }
  assert.equal(calls, 0)
})

test('034文件：同步准入复核期间取消也必须零call，不能留下后来创建的定时器', async () => {
  const controller = new AbortController()
  let calls = 0
  let checks = 0
  const result = await resolveFileDownload(fact(), group, {
    ...options(() => { calls++; return accepted(directUrl) }),
    signal: controller.signal,
    isCurrent: () => {
      if (++checks === 2) controller.abort()
      return true
    }
  })
  assert.deepEqual(result, { ok: false, reason: N.cancelled })
  assert.equal(calls, 0)
})

test('034文件：await后复核来源guard，不返回撤权期间取得的URL', async () => {
  const pending = deferred()
  let current = true
  const result = resolveFileDownload(fact(), group, {
    ...options(() => pending.promise), isCurrent: () => current
  })
  current = false
  pending.resolve(accepted(directUrl))
  assert.deepEqual(await result, { ok: false, reason: N.cancelled })
})

test('034文件：await中abort立即结算，迟到成功不覆写且不会返回地址', async () => {
  const pending = deferred()
  const controller = new AbortController()
  const result = resolveFileDownload(fact(), group, {
    ...options(() => pending.promise), signal: controller.signal
  })
  controller.abort()
  assert.deepEqual(await result, { ok: false, reason: N.cancelled })
  pending.resolve(accepted(directUrl))
  await Promise.resolve()
})

test('034文件：永久挂起超时有固定原因，迟到reject已消费', async () => {
  const pending = deferred()
  const result = await resolveFileDownload(fact(), group, {
    ...options(() => pending.promise), timeoutMs: 5
  })
  assert.deepEqual(result, { ok: false, reason: N.requestTimeout })
  pending.reject(new Error('synthetic-private'))
  await Promise.resolve()
})

test('034文件：call同步抛错/异步拒绝/失败不退回旧URL且不透异常', async () => {
  for (const call of [
    () => { throw new Error(directUrl) },
    async () => { throw new Error('C:\\synthetic\\private-token') },
    async () => ({ ok: false, error: directUrl })
  ]) {
    const result = await resolveFileDownload(fact({ id: 'id-a', url: directUrl }), group, options(call))
    assert.deepEqual(result, { ok: false, reason: N.requestFailed })
    assert.doesNotMatch(JSON.stringify(result), /token|synthetic|example|C:/)
  }
})

test('034文件：只认ok/data/url协议，未知响应与不安全响应URL给固定原因', async () => {
  for (const response of [
    { ok: true, url: directUrl }, { ok: true, data: directUrl },
    { ok: true, data: { file: directUrl } }, { ok: true, data: { url: '/synthetic/a' } },
    { ok: true, data: { url: 'file:///synthetic/a' } },
    { ok: true, data: { url: 'https://u:p@example.invalid/a' } }
  ]) {
    assert.deepEqual(await resolveFileDownload(fact(), group, options(async () => response)),
      { ok: false, reason: N.invalidResponse })
  }
})

test('034文件：无call不能假装查到地址，取消后迟到reject不会成为未处理异常', async () => {
  assert.deepEqual(await resolveFileDownload(fact(), group, { isCurrent: () => true }),
    { ok: false, reason: N.unavailable })
  const pending = deferred()
  const controller = new AbortController()
  const result = resolveFileDownload(fact(), group, {
    ...options(() => pending.promise), signal: controller.signal
  })
  controller.abort()
  assert.equal((await result).reason, N.cancelled)
  pending.reject(new Error('synthetic-private'))
  await Promise.resolve()
})
