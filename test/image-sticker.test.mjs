/**
 * 表情包区分 —— 2026-10-20（第三件）
 * ==================================================================
 * 他提的：「表情包不要描述一通」。
 *
 * 根因是**三层全丢** `sub_type` / `summary`：
 *   `dsh-echo-qq/lib/onebot.js:203` → `envelope.js:imagesOfSegments` → `dsh-echo/lib/relay.js:parseImages`
 * 于是下游 `describeImages` 永远判不出表情包，连 `[动画表情]` 也当普通图正经描述。
 *
 * 外加 `mface`（QQ 大表情）原来走兜底 `{type,data}`，**下游没人认 ⇒ 整段消失**。
 *
 * 这一组钉**插件侧**的两层（段归一 + 信封图记）；
 * 主包侧（`parseImages` 放行、`isStickerImage` 判据、`describeImages` 分岔）
 * 由 `dsh-echo` 自己的 `tests/eyes.test.js` / `tests/relay-images.test.js`（若有）盯。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeSegment } from '../lib/onebot.js'
import { imagesOfSegments } from '../lib/envelope.js'

// ---- 第一层：OneBot 段 → 归一化段 ----------------------------------------

test('① ★ 普通图:sub_type=0 原样带过来', () => {
  const seg = normalizeSegment('image', { url: 'http://x/a.jpg', file: 'a.jpg', sub_type: 0 })
  assert.equal(seg.type, 'image')
  assert.equal(seg.sub_type, 0, '★ 0 也要带（它是"普通图"的正身）')
})

test('② ★ 表情包:sub_type=1 + summary 都要带', () => {
  const seg = normalizeSegment('image', {
    url: 'http://x/s.gif', file: 's.gif', sub_type: 1, summary: '[动画表情]'
  })
  assert.equal(seg.sub_type, 1)
  assert.equal(seg.summary, '[动画表情]', '★ summary 也丢不得 —— 有的实现只发它')
})

test('③ ★ mface（QQ 大表情）⇒ 归一成 image 段并标成表情包', () => {
  const seg = normalizeSegment('mface', { url: 'http://x/m.gif', file: 'm.gif', summary: '[表情]' })
  assert.equal(seg.type, 'image', '★ 必须归一成 image —— 否则下游一个字段都不认，整段消失')
  assert.equal(seg.sub_type, 1, '★ 当表情包对待')
  assert.equal(seg.summary, '[表情]')
})

test('④ mface 没给 summary ⇒ 兜一个 [表情]（不能空）', () => {
  const seg = normalizeSegment('mface', { url: 'http://x/m.gif' })
  assert.equal(seg.summary, '[表情]')
  assert.equal(seg.sub_type, 1)
})

test('⑤ 没有 sub_type / summary 的图 ⇒ 不多塞字段（老行为逐位不变）', () => {
  const seg = normalizeSegment('image', { url: 'http://x/a.jpg', file: 'a.jpg' })
  assert.deepEqual(seg, { type: 'image', url: 'http://x/a.jpg', file: 'a.jpg' })
})

test('⑥ subs_type 给了非法值 ⇒ 丢掉，不塞 NaN', () => {
  const seg = normalizeSegment('image', { url: 'http://x/a.jpg', sub_type: 'abc' })
  assert.equal('sub_type' in seg, false, '非法值不许变成 NaN 混进去')
})

// ---- 第二层：段 → 信封图记 -----------------------------------------------

test('⑦ ★ 信封图记要把两个标记继续带下去', () => {
  const out = imagesOfSegments([
    { type: 'image', url: 'http://x/a.jpg' },
    { type: 'image', url: 'http://x/s.gif', sub_type: 1, summary: '[动画表情]' }
  ])
  assert.equal(out.length, 2)
  assert.equal('sub_type' in out[0], false, '普通图不该凭空多出标记')
  assert.equal(out[1].sub_type, 1, '★ 第二层也不许丢')
  assert.equal(out[1].summary, '[动画表情]')
})

test('⑧ summary 太长 ⇒ 截到 40（与 name 同样的纪律）', () => {
  const out = imagesOfSegments([{ type: 'image', url: 'u', summary: '表'.repeat(80) }])
  assert.equal(out[0].summary.length, 40)
})

test('⑨ 端到端：mface 段走完两级，出来就是"带表情标记的图记"', () => {
  const seg = normalizeSegment('mface', { url: 'http://x/m.gif', summary: '[表情]' })
  const out = imagesOfSegments([seg])
  assert.equal(out.length, 1, '★ 不许消失')
  assert.equal(out[0].sub_type, 1)
  assert.equal(out[0].summary, '[表情]')
  assert.equal(out[0].url, 'http://x/m.gif')
})
