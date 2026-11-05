/**
 * 验收逻辑的单测(`lib/verdict.js`)。
 *
 * 为什么值得测:这块东西决定"他看到的是通过还是没通过"。判错了两头都难受 ——
 * 假通过(该拦的没拦)会让他带着坏的配置真机跑;假失败(没事报事)会让这张表被无视。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OUTBOUND_P95_BUDGET_MS, pickPercentile, preflight, renderReport, summarizeTiming, verdictOf
} from '../lib/verdict.js'

// ---- 百分位 --------------------------------------------------------------

test('pickPercentile:空样本给 null(而不是 0 —— "没样本"与"很快"不是一回事)', () => {
  assert.equal(pickPercentile([], 0.5), null)
  assert.equal(pickPercentile(null, 0.95), null)
  assert.equal(pickPercentile(['x', NaN, undefined], 0.5), null)
})

test('pickPercentile:最近邻、乱序也认、p 越界夹回', () => {
  const xs = [40, 10, 30, 20] // 故意乱序
  assert.equal(pickPercentile(xs, 0.5), 20)
  assert.equal(pickPercentile(xs, 0.95), 40)
  assert.equal(pickPercentile(xs, 1), 40)
  assert.equal(pickPercentile(xs, 0), 10)
  assert.equal(pickPercentile(xs, 2), 40, 'p>1 夹到 1')
  assert.equal(pickPercentile(xs, -1), 10, 'p<0 夹到 0')
  const five = [1, 2, 3, 4, 5]
  assert.equal(pickPercentile(five, 0.5), 3)
  assert.equal(pickPercentile(five, 0.9), 5)
})

// ---- 分段耗时 -----------------------------------------------------------

test('summarizeTiming:缺字段当 0,样本给 P50/P95/最慢', () => {
  const t = summarizeTiming(undefined)
  assert.deepEqual([t.pushes, t.sent, t.failed, t.dropped, t.sampleCount], [0, 0, 0, 0, 0])
  assert.equal(t.p50, null)
  const t2 = summarizeTiming({ pushes: 3, rows: 4, sent: 4, failed: 0, dropped: 1, samples: [5, 8, 9, 12, 40] })
  assert.equal(t2.pushes, 3)
  assert.equal(t2.rows, 4)
  assert.equal(t2.sampleCount, 5)
  assert.equal(t2.p50, 9)
  assert.equal(t2.p95, 40)
  assert.equal(t2.max, 40)
  assert.equal(t2.last, null)
})

test('summarizeTiming:**已算好的摘要也要认**(插件发的就是摘要,不是原始样本)', () => {
  // 这条钉住 2026-09-28 自检抓到的真 bug:只认 samples ⇒ 永远"样本 0 条"、耗时结论被静默漏掉
  const t = summarizeTiming({ pushes: 3, rows: 4, sent: 4, sampleCount: 4, p50: 31, p95: 78, max: 78, last: { pushToSentMs: 31 } })
  assert.equal(t.sampleCount, 4)
  assert.equal(t.p50, 31)
  assert.equal(t.p95, 78)
  assert.equal(t.max, 78)
  assert.equal(t.last.pushToSentMs, 31)
  // 摘要里给了 null(真没样本)⇒ 如实是 null,不许编成 0
  const empty = summarizeTiming({ pushes: 0, sampleCount: 0, p50: null, p95: null, max: null })
  assert.equal(empty.p95, null)
  assert.equal(empty.sampleCount, 0)
})

// ---- 体检判据 -----------------------------------------------------------

/** 一份"全都好"的状态:后面各条用例在它身上改一处,看报不报得出来。 */
const goodPlugin = (over = {}) => ({
  ok: true,
  version: '0.1.0',
  enabled: true,
  accessTokenSet: true,
  allowlistSize: 1,
  configProblems: [],
  channel: { mode: 'service', serviceAvailable: true, transport: 'auto' },
  mouth: { registered: true, serviceAvailable: true },
  connection: { state: 'open' },
  client: { state: 'open', stale: false, rejectedAuth: 0, rejected: 0, sent: 4, received: 3 },
  timing: { pushes: 2, rows: 3, sent: 3, failed: 0, dropped: 0, samples: [12, 30, 45, 80], last: { pushToSentMs: 45, sentToAckMs: 2 } },
  ...over
})

const levels = (checks) => Object.fromEntries(checks.map((c) => [c.id, c.level]))

test('体检:全都好 ⇒ 通过,P95 如实报出', () => {
  const checks = preflight({ plugin: goodPlugin(), main: { version: '0.30.1', relay: { enabled: true } } })
  const v = verdictOf(checks)
  assert.equal(v.pass, true)
  assert.equal(v.fails, 0)
  assert.equal(levels(checks).mode, 'ok')
  assert.equal(levels(checks).mouth, 'ok')
  assert.equal(levels(checks).timing, 'ok')
  const r = renderReport({ checks, timing: summarizeTiming(goodPlugin().timing) })
  assert.ok(r.includes('结论:通过'), r)
  assert.ok(r.includes('P95 80ms'), r)
  assert.ok(r.includes('推来→送出 45ms'), r)
})

test('体检:拿不到插件状态 ⇒ 一条 fail 就够,别继续编', () => {
  const checks = preflight({ plugin: null })
  assert.equal(checks.length, 1)
  assert.equal(checks[0].level, 'fail')
})

// ---- 契约对账 + 干跑自检(2026-09-28 骨架)--------------------------------
// 这两条的口径:**对不上要留痕(不许静默降级)**,但版本差异只是警告、不是挡路。

test('体检:契约对账 —— 能力齐 ⇒ ok;老主包 ⇒ warn(不挡路);缺能力 ⇒ fail', () => {
  const full = { available: true, legacy: false, ok: true, code: '', missing: [], softMissing: [], have: ['inject', 'lease', 'ack', 'subscribeOutbound', 'registerChannel', 'status', 'selftest'], api: { min: 1, max: 2 }, apiIssue: '', note: '' }
  const good = levels(preflight({ plugin: goodPlugin({ channel: { mode: 'service', serviceAvailable: true, contract: full } }) }))
  assert.equal(good.contract, 'ok')
  const legacy = levels(preflight({ plugin: goodPlugin({ channel: { mode: 'service', serviceAvailable: true, contract: { ...full, legacy: true, api: null, note: '主包没有 hello():按看到的方法降级对账(老版本,建议升级主包)' } } }) }))
  assert.equal(legacy.contract, 'warn', '老主包不许判死,但必须留痕')
  const missing = levels(preflight({ plugin: goodPlugin({ channel: { mode: 'service', serviceAvailable: true, contract: { ...full, ok: false, code: 'echo_relay_capability_missing', missing: ['lease'], note: '主包少能力:lease' } } }) }))
  assert.equal(missing.contract, 'fail', '缺必需能力 = 她说不了话,必须挡路')
  const soft = levels(preflight({ plugin: goodPlugin({ channel: { mode: 'service', serviceAvailable: true, contract: { ...full, softMissing: ['registerChannel'] } } }) }))
  assert.equal(soft['contract-soft'], 'warn', '可选能力缺失要报出来(降级不是正常)')
})

test('体检:版本区间对不上 ⇒ warn,而且明说"不拒"(能力名对得上就照跑)', () => {
  const api = { available: true, legacy: false, ok: true, code: '', missing: [], softMissing: [], have: [], api: { min: 3, max: 9 }, apiIssue: 'too_new', note: '主包契约比本插件新' }
  const l = levels(preflight({ plugin: goodPlugin({ channel: { mode: 'service', serviceAvailable: true, contract: api } }) }))
  assert.equal(l.contract, 'ok', '版本差异不该判死')
  assert.equal(l['contract-api'], 'warn')
  const r = renderReport({ checks: preflight({ plugin: goodPlugin({ channel: { mode: 'service', serviceAvailable: true, contract: api } }) }) })
  assert.ok(r.includes('不拒'), '报告里要写明为什么只警告:' + r)
})

test('体检:干跑自检没过 = 挡路,而且要把失败项摆出来(不许只说"失败了")', () => {
  const okSt = { ok: true, checks: [{ name: 'envelope-valid', ok: true, detail: '' }], note: '干跑:不写库、不建会话、不发模型' }
  assert.equal(levels(preflight({ plugin: goodPlugin({ channel: { mode: 'service', serviceAvailable: true, selftest: okSt } }) })).selftest, 'ok')
  const badSt = { ok: false, checks: [{ name: 'envelope-invalid-rejected', ok: false, detail: '坏信封被放过了' }], note: '' }
  const checks = preflight({ plugin: goodPlugin({ channel: { mode: 'service', serviceAvailable: true, selftest: badSt } }) })
  assert.equal(levels(checks).selftest, 'fail')
  assert.match(String(checks.find((c) => c.id === 'selftest').text), /envelope-invalid-rejected/, '失败项名字必须出现在结论里')
  // 老主包没有 selftest ⇒ **不报**(降级,由 contract 那条警告提示升级) —— 不许编一条结论出来
  assert.equal(preflight({ plugin: goodPlugin() }).find((c) => c.id === 'selftest'), undefined)
})

test('体检:fail 档 = 根本收不到/送不出(口令空、白名单空、唯一的路不通、没注册)', () => {
  assert.equal(levels(preflight({ plugin: goodPlugin({ accessTokenSet: false }) })).token, 'fail')
  assert.equal(levels(preflight({ plugin: goodPlugin({ allowlistSize: 0 }) })).allowlist, 'fail')
  assert.equal(levels(preflight({ plugin: goodPlugin({ channel: { mode: 'none', serviceAvailable: false } }) })).mode, 'fail')
  // 总闸开着却没注册上 ⇒ 主包会以为她没嘴(工具/门全关)—— 这条也挡路
  assert.equal(levels(preflight({ plugin: goodPlugin({ mouth: { registered: false } }) })).mouth, 'fail')
  assert.equal(levels(preflight({ plugin: goodPlugin({ client: { rejectedAuth: 2 } }) })).auth, 'fail')
  assert.equal(levels(preflight({ plugin: goodPlugin(), main: { version: 'x', relay: { enabled: false } } })).gate, 'fail')
})

test('体检:mode=none 是**挡路**(服务注入是唯一的路;旧 HTTP 兜底已退役,没有备胎)', () => {
  const checks = preflight({ plugin: goodPlugin({ channel: { mode: 'none', serviceAvailable: false } }) })
  const m = checks.find((c) => c.id === 'mode')
  assert.ok(m, '必须报出来')
  assert.equal(m.level, 'fail', '她根本说不了话 = 挡路(不是"能用但有代价")')
  assert.ok(m.text.includes('服务注入'), '要说清唯一的路是服务注入:' + m.text)
  assert.ok(m.text.includes('退役'), '要说清旧 HTTP 兜底已退役:' + m.text)
  assert.equal(verdictOf(checks).pass, false)
  // 服务注入在 ⇒ 正常,并且文案写准
  const good = preflight({ plugin: goodPlugin() }).find((c) => c.id === 'mode')
  assert.equal(good.level, 'ok')
  assert.ok(good.text.includes('传输:服务注入'), good.text)
})

test('体检:总闸关着不算 fail —— "装上 ≠ 开了",提醒他去开', () => {
  const checks = preflight({ plugin: goodPlugin({ enabled: false, mouth: { registered: false } }) })
  const l = levels(checks)
  assert.equal(l.enabled, 'warn')
  assert.equal(l.mouth, 'warn', '总闸关着就不该注册 —— 这是对的,不是错')
  assert.equal(verdictOf(checks).pass, true)
})

test('体检:warn 档 = 能用但有代价(NapCat 没连、还没样本、有行没送出去)', () => {
  assert.equal(levels(preflight({ plugin: goodPlugin({ connection: { state: 'closed' } }) })).conn, 'warn')
  assert.equal(levels(preflight({ plugin: goodPlugin({ client: { stale: true, misses: 3, rejectedAuth: 0, rejected: 0 } }) })).stale, 'warn')
  assert.equal(levels(preflight({ plugin: goodPlugin({ timing: { pushes: 0, samples: [] } }) })).timing, 'warn')
  assert.equal(levels(preflight({ plugin: goodPlugin({ timing: { pushes: 1, sent: 0, failed: 2, samples: [10] } }) })).failed, 'warn')
  assert.equal(levels(preflight({ plugin: goodPlugin({ timing: { pushes: 2, dropped: 1, samples: [10] } }) })).dropped, 'warn')
  assert.equal(levels(preflight({ plugin: goodPlugin({ configProblems: ['transport 值不认识'] }) })).config, 'warn')
})

test('体检:P95 超预算要提醒(预算是 100ms,轮询时代 ~1000/2000)', () => {
  assert.equal(OUTBOUND_P95_BUDGET_MS, 100)
  const slow = preflight({ plugin: goodPlugin({ timing: { pushes: 1, samples: [900, 1500] } }) })
  const t = slow.find((c) => c.id === 'timing')
  assert.equal(t.level, 'warn')
  assert.ok(t.text.includes('1500ms'), t.text)
  // 有推送却没耗时数字(插件版本旧)⇒ 提醒,不许静默漏掉
  const noNumbers = preflight({ plugin: goodPlugin({ timing: { pushes: 2, samples: undefined, p95: null } }) })
  const t2 = noNumbers.find((c) => c.id === 'timing')
  assert.equal(t2.level, 'warn')
  assert.ok(t2.text.includes('没有耗时数字'), t2.text)
})

test('体检:入站被主包拒 = **挡路**,而且要把主包给的理由摆出来(2026-09-28 not-master 那次)', () => {
  const bad = preflight({
    plugin: goodPlugin({ channel: { mode: 'service', counters: { in: 0, inRejected: 3, errors: 0 }, lastRejectReason: 'not-master' } })
  })
  const f = bad.find((c) => c.id === 'inbound')
  assert.ok(f, '必须报出来')
  assert.equal(f.level, 'fail', '她听不到他 = 挡路')
  assert.ok(f.text.includes('not-master'), '理由要看得见,别让人再去翻库:' + f.text)
  // 有入站且没被拒 ⇒ 正常
  const good = preflight({ plugin: goodPlugin({ channel: { mode: 'service', counters: { in: 5, inRejected: 0 }, lastRejectReason: '' } }) })
  assert.equal(good.find((c) => c.id === 'inbound').level, 'ok')
  // 一条都没来过 ⇒ 不报(还没开始聊)
  const none = preflight({ plugin: goodPlugin({ channel: { mode: 'service', counters: { in: 0, inRejected: 0 }, lastRejectReason: '' } }) })
  assert.equal(none.find((c) => c.id === 'inbound'), undefined)
})

test('体检:NapCat 连接的真实状态要认对(client-connected 算正常,不是"没连上")', () => {
  const c = (state) => preflight({
    plugin: goodPlugin({
      connection: { state },
      client: { state, stale: false, rejectedAuth: 0, rejected: 0 }
    })
  }).find((x) => x.id === 'conn')
  assert.equal(c('client-connected').level, 'ok', '连上了就是连上了(真机第一次跑验收时这里报错过)')
  assert.equal(c('open').level, 'ok', '旧写法也认')
  assert.equal(c('listening').level, 'warn')
  assert.ok(c('listening').text.includes('还没连上'), c('listening').text)
  assert.equal(c('closed').level, 'warn')
  assert.equal(c(null).level, 'warn')
})

test('体检:过渡期"叫醒时还没接上"算提醒(不是故障)', () => {
  const trans = preflight({ plugin: goodPlugin({ timing: { pushes: 0, rows: 0, sent: 0, skippedNoClient: 3, samples: [] } }) })
  const s = trans.find((c) => c.id === 'skipped')
  assert.ok(s, '要报出来')
  assert.equal(s.level, 'warn', '话没丢 ⇒ 不是挡路')
  assert.ok(s.text.includes('还没接上'), s.text)
})

test('体检:喊了"有活儿"却一行没发出去 ⇒ **挡路**(最阴的坏法)', () => {
  const broken = preflight({
    plugin: goodPlugin({ timing: { pushes: 3, rows: 4, sent: 0, failed: 4, dropped: 0, samples: [3, 4, 5] } })
  })
  const s = broken.find((c) => c.id === 'sent')
  assert.ok(s, '必须报出来')
  assert.equal(s.level, 'fail')
  assert.ok(s.text.includes('一行都没送出去'), s.text)
  assert.equal(verdictOf(broken).pass, false)
  // 正常发出去就不报
  assert.equal(preflight({ plugin: goodPlugin() }).find((c) => c.id === 'sent'), undefined)
  // 压根没活儿也不报(还没开始跑,不是故障)
  assert.equal(preflight({ plugin: goodPlugin({ timing: { pushes: 0, rows: 0, sent: 0, samples: [] } }) }).find((c) => c.id === 'sent'), undefined)
})

test('体检:主包不在 ⇒ 不编它的状态,只提醒(服务/门两条走 warn)', () => {
  const checks = preflight({ plugin: goodPlugin(), main: null })
  const l = levels(checks)
  assert.equal(l.main, undefined)
  assert.equal(l.gate, undefined)
  assert.equal(l.service, 'ok', '插件自己说服务在,那就是在')
})

test('renderReport:没有样本时如实写 "-",结论口径对得上', () => {
  const checks = preflight({ plugin: goodPlugin({ enabled: false, timing: { pushes: 0, samples: [] } }) })
  const r = renderReport({ checks, timing: summarizeTiming({ pushes: 0, samples: [] }) })
  assert.ok(r.includes('样本 0 条,P50 -ms'), r)
  assert.ok(r.includes('结论:通过'), r)
  // 总闸关(=warn)+ 还没样本(=warn)⇒ 两项注意
  assert.ok(r.includes('2 项注意'), r)
  assert.ok(r.includes('dsh-echo-qq 验收体检'), '默认标题')
  assert.ok(renderReport({ checks, title: '换标题' }).startsWith('换标题'))
})
