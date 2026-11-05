/**
 * 契约探测的钉子(2026-09-28 骨架,见 docs/PLAN_CORTICO_ADOPTION.md §3A2)。
 *
 * 这里钉的是**判定口径**,不是实现细节:
 *   ① 硬失败**只**因为必需能力名缺失 —— 版本对不上永不拒载;
 *   ② 老主包(没有 `hello()`)要能继续跑(降级对账 + 警告),否则两个仓的
 *      发布顺序又会被锁死(这正是我们不抄 Cortico 严格相等即拒的原因);
 *   ③ 可选能力缺失要能被看见(降级,而不是当成正常)。
 *
 * 为什么用"假服务对象"而不是真挂一个主包:这是**纯函数**,一个对象字面量就够;
 * 真挂载链路由 lib/index.js 的自报家门 + scripts/acceptance.mjs 端到端覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  probeService, REQUIRED_CAPABILITIES, EXPECTED_CAPABILITIES, API_RANGE, SERVICE_NAME
} from '../lib/contract.js'

/** 一个"新主包":能力齐全 + 自报 api。 */
const fullService = (extra = {}) => ({
  name: SERVICE_NAME,
  version: 1,
  hello: () => ({
    name: SERVICE_NAME,
    version: 1,
    api: { min: 1, max: 2 },
    capabilities: ['inject', 'subscribeOutbound', 'ack', 'lease', 'registerChannel', 'status', 'selftest']
  }),
  inject: async () => ({ ok: true }),
  subscribeOutbound: () => () => {},
  ack: async () => ({ rows: [] }),
  lease: async () => ({ items: [] }),
  registerChannel: () => () => {},
  status: () => ({}),
  selftest: () => ({ ok: true }),
  ...extra
})

/** 一个"老主包":没有 hello(),只有方法。 */
const legacyService = (extra = {}) => ({
  name: SERVICE_NAME,
  version: 1,
  inject: async () => ({ ok: true }),
  subscribeOutbound: () => () => {},
  ack: async () => ({ rows: [] }),
  lease: async () => ({ items: [] }),
  registerChannel: () => () => {},
  status: () => ({}),
  ...extra
})

test('① 服务不在:不可用,码是 echo_relay_unavailable(不许假装有路)', () => {
  for (const nothing of [null, undefined, {}, { inject: 'not-a-function' }]) {
    const r = probeService(nothing)
    assert.equal(r.available, false)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'echo_relay_unavailable')
    assert.deepEqual(r.missing, [...REQUIRED_CAPABILITIES], '不可用时必需能力全算缺')
  }
})

test('② 新主包:能力名对上就是 ok;版本区间只是文案', () => {
  // ⚠️ 跨仓钉子:同一条字面量在**主仓** `lib/speak.js` 的 `SERVICE_API` 与
  //    `tests/relay-service.test.js` ④ 里也钉了一次(两仓没有共享常量)。
  assert.deepEqual({ ...API_RANGE }, { min: 1, max: 2 })
  assert.deepEqual([...REQUIRED_CAPABILITIES].sort(), ['ack', 'inject', 'lease', 'subscribeOutbound'])
  assert.deepEqual([...EXPECTED_CAPABILITIES].sort(), ['registerChannel', 'status'])
  const r = probeService(fullService())
  assert.equal(r.available, true)
  assert.equal(r.legacy, false)
  assert.equal(r.ok, true)
  assert.equal(r.code, '')
  assert.deepEqual(r.api, { min: API_RANGE.min, max: API_RANGE.max })
  assert.equal(r.apiIssue, '')
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.softMissing, [])
})

test('③ 老主包(没有 hello()):必须继续能跑 —— 降级对账 + 标 legacy', () => {
  const r = probeService(legacyService())
  assert.equal(r.available, true)
  assert.equal(r.legacy, true, '没有 hello() 要标 legacy(面板要提示升级)')
  assert.equal(r.ok, true, '老主包不许被判死:降级对账')
  assert.equal(r.api, null)
  assert.match(r.note, /没有 hello/)
  // 老主包缺必需能力 —— 这时候才该红
  const bad = probeService(legacyService({ lease: undefined }))
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'echo_relay_capability_missing')
  assert.ok(bad.missing.includes('lease'))
})

test('④ 硬失败只认能力名:缺一样必需能力 = 挡路', () => {
  for (const name of REQUIRED_CAPABILITIES) {
    const svc = fullService()
    const caps = svc.hello().capabilities.filter((c) => c !== name)
    const r = probeService({ ...svc, hello: () => ({ ...svc.hello(), capabilities: caps }) })
    assert.equal(r.ok, false, '少了 ' + name + ' 必须判不能用')
    assert.equal(r.code, 'echo_relay_capability_missing')
    assert.ok(r.missing.includes(name))
  }
})

test('⑤ 可选能力缺失:能用,但要报出来(降级不是正常)', () => {
  const svc = fullService()
  const r = probeService({
    ...svc,
    hello: () => ({
      ...svc.hello(),
      capabilities: svc.hello().capabilities.filter((c) => !EXPECTED_CAPABILITIES.includes(c))
    })
  })
  assert.equal(r.ok, true, '可选能力缺失不该判死')
  assert.equal(r.code, '')
  assert.deepEqual(r.softMissing, [...EXPECTED_CAPABILITIES])
  assert.match(r.note, /可选能力/)
})

test('⑥ 版本对不上永不拒载(这是有意与 Cortico 相反的地方)', () => {
  for (const api of [{ min: 3, max: 9 }, { min: 0, max: 0 }, { min: 5, max: 5 }]) {
    const svc = fullService()
    const r = probeService({ ...svc, hello: () => ({ ...svc.hello(), api }) })
    assert.equal(r.ok, true, 'api ' + JSON.stringify(api) + ' 不许导致拒载')
    assert.equal(r.code, '', '版本不该产生拒绝码')
    assert.ok(r.apiIssue === 'too_new' || r.apiIssue === 'too_old', '但要留下文案标记')
    assert.notEqual(r.note, '', '对不上要留痕(不许静默)')
  }
  // 区间重叠 = 正常:主包说到 3,我们认得 1~2 ⇒ 交集 [2,2] 非空
  const svc = fullService()
  const r = probeService({ ...svc, hello: () => ({ ...svc.hello(), api: { min: 2, max: 3 } }) })
  assert.equal(r.apiIssue, '', '区间有交集就不该报版本问题')
})

test('⑦ hello() 抛错/形状坏:当老主包处理,不许把插件带崩', () => {
  const throws = legacyService({ hello: () => { throw new Error('boom') } })
  const r = probeService(throws)
  assert.equal(r.available, true)
  assert.equal(r.legacy, true)
  assert.equal(r.ok, true)
  const badApi = legacyService({ hello: () => ({ capabilities: ['inject', 'lease', 'ack', 'subscribeOutbound'] }) })
  assert.equal(probeService(badApi).api, null, 'api 形状坏 ⇒ 当没有(只当文案,不判死)')
  assert.equal(probeService(badApi).ok, true)
})
