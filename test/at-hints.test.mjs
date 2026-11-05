/**
 * @ 感知（接收侧·插件层）—— 2026-10-21
 * ==================================================================
 * 他问的两件事：「她能不能 @ 别人」「能不能看见别人互相 @」。
 * 这一组钉**接收侧的下半段**（段 → 信封字段），主包侧由
 * `dsh-echo/tests/at-hints.test.js` 盯。
 *
 * ## 三条纪律
 *
 *   ① **`text` 一个字不动**。`text === ''` 是「单发图/表情 ⇒ 不用回」的判据
 *      （`index.js` 的 `noReply`），而且 `text` 还是记忆检索的查询词 ——
 *      往里塞 `@你` 会把这两处一起弄坏。
 *   ② **`atMe` 复用 `group-awake.js` 的 `isAtMe`**，不写第二份判据。
 *   ③ **没 @ 时信封形状逐位不变**（不多出任何键）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { atHintsOfSegments, buildPrivateEnvelope } from '../lib/envelope.js'

const SELF = '3783207594'
const ZHANG = 880000002

// ---- ① atHintsOfSegments -------------------------------------------------

test('① @ 她 ⇒ atMe，且**不进** atOthers', () => {
  const r = atHintsOfSegments([{ type: 'at', qq: Number(SELF) }], SELF)
  assert.equal(r.atMe, true)
  assert.deepEqual(r.atOthers, [], '@ 她自己的那条不该重复进 atOthers')
})

test('② ★ @ 她和别人 ⇒ atMe + atOthers 都有', () => {
  const r = atHintsOfSegments([
    { type: 'at', qq: Number(SELF) },
    { type: 'at', qq: ZHANG, name: '张三' }
  ], SELF)
  assert.equal(r.atMe, true)
  assert.deepEqual(r.atOthers, [{ qq: String(ZHANG), name: '张三' }])
})

test('③ @ 别人不 @ 她 ⇒ atMe=false，atOthers 有', () => {
  const r = atHintsOfSegments([{ type: 'at', qq: ZHANG, name: '张三' }], SELF)
  assert.equal(r.atMe, false)
  assert.equal(r.atOthers.length, 1)
})

test('④ ★ 没有 name ⇒ 留下空串（降级由主包做，插件不编）', () => {
  const r = atHintsOfSegments([{ type: 'at', qq: ZHANG }], SELF)
  assert.deepEqual(r.atOthers, [{ qq: String(ZHANG), name: '' }])
})

test('⑤ ★ 原始嵌套形状（{type,data:{qq}}）也要认', () => {
  const r = atHintsOfSegments([{ type: 'at', data: { qq: String(SELF) } }], SELF)
  assert.equal(r.atMe, true)
})

test('⑥ @全体成员（qq=all）⇒ 不在 atMe，进 atOthers 且 qq 保留原串', () => {
  const r = atHintsOfSegments([{ type: 'at', qq: 'all' }], SELF)
  assert.equal(r.atMe, false)
  assert.deepEqual(r.atOthers, [{ qq: 'all', name: '' }])
})

test('⑦ 没有 at 段 / 结构不对 ⇒ 空结果（不炸）', () => {
  assert.deepEqual(atHintsOfSegments([], SELF), { atMe: false, atOthers: [] })
  assert.deepEqual(atHintsOfSegments(null, SELF), { atMe: false, atOthers: [] })
  assert.deepEqual(atHintsOfSegments([{ type: 'text', text: 'x' }], SELF), { atMe: false, atOthers: [] })
})

test('⑧ selfId 为空 ⇒ atMe 永远 false（isAtMe 的既有语义）', () => {
  const r = atHintsOfSegments([{ type: 'at', qq: Number(SELF) }], '')
  assert.equal(r.atMe, false)
})

// ---- ② buildPrivateEnvelope 带字段 ---------------------------------------

const base = {
  userId: String(ZHANG), userName: '张三', messageId: 'm-1',
  text: '看这个', chatType: 'group', groupId: '822309315', selfId: SELF
}

test('⑨ ★ @ 她 ⇒ 信封带 atMe', () => {
  const built = buildPrivateEnvelope({
    ...base,
    segments: [{ type: 'at', qq: Number(SELF) }, { type: 'text', text: '看这个' }]
  })
  assert.equal(built.ok, true, JSON.stringify(built))
  assert.equal(built.envelope.atMe, true)
  assert.deepEqual(built.envelope.atOthers, [])
})

test('⑩ ★ @ 她 + 张三 ⇒ 两个字段都在', () => {
  const built = buildPrivateEnvelope({
    ...base,
    segments: [{ type: 'at', qq: Number(SELF) }, { type: 'at', qq: ZHANG, name: '张三' }]
  })
  assert.equal(built.envelope.atMe, true)
  assert.deepEqual(built.envelope.atOthers, [{ qq: String(ZHANG), name: '张三' }])
})

test('⑪ ★★ 没有 @ ⇒ 信封**不多出任何键**（向后兼容）', () => {
  const built = buildPrivateEnvelope({
    ...base,
    segments: [{ type: 'text', text: '看这个' }]
  })
  assert.equal(built.ok, true)
  assert.equal('atMe' in built.envelope, false, '★ 没 @ 时形状要与从前逐位一致')
  assert.equal('atOthers' in built.envelope, false)
})

test('⑫ ★★ `text` 一个字不动（@ 不进 text）', () => {
  const built = buildPrivateEnvelope({
    ...base,
    segments: [{ type: 'at', qq: Number(SELF) }, { type: 'text', text: '看这个' }]
  })
  assert.equal(built.envelope.text, '看这个', '★ 塞 @ 进 text 会把 noReply 判据和记忆检索一起弄坏')
  assert.equal(built.envelope.text.includes('@'), false)
  assert.equal(built.envelope.text.includes('你'), false)
})

test('⑬ atOthers 上限 8 个（再多也没人读得完）', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ type: 'at', qq: 100000 + i }))
  const built = buildPrivateEnvelope({ ...base, segments: many })
  assert.equal(built.envelope.atOthers.length, 8)
})

test('⑭ 私聊里也有 at（理论上不该有）⇒ 照样如实带出来，不猜', () => {
  const built = buildPrivateEnvelope({
    userId: String(ZHANG), userName: '张三', messageId: 'm-2',
    text: 'x', chatType: 'private', selfId: SELF,
    segments: [{ type: 'at', qq: Number(SELF) }]
  })
  assert.equal(built.envelope.atMe, true, '私聊有 at 就如实说 —— 由主包决定怎么用')
})
