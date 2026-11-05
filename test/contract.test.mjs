import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChannel, normalizeOutboundRow, registrationAction, SERVICE_NAME, serviceOf } from '../lib/contract.js'

/**
 * 旧桥退役(2026-09-28)之后,`mainBaseUrl` / `mainToken` 不再是设置项 ——
 * 它们只服务那条已经拆掉的 HTTP 兜底。夹具里再留着它们,是为了钉住"配着也没用"。
 */
const SETTINGS = {}

/** 假 ctx:只有 get(SERVICE_NAME) 有值(没有宿主服务表)。 */
function ctxOf (service) {
  return { get: (n) => (n === SERVICE_NAME ? (service ?? undefined) : undefined) }
}

function fakeFetch (handler) {
  const seen = []
  const impl = async (url, init) => {
    seen.push({ url, init })
    return handler(url, init)
  }
  return { impl, seen }
}

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(data),
  json: async () => data
})

test('服务注入 = 唯一的路:入站/订阅/回执全都走服务(一个请求都不发)', async () => {
  const calls = []
  const service = {
    version: 1,
    inject: async (e) => { calls.push(['inject', e]); return { ok: true } },
    subscribeOutbound: (fn) => { calls.push(['subscribe']); return () => calls.push(['dispose']) },
    ack: async (ids) => { calls.push(['ack', ids]); return { rows: ids.map((id) => ({ id })) } }
  }
  // 就算硬塞一个假 fetch 进去也没有任何东西会用它 —— 旧桥那条路已经不在了。
  const net = fakeFetch(async () => { throw new Error('唯一的路是服务注入,不该走网络') })
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS, fetchImpl: net.impl })
  assert.equal(ch.mode(), 'service')

  assert.equal((await ch.inject({ msgId: 'm' })).ok, true)
  const dispose = ch.onOutbound(async () => {})
  const acked = await ch.ack(['a', 'b'])
  assert.equal(acked.acked, 2)
  assert.deepEqual(calls.map((c) => c[0]), ['inject', 'subscribe', 'ack'])
  dispose()
  assert.ok(calls.some((c) => c[0] === 'dispose'))
  assert.equal(net.seen.length, 0)

  const st = ch.status()
  assert.equal(st.serviceAvailable, true)
  assert.equal(st.serviceVersion, 1)
  assert.equal(st.counters.in, 1)
  assert.equal(st.counters.ack, 2)
})

test('服务推送只喊"有活儿" ⇒ 消费端**现取**(svc.lease)再发(2026-09-28 补的契约缺口)', async () => {
  const calls = []
  const rows = [
    { id: 'o1', platform: 'qq', chatId: '10001', text: '在的', kind: 'reply' },
    { id: 'o2', platform: 'qq', chatId: '10001', text: '刚在看代码', kind: 'reply' }
  ]
  let notify = null
  let leaseRows = rows
  const service = {
    version: 1,
    inject: async () => ({ ok: true }),
    subscribeOutbound: (fn) => { notify = fn; return () => {} },
    lease: async (opts) => { calls.push(['lease', opts]); return { items: leaseRows, maxChars: 500 } },
    ack: async (ids) => { calls.push(['ack', ids]); return { rows: [] } }
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS })
  const got = []
  ch.onOutbound(async (list) => { got.push(...list) })

  // 主包喊的那一声与 speak.js 的形状一致:rows 是**计数**,不是正文
  await notify({ kind: 'queued', sessionId: 's', rows: 2, queued: 1, scope: 'private', turnKind: '' })
  assert.deepEqual(calls[0], ['lease', { platform: 'qq', limit: 20, leaseSec: 30 }], '要按平台现取(天然分渠)')
  assert.deepEqual(got.map((r) => r.text), ['在的', '刚在看代码'])
  assert.deepEqual(got.map((r) => r.chatId), ['10001', '10001'])
  assert.deepEqual(got.map((r) => r.raw.kind), ['reply', 'reply'], '原始行留在 raw 里(要别的字段自己取)')

  // 取不到行(队列空)⇒ 不叫 handler,也别假装发过
  leaseRows = []
  await notify({ kind: 'queued', sessionId: 's', rows: 0, queued: 0 })
  assert.equal(got.length, 2, '空的一轮不许把 handler 也叫起来')
})

test('没有连接就别去取行(发不出去还占租约 = 白白晚一轮)', async () => {
  const calls = []
  let notify = null
  const service = {
    version: 1,
    inject: async () => ({ ok: true }),
    subscribeOutbound: (fn) => { notify = fn; return () => {} },
    lease: async (opts) => { calls.push(['lease', opts]); return { items: [{ id: 'o1', chatId: '10001', text: 'x' }] } },
    ack: async () => ({ rows: [] })
  }
  let connected = false
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS, canSend: () => connected })
  const got = []
  ch.onOutbound(async (list) => { got.push(...list) })

  await notify({ kind: 'queued', rows: 1 })
  assert.equal(calls.length, 0, '没连接就不许 lease(取来也发不出去,只会白占 30s)')
  assert.equal(got.length, 0)
  assert.equal(ch.status().counters.skippedNoClient, 1, '要记账,面板/验收看得见')

  connected = true
  await notify({ kind: 'queued', rows: 1 })
  assert.deepEqual(calls[0][0], 'lease', '接上了就该取')
  assert.equal(got.length, 1)
  assert.equal(ch.status().counters.skippedNoClient, 1, '接上之后计数不再涨')
})

test('下一泡到点(nextDueAt)要自己再来一轮 —— 否则同一组后面的泡要等他下次说话', async () => {
  const calls = []
  let notify = null
  const nowSec = () => Date.now() / 1000
  const service = {
    version: 1,
    inject: async () => ({ ok: true }),
    subscribeOutbound: (fn) => { notify = fn; return () => {} },
    lease: async (opts) => {
      calls.push(opts)
      // 第一轮给一泡、并说"下一泡 0.2s 后到点";第二轮就没活儿了
      return calls.length === 1
        ? { items: [{ id: 1, chatId: '10001', text: '第一泡' }], nextDueAt: nowSec() + 0.2 }
        : { items: [], nextDueAt: 0 }
    },
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS, canSend: () => true })
  const got = []
  ch.onOutbound(async (list) => { got.push(...list.map((r) => r.text)) })
  await notify({ kind: 'queued', rows: 1 }) // 只喊一声"有活儿"
  assert.deepEqual(got, ['第一泡'])
  await new Promise((r) => setTimeout(r, 400)) // 等那个跟进定时器
  assert.equal(calls.length, 2, '到点了要自己再取一轮')
  assert.deepEqual(got, ['第一泡'], '第二轮没活儿就不该多发')
  ch.dispose()
})

test('入站撞上"她正忙"要按 msgId 重试(不重试 = 她忙时你说的话悄悄没了)', async () => {
  let calls = 0
  const service = {
    version: 1,
    inject: async () => {
      calls += 1
      return calls < 3 ? { ok: false, reason: 'agent-busy' } : { ok: true, duplicate: false, accepted: true }
    },
    subscribeOutbound: () => () => {},
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: { ...SETTINGS, inboundRetryTimes: 6, inboundRetryBaseMs: 10 } })
  const r = await ch.inject({ v: 1, msgId: 'm1' })
  assert.equal(r.ok, true, '第 3 次该成功')
  assert.equal(calls, 3)
  const st = ch.status()
  assert.equal(st.counters.in, 1, '只算一次收到')
  assert.equal(st.counters.inRetried, 2, '中间那两次是"再试试",不是被拒')
  assert.equal(st.counters.inRejected, 0, '**没丢**')
})

test('形状不对这种错不重试(再试一万次也一样,别浪费)', async () => {
  let calls = 0
  const service = {
    version: 1,
    inject: async () => { calls += 1; return { ok: false, reason: 'not-master' } },
    subscribeOutbound: () => () => {},
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: { ...SETTINGS, inboundRetryTimes: 6, inboundRetryBaseMs: 10 } })
  const r = await ch.inject({ v: 1, msgId: 'm2' })
  assert.equal(r.ok, false)
  assert.equal(calls, 1, '只试一次')
  assert.equal(ch.status().counters.inRejected, 1)
  assert.equal(ch.status().counters.inRetried, 0)
})

test('重试用尽 ⇒ 如实记成被拒(理由留痕),不假装收到', async () => {
  const service = {
    version: 1,
    inject: async () => ({ ok: false, reason: 'agent-busy' }),
    subscribeOutbound: () => () => {},
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: { ...SETTINGS, inboundRetryTimes: 3, inboundRetryBaseMs: 5 } })
  await ch.inject({ v: 1, msgId: 'm3' })
  const st = ch.status()
  assert.equal(st.counters.in, 0)
  assert.equal(st.counters.inRetried, 2, '3 次里前 2 次算重试')
  assert.equal(st.counters.inRejected, 1)
  assert.equal(st.lastRejectReason, 'agent-busy')
})

test('重复(duplicate)算收到,不算被拒 —— 重试的另一种正常收场', async () => {
  const service = {
    version: 1,
    inject: async () => ({ ok: true, duplicate: true, accepted: false }),
    subscribeOutbound: () => () => {},
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS })
  const r = await ch.inject({ v: 1, msgId: 'm4' })
  assert.equal(r.ok, true)
  assert.equal(ch.status().counters.in, 1)
  assert.equal(ch.status().counters.dup, 1, '看得见"这条是重复的"')
  assert.equal(ch.status().counters.inRejected, 0)
})

test('drain:没人推也要能把积压冲一遍(NapCat 一接上就叫一声)', async () => {
  const service = {
    version: 1,
    inject: async () => ({ ok: true }),
    subscribeOutbound: () => () => {},
    lease: async () => ({ items: [{ id: 7, chatId: '10001', text: '积压的一泡' }], nextDueAt: 0 }),
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS, canSend: () => true })
  const got = []
  ch.onOutbound(async (list) => { got.push(...list.map((r) => r.text)) })
  await ch.drain()
  assert.deepEqual(got, ['积压的一泡'], '不用等推送就该发出去')
  ch.dispose()
})

test('drain 在没有连接时不动手(不白占租约)', async () => {
  let leases = 0
  const service = {
    version: 1,
    inject: async () => ({ ok: true }),
    subscribeOutbound: () => () => {},
    lease: async () => { leases += 1; return { items: [{ id: 8, chatId: '10001', text: 'x' }] } },
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS, canSend: () => false })
  ch.onOutbound(async () => {})
  await ch.drain()
  assert.equal(leases, 0)
  assert.equal(ch.status().counters.skippedNoClient, 1)
  ch.dispose()
})

test('主包拒了要把理由留痕(2026-09-28:理由只在日志里,害我翻库反推 not-master)', async () => {
  const service = {
    version: 1,
    inject: async () => ({ ok: false, reason: 'not-master' }),
    subscribeOutbound: () => () => {},
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS })
  const r = await ch.inject({ v: 1, msgId: 'm' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-master', '理由要原样回给调用方')
  assert.equal(ch.status().counters.inRejected, 1)
  assert.equal(ch.status().lastRejectReason, 'not-master', '状态里也要看得见 —— 猜一次就够了')
})

test('服务里没有 lease(旧主包)⇒ 现取拿不到行,如实收场(不假装发过)', async () => {
  let notify = null
  const service = {
    version: 1,
    inject: async () => ({ ok: true }),
    subscribeOutbound: (fn) => { notify = fn; return () => {} },
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS })
  const got = []
  ch.onOutbound(async (list) => { got.push(...list) })
  await notify({ kind: 'queued', rows: 1 })
  assert.equal(got.length, 0, '没有 lease 就真拿不到行')
  assert.equal(ch.status().counters.out, 0, '别把"没取到"记成"发过了"')
  assert.equal(ch.status().counters.errors, 0, '这不算异常,是能力缺失——验收那边有专门的挡路项盯着')
})

test('服务不在(mode=none)⇒ 入站如实失败,理由说人话(唯一的路 + 旧兜底已退役)', async () => {
  const ch = createChannel({ ctx: ctxOf(null), settings: SETTINGS })
  assert.equal(ch.mode(), 'none')
  const r = await ch.inject({ msgId: 'm' })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('没有可用的主包通道'), r.reason)
  assert.ok(r.reason.includes('服务注入'), '要说清唯一的路是服务注入:' + r.reason)
  assert.ok(r.reason.includes('退役'), '要说清旧 HTTP 兜底已退役(别让人以为还有备胎):' + r.reason)
})

test('服务不在 ⇒ 不再回落到 HTTP:一个请求都不发,ack 也如实说 no-channel', async () => {
  const net = fakeFetch(async () => jsonRes({ ok: true }))
  // 配置里就算还留着旧桥那两个键,也**没有任何东西会读它们**。
  const ch = createChannel({
    ctx: ctxOf(null),
    settings: { ...SETTINGS, mainBaseUrl: 'http://10.0.0.5:9000', mainToken: 'tok' },
    fetchImpl: net.impl
  })
  assert.equal(ch.mode(), 'none')
  const r = await ch.inject({ msgId: 'm', text: 'x' })
  assert.equal(r.ok, false)
  const acked = await ch.ack(['x'])
  assert.equal(acked.ok, false)
  assert.equal(acked.reason, 'no-channel')
  assert.equal(net.seen.length, 0, '旧桥那条路已经不存在了,连试都不该试')
})

test('出站不再轮询:服务不在 ⇒ 一个请求不发、一个字不送(零轮询)', async () => {
  const net = fakeFetch(async () => jsonRes({ ok: true, rows: [{ id: 'r1', chatId: '3783', text: '早' }] }))
  const ch = createChannel({ ctx: ctxOf(null), settings: SETTINGS, fetchImpl: net.impl, now: () => 111 })
  const got = []
  const dispose = ch.onOutbound(async (rows) => { got.push(...rows) })
  await new Promise((r) => setTimeout(r, 120))
  dispose()
  assert.equal(net.seen.length, 0, '唯一的路 = 服务注入;没有服务就不该有任何 HTTP(更别说轮询)')
  assert.equal(got.length, 0)
  assert.equal(ch.status().lastOutboundAt, 0)
})

test('dispose 之后不再有出站动作(服务分支的"下一泡到点"定时器也要停)', async () => {
  const calls = []
  let notify = null
  const nowSec = () => Date.now() / 1000
  const service = {
    version: 1,
    inject: async () => ({ ok: true }),
    subscribeOutbound: (fn) => { notify = fn; return () => {} },
    lease: async () => { calls.push(1); return { items: [{ id: 1, chatId: '10001', text: 'x' }], nextDueAt: nowSec() + 0.1 } },
    ack: async () => ({ rows: [] })
  }
  const ch = createChannel({ ctx: ctxOf(service), settings: SETTINGS, canSend: () => true })
  ch.onOutbound(async () => {})
  await notify({ kind: 'queued', rows: 1 })
  assert.equal(calls.length, 1)
  ch.dispose()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(calls.length, 1, 'dispose 之后跟进定时器不该再取行')
})

test('normalizeOutboundRow:字段名宽容解析(两种写法都认;要改只改这一处)', () => {
  const a = normalizeOutboundRow({ id: 'r1', chatId: '3783', text: '早' })
  assert.deepEqual([a.id, a.chatId, a.text], ['r1', '3783', '早'])
  const b = normalizeOutboundRow({ outboxId: 'r2', chat: { id: '3783' }, content: '晚安' })
  assert.deepEqual([b.id, b.chatId, b.text], ['r2', '3783', '晚安'])
  const c = normalizeOutboundRow(null)
  assert.deepEqual([c.id, c.chatId, c.text], ['', '', ''])
})

// ---- transport 开关(S3:切换与退役都要有回退的路) --------------------------

const service = () => ({
  version: 1,
  inject: async () => ({ ok: true }),
  subscribeOutbound: () => () => {},
  ack: async (ids) => ({ rows: ids.map((id) => ({ id })) })
})
const settingsWith = (extra) => ({ ...SETTINGS, ...extra })

test('transport=auto(默认):有服务走服务,没服务就是 none(服务注入是唯一的路)', () => {
  const both = createChannel({ ctx: ctxOf(service()), settings: settingsWith({ transport: 'auto' }) })
  assert.equal(both.mode(), 'service')
  const none = createChannel({ ctx: ctxOf(null), settings: settingsWith({ transport: 'auto' }) })
  assert.equal(none.mode(), 'none')
  // 旧的 mainBaseUrl/mainToken 配着也不会有任何变化 —— 那条路已经不在了
  const legacy = createChannel({ ctx: ctxOf(null), settings: settingsWith({ mainBaseUrl: 'http://10.0.0.5:9000', mainToken: 't' }) })
  assert.equal(legacy.mode(), 'none', '不许因为"配了主包地址"就冒出第二条路')
})

test('transport=service(严格):服务不在 ⇒ none(唯一的路不通就是不说),有服务照走', async () => {
  const net = fakeFetch(async () => { throw new Error('唯一的路是服务注入,不该走网络') })
  const ch = createChannel({ ctx: ctxOf(null), settings: settingsWith({ transport: 'service' }), fetchImpl: net.impl })
  assert.equal(ch.mode(), 'none', '没服务就是 none —— 没有可回落的路')
  const r = await ch.inject({ msgId: 'm' })
  assert.equal(r.ok, false)
  assert.equal(net.seen.length, 0, '严格模式不许碰网络')
  // 有服务时照旧走服务
  const ch2 = createChannel({ ctx: ctxOf(service()), settings: settingsWith({ transport: 'service' }), fetchImpl: net.impl })
  assert.equal(ch2.mode(), 'service')
})

test('transport=http 已退役:状态里只报 auto|service,行为等同 auto', () => {
  const ch = createChannel({ ctx: ctxOf(service()), settings: settingsWith({ transport: 'http' }) })
  assert.equal(ch.mode(), 'service', 'http 不再是可选的路:有服务就走服务')
  assert.equal(ch.status().transport, 'auto', '状态里的 transport 只报合法值 auto|service')
  assert.equal(ch.status().serviceAvailable, true, '服务可用性照旧如实报')
  const none = createChannel({ ctx: ctxOf(null), settings: settingsWith({ transport: 'http' }) })
  assert.equal(none.mode(), 'none', '没服务也不会"退回 HTTP"')
})

// ---- 自报家门(S3-b:主包的门不再只依赖旧桥总闸) ----------------------------

test('serviceOf:形状不对 / ctx 抛错 / 没有服务 ⇒ 一律 null(于是 mode=none)', () => {
  assert.equal(serviceOf(ctxOf(null)), null)
  assert.equal(serviceOf(undefined), null, '没有 ctx 也不许炸')
  assert.equal(serviceOf({ get: () => undefined }), null)
  assert.equal(serviceOf({ get: () => ({ version: 1 }) }), null, '没有 inject ⇒ 不是主包服务')
  assert.equal(serviceOf({ get: () => { throw new Error('服务表炸了') } }), null, '探测失败当没有')
  const svc = service()
  assert.equal(serviceOf(ctxOf(svc)), svc, '形状对就原样给出(同一个对象)')
})

test('registrationAction:总闸 + 主包在 ⇒ register;任一不成立 ⇒ unregister;一致 ⇒ idle', () => {
  const on = { enabled: true, serviceAvailable: true }
  assert.equal(registrationAction({ ...on, registered: false }), 'register')
  assert.equal(registrationAction({ ...on, registered: true }), 'idle')
  // 自家总闸关了 —— 撤回,别让主包以为她还有嘴
  assert.equal(registrationAction({ enabled: false, serviceAvailable: true, registered: true }), 'unregister')
  // 主包不在(没装 / 版本旧 / 没有 registerChannel)
  assert.equal(registrationAction({ enabled: true, serviceAvailable: false, registered: true }), 'unregister')
  assert.equal(registrationAction({ enabled: true, serviceAvailable: false, registered: false }), 'idle')
  assert.equal(registrationAction({}), 'idle', '全默认 = 什么都不做')
  assert.equal(registrationAction(), 'idle')
  // 装上 ≠ 开了:没配 enabled 时绝不自报家门
  assert.equal(registrationAction({ serviceAvailable: true, registered: false }), 'idle')
})
