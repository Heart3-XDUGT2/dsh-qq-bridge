/**
 * 「启动窗口」那条 409 不许丢话(2026-09-28 旧桥退役后补的)。
 *
 * 退役后入站的门只剩"有没有渠道插件自报家门";宿主先起、我们后到(自报家门最迟
 * 5 秒一轮对账)⇒ 这中间的来信会被主包回 409 `scope-off`。它原来**不在重试名单**
 * 里,于是"她刚醒、你说话她没听见"会真的悄悄没了。这里把白名单的两头都钉住:
 * 该重试的(scope-off / permission-unavailable)一定重试;
 * 不该重试的(not-master / group-refused / bad-envelope)绝不浪费 22 秒。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChannel, SERVICE_NAME } from '../lib/contract.js'

/** 假 ctx:只有 get(SERVICE_NAME) 有值。 */
const ctxOf = (service) => ({ get: (n) => (n === SERVICE_NAME ? (service ?? undefined) : undefined) })

/** 一个按剧本回话的假服务:第 i 次 inject 回 script[i-1](用完回 ok)。 */
function scriptService (script) {
  const seen = []
  return {
    seen,
    service: {
      version: 1,
      inject: async (e) => {
        seen.push(e.msgId)
        const r = script[seen.length - 1]
        return r ?? { ok: true }
      },
      subscribeOutbound: () => () => {}
    }
  }
}

const FAST = { inboundRetryTimes: 3, inboundRetryBaseMs: 1 }

test('启动窗口:主包回 409 scope-off(她还没"有嘴")⇒ 按 msgId 重试,别丢这句话', async () => {
  const { service, seen } = scriptService([
    { ok: false, reason: 'scope-off' },      // 宿主刚起,我们还没注册上
    { ok: false, reason: 'scope-off' },      // 还在窗口里
    { ok: true }                            // 注册上了 ⇒ 这句话进去了
  ])
  const ch = createChannel({ ctx: ctxOf(service), settings: FAST })
  const r = await ch.inject({ msgId: 'm-window', chatId: '<your-qq>', text: '在吗' })
  assert.equal(r.ok, true)
  assert.equal(seen.length, 3, '试了三次(前两次被门挡在外面)')
  assert.equal(ch.status().counters.in, 1, '最后**收到**了')
  assert.equal(ch.status().counters.inRejected, 0, '不算被拒')
  assert.equal(ch.status().counters.inRetried, 2, '重试留痕:面板上看得到"她刚醒那段"')
})

test('权限预设还没就位(permission-unavailable)也算暂时性 ⇒ 重试', async () => {
  const { service, seen } = scriptService([
    { ok: false, reason: 'permission-unavailable' },
    { ok: true }
  ])
  const ch = createChannel({ ctx: ctxOf(service), settings: FAST })
  assert.equal((await ch.inject({ msgId: 'm-perm' })).ok, true)
  assert.equal(seen.length, 2)
})

test('不是主人 / 群聊 / 形状不对 ⇒ 一次都不重试(别拿 22 秒去换同一个拒绝)', async () => {
  for (const reason of ['not-master', 'group-refused', 'bad-envelope']) {
    const { service, seen } = scriptService([{ ok: false, reason }])
    const ch = createChannel({ ctx: ctxOf(service), settings: FAST })
    const r = await ch.inject({ msgId: 'm-' + reason })
    assert.equal(r.ok, false, reason + ':不许当成功')
    assert.equal(seen.length, 1, reason + ':只许试一次')
    assert.equal(ch.status().counters.inRejected, 1, reason + ':记进被拒')
    assert.equal(ch.status().lastRejectReason, reason, reason + ':理由要留在状态里(别只在日志里喊一声)')
  }
})

test('窗口一直不开 ⇒ 试满次数后放弃,理由仍可见', async () => {
  const { service, seen } = scriptService([]) // 永远回 ok?不 —— 用空剧本会 ok,所以这里换一个恒回 scope-off 的
  seen.length = 0
  const always = {
    version: 1,
    inject: async () => { seen.push('x'); return { ok: false, reason: 'scope-off' } },
    subscribeOutbound: () => () => {}
  }
  const ch = createChannel({ ctx: ctxOf(always), settings: FAST })
  const r = await ch.inject({ msgId: 'm-never' })
  assert.equal(r.ok, false)
  assert.equal(seen.length, 3, 'FAST 里配的是 3 次 ⇒ 一次不多(不许无限重试)')
  assert.equal(ch.status().counters.inRetried, 2, '重试计数 = 次数 − 1')
  assert.equal(ch.status().counters.inRejected, 1)
  assert.equal(ch.status().lastRejectReason, 'scope-off', '面板要能看见"是门还没开",不是"她不理我"')
  void service
})
