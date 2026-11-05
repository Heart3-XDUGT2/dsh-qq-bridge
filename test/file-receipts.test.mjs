import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createFileReceipts } from '../lib/file-receipts.js'

const MiB = 1024 * 1024
const privateSource = Object.freeze({ chatType: 'private', chatId: '11', senderId: '11', isMaster: true })
const groupSource = Object.freeze({ chatType: 'group', chatId: '33', senderId: '11', isMaster: true })
const live = () => true
const item = (name = '资料.txt', source = privateSource, patch = {}) => ({
  received: true, name, declaredSize: 32, declaredType: 'text/plain',
  reference: { ...source, fileId: 'synthetic-file' }, ...patch
})
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function rig (options = {}) {
  let time = 1000, admitted = true
  const calls = []
  const registry = createFileReceipts({
    now: () => time,
    resolve: async (file, source, execution) => {
      calls.push({ file, source, execution })
      return { ok: true, url: 'https://synthetic.invalid/document?token=fiction' }
    },
    ...options
  })
  const put = (files = [item()], source = privateSource) => registry.put(files, source, { isCurrent: () => admitted })
  const open = (receipt, source = privateSource, extra = {}) => registry.openFile({
    ref: receipt.ref, source, isCurrent: live, ...extra
  })
  return { registry, calls, put, open, clock: value => { time = value }, admit: value => { admitted = value } }
}

test('034引用：收件最多两份，只返回安全元数据与内部绑定，不查链接', () => {
  const h = rig()
  const receipts = h.put([item(), item('第二份.md'), item('第三份.pdf')])
  assert.equal(receipts.length, 2)
  assert.match(receipts[0].ref, /^[0-9a-f]{32}$/)
  assert.notEqual(receipts[0].ref, receipts[1].ref)
  assert.match(receipts[0].label, /^文件\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[1-9]\d*$/)
  assert.equal(h.calls.length, 0)
  assert.doesNotMatch(JSON.stringify(receipts), /synthetic-file|token=|https?:|chatId|senderId/)
  assert.equal(h.registry.inspectFile({ ref: receipts[0].ref, source: privateSource }).ok, true)
})

test('034引用：名称只留叶名、保留扩展，控制/路径/URL/内部标识不泄漏', () => {
  const h = rig()
  const names = [
    ['D:\\synthetic\\资料.txt', '资料.txt'],
    ['https://synthetic.invalid/private?token=fiction', '未提供'],
    ['session-1234abcd.txt', '<标识>.txt'],
    ['9f180d2a-aaaa-bbbb-cccc-123456789abc.md', '<标识>.md']
  ]
  for (const [name, expected] of names) assert.equal(h.put([item(name)])[0].name, expected)
  const long = h.put([item('甲'.repeat(200) + '.pdf')])[0]
  assert.ok(long.name.length <= 160)
  assert.match(long.name, /\.pdf$/)
  assert.doesNotMatch(h.put([item('甲\n[伪系统].txt')])[0].name, /[\n\r]/)
})

test('034引用：缺引用、坏引用仍有收件事实但不能绑定', () => {
  const h = rig()
  for (const reference of [undefined, {}, { ...privateSource, url: 'file:///D:/synthetic/file.txt' },
    { ...privateSource, fileId: 'x'.repeat(2048) }]) {
    const receipt = h.put([item('资料.txt', privateSource, { reference })])[0]
    assert.equal(receipt.received, true)
    assert.equal('ref' in receipt, false)
    assert.equal('label' in receipt, false)
  }
})

test('034引用：收件必须真实准入和原始来源完整匹配', () => {
  const h = rig()
  assert.deepEqual(h.registry.put([item()], privateSource), [])
  assert.deepEqual(h.registry.put([item()], privateSource, { isCurrent: () => 1 }), [])
  assert.deepEqual(h.registry.put([item()], { ...privateSource, isMaster: false }, { isCurrent: live }), [])
  const wrong = h.put([item('资料.txt', { ...privateSource, chatId: '22' })])[0]
  assert.equal('ref' in wrong, false)
  h.admit(false)
  assert.deepEqual(h.put(), [])
})

for (const name of ['录音.amr', '声音.mp3', '图像.png', '程序.exe', '表格.xlsx', '旧版.doc', '宏.docm', '未提供']) {
  test('034引用：不支持格式在查询链接前拒绝 ' + name, async () => {
    const h = rig(), receipt = h.put([item(name)])[0]
    const result = await h.open(receipt)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unsupported')
    assert.equal(h.calls.length, 0)
  })
}

test('034引用：声明大小超限在查询链接前拒绝，未知大小不捏造', async () => {
  const h = rig()
  const receipt = h.put([item('资料.txt', privateSource, { declaredSize: 8 * MiB + 1 })])[0]
  assert.equal((await h.open(receipt)).reason, 'too-large')
  assert.equal(h.calls.length, 0)
  for (const value of [undefined, null, '5', -1, Infinity]) {
    const metadata = h.put([item('资料.txt', privateSource, { declaredSize: value })])[0]
    assert.equal('declaredSize' in metadata, false)
  }
})

test('034引用：支持集严格四种且大小写无关，未读正文不查询', async () => {
  const h = rig()
  for (const name of ['资料.TXT', '资料.md', '资料.PDF', '资料.docx']) {
    const receipt = h.put([item(name)])[0], handle = await h.open(receipt)
    assert.equal(handle.ok, true)
    assert.equal(handle.name, name)
    handle.finish(0)
  }
  assert.equal(h.calls.length, 4)
})

test('034引用：私聊绑定不能给其它群/私聊/非主人读取', async () => {
  const h = rig(), receipt = h.put()[0]
  for (const source of [{ ...privateSource, chatId: '22' }, { ...privateSource, senderId: '22' },
    { ...privateSource, isMaster: false }, groupSource, null]) {
    assert.equal(h.registry.inspectFile({ ref: receipt.ref, source }).ok, false)
    assert.equal((await h.open(receipt, source)).ok, false)
  }
  assert.equal(h.calls.length, 0)
})

test('034引用：同群换发言者可读，解析地址仍使用原始收件来源', async () => {
  const h = rig(), receipt = h.put([item('资料.txt', groupSource)], groupSource)[0]
  const reader = { ...groupSource, senderId: '22', isMaster: false }
  const handle = await h.open(receipt, reader)
  assert.equal(handle.ok, true)
  assert.deepEqual(h.calls[0].source, groupSource)
  assert.deepEqual(h.calls[0].file.reference, { ...groupSource, fileId: 'synthetic-file' })
  handle.finish(7)
  assert.equal((await h.open(receipt, { ...reader, chatId: '44' })).ok, false)
})

test('034引用：同批次串行，无界等待或同时两份8MiB不可越过12MiB', async () => {
  const h = rig(), [a, b] = h.put([item('甲.txt'), item('乙.txt')])
  const first = await h.open(a)
  assert.equal(first.byteLimit, 8 * MiB)
  const busy = await h.open(b)
  assert.equal(busy.reason, 'busy')
  assert.equal(h.calls.length, 1)
  first.finish(8 * MiB)
  const second = await h.open(b)
  assert.equal(second.ok, true)
  assert.equal(second.byteLimit, 4 * MiB)
  second.finish(4 * MiB)
  assert.equal((await h.open(a)).reason, 'expired')
})

test('034引用：失败触发块的全部实读字节同样消耗共享预算，finish幂等', async () => {
  const h = rig(), [a, b] = h.put([item('甲.txt'), item('乙.txt')])
  const first = await h.open(a)
  first.finish(8 * MiB + 1024)
  first.finish(0)
  const second = await h.open(b)
  assert.equal(second.byteLimit, 4 * MiB - 1024)
  second.finish(0)
})

test('034引用：活动取消后等实际字节结算才释放批次，不能以零结算绕预算', async () => {
  const h = rig(), [a, b] = h.put([item('甲.txt'), item('乙.txt')])
  const controller = new AbortController()
  const first = await h.open(a, privateSource, { signal: controller.signal })
  controller.abort()
  assert.equal(first.signal.aborted, true)
  assert.equal((await h.open(b)).reason, 'busy')
  first.finish(8 * MiB + 512)
  const second = await h.open(b)
  assert.equal(second.byteLimit, 4 * MiB - 512)
  second.finish(0)
})

test('034引用：字节结算无效值按耗尽预算处理，不能重置', async () => {
  for (const bytesRead of [NaN, -1, Infinity, '10']) {
    const h = rig(), [a, b] = h.put([item('甲.txt'), item('乙.txt')])
    const first = await h.open(a)
    first.finish(bytesRead)
    assert.equal((await h.open(b)).reason, 'too-large')
  }
})

test('034引用：正文尝试后不重下，缓存继续读可inspect而不取链接', async () => {
  const h = rig(), receipt = h.put()[0]
  const handle = await h.open(receipt)
  handle.finish(20)
  assert.equal(h.registry.inspectFile({ ref: receipt.ref, source: privateSource }).ok, true)
  assert.equal((await h.open(receipt)).reason, 'expired')
  assert.equal(h.calls.length, 1)
})

test('034引用：解析地址失败消化异常且不能重试泄漏地址/原异常', async () => {
  for (const resolve of [
    async () => { throw Error('https://synthetic.invalid/?token=fiction') },
    async () => ({ ok: false, reason: 'https://synthetic.invalid/?token=fiction' }),
    async () => ({ ok: true, url: 'file:///D:/synthetic/private.txt' })
  ]) {
    const h = rig({ resolve }), receipt = h.put()[0]
    const result = await h.open(receipt)
    assert.deepEqual(result, { ok: false, reason: 'unavailable' })
    assert.equal((await h.open(receipt)).reason, 'expired')
    assert.doesNotMatch(JSON.stringify(result), /synthetic|token|D:/)
  }
})

test('034引用：真正异步查询期间第二请求忙，取消后迟到地址不能回流', async () => {
  const pending = deferred(), calls = []
  const h = rig({ resolve: async (_file, _source, execution) => { calls.push(execution); return pending.promise } })
  const [a, b] = h.put([item('甲.txt'), item('乙.txt')])
  const controller = new AbortController()
  const opened = h.open(a, privateSource, { signal: controller.signal })
  await Promise.resolve()
  assert.equal((await h.open(b)).reason, 'busy')
  controller.abort()
  const result = await opened
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'canceled')
  assert.equal(calls[0].signal.aborted, true)
  pending.resolve({ ok: true, url: 'https://synthetic.invalid/late' })
  assert.equal((await h.open(a)).reason, 'expired')
})

test('034引用：open要求真实当前轮guard，缺失/异常/取消均不查询', async () => {
  const h = rig(), receipt = h.put()[0]
  for (const isCurrent of [undefined, () => false, () => 1, () => { throw Error('bad') }]) {
    assert.equal((await h.open(receipt, privateSource, { isCurrent })).ok, false)
  }
  const controller = new AbortController()
  controller.abort()
  assert.equal((await h.open(receipt, privateSource, { signal: controller.signal })).reason, 'canceled')
  assert.equal(h.calls.length, 0)
  const handle = await h.open(receipt)
  assert.equal(handle.ok, true)
  handle.finish(0)
})

test('034引用：撤准入/原聊天代际失效后旧引用不复活', async () => {
  const h = rig(), receipt = h.put()[0], handle = await h.open(receipt)
  h.admit(false)
  assert.equal(h.registry.inspectFile({ ref: receipt.ref, source: privateSource }).ok, false)
  assert.equal(handle.signal.aborted, true)
  assert.equal(handle.isCurrent(), false)
  h.admit(true)
  assert.equal((await h.open(receipt)).reason, 'expired')
  handle.finish(10)
})

test('034引用：按聊天失效只撤该群；clear中止其余所有活动', async () => {
  const h = rig()
  const a = h.put([item('甲.txt', groupSource)], groupSource)[0]
  const other = { ...groupSource, chatId: '44' }
  const b = h.put([item('乙.txt', other)], other)[0]
  const first = await h.open(a, groupSource), second = await h.open(b, other)
  assert.equal(h.registry.invalidateChat('group:33'), 1)
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, false)
  assert.equal(h.registry.clear(), 1)
  assert.equal(second.signal.aborted, true)
  first.finish(0); second.finish(0)
})

test('034引用：TTL绝对到期不因inspect续期；活动也中止', async () => {
  const h = rig({ ttlMs: 1000 }), receipt = h.put()[0], handle = await h.open(receipt)
  h.clock(1999)
  assert.equal(h.registry.inspectFile({ ref: receipt.ref, source: privateSource }).ok, true)
  h.clock(2000)
  assert.equal(h.registry.inspectFile({ ref: receipt.ref, source: privateSource }).reason, 'expired')
  assert.equal(handle.signal.aborted, true)
  handle.finish(0)
})

test('034引用：容量LRU按整批淘汰，不留下共享预算可重置的半批', async () => {
  const h = rig({ maxEntries: 3 })
  const [a, b] = h.put([item('甲.txt'), item('乙.txt')])
  const handle = await h.open(a)
  h.put([item('丙.txt'), item('丁.txt')])
  assert.equal(h.registry.inspectFile({ ref: a.ref, source: privateSource }).reason, 'expired')
  assert.equal(h.registry.inspectFile({ ref: b.ref, source: privateSource }).reason, 'expired')
  assert.equal(handle.signal.aborted, true)
  handle.finish(0)
})

test('034引用：inspect更新整批LRU而不拆批或延长TTL', () => {
  const h = rig({ maxEntries: 3 })
  const [a, b] = h.put([item('甲.txt'), item('乙.txt')])
  const c = h.put([item('丙.txt')])[0]
  assert.equal(h.registry.inspectFile({ ref: b.ref, source: privateSource }).ok, true)
  h.put([item('丁.txt')])
  assert.equal(h.registry.inspectFile({ ref: c.ref, source: privateSource }).reason, 'expired')
  assert.equal(h.registry.inspectFile({ ref: a.ref, source: privateSource }).ok, true)
  assert.equal(h.registry.inspectFile({ ref: b.ref, source: privateSource }).ok, true)
})

test('034引用：clear/TTL/实例重建不复用可见名称或内部引用', () => {
  const h = rig({ ttlMs: 1 })
  const a = h.put()[0]
  h.registry.clear()
  const b = h.put()[0]
  h.clock(2000)
  const c = h.put()[0]
  const d = rig().put()[0]
  assert.equal(new Set([a.ref, b.ref, c.ref, d.ref]).size, 4)
  assert.equal(new Set([a.label, b.label, c.label, d.label]).size, 4)
})

test('034引用：纯服务配置只能降低上限', () => {
  for (const options of [
    { maxEntries: 33 }, { ttlMs: 1800001 }, { maxFileBytes: 8 * MiB + 1 },
    { maxMessageBytes: 12 * MiB + 1 }, { maxEntries: 0 }, { maxFileBytes: -1 },
    { now: null }, { resolve: null }, null, [], 'options'
  ]) assert.throws(() => createFileReceipts(options), /INVALID_FILE_RECEIPT_OPTIONS/)
})

test('034引用：等待中native guard失效取消查询，没等迟到resolver', async () => {
  let current = true
  const pending = deferred()
  const h = rig({ resolve: () => pending.promise }), receipt = h.put()[0]
  const result = h.open(receipt, privateSource, { isCurrent: () => current })
  await Promise.resolve()
  current = false
  const completed = await Promise.race([result, delay(500).then(() => ({ reason: 'test-timeout' }))])
  assert.equal(completed.reason, 'canceled')
  pending.resolve({ ok: true, url: 'https://synthetic.invalid/late' })
})
