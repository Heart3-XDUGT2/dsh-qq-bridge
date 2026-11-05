/**
 * `lib/emo-marker.js` + 出站收口接线的电池(2026-10-05 拍板 2-A)。
 *
 * 钉住三件事:
 *   ① 口径与 heart-tts 一致(半/全角、别名、大小写;未闭合不剥);
 *   ② **出站那道缝** —— `deliver()` 干的两步(剥 → `splitForSend`)跑一遍,
 *      发出去的每一段都不带标记(这是"带标记的行进来、发出去没有标记"那条);
 *   ③ **接线真的在**(源码级守卫):`deliver` 里必须先 `stripEmoMarkers(row.text)`
 *      再 `splitForSend(text, …)` —— 模块对但没人调,等于没修。
 *
 * 为什么不做"起真插件、喂一行、看发出去什么"的整链测试:`deliver()` 在
 * `apply()` 闭包里、不导出,要跑通得假一个 webServer + OneBot 连接 + 渠道注册,
 * 成本远大于收益(那些链路由 `acceptance.mjs` 在真机上覆盖)。这里钉的是**同一行代码的缝**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripEmoMarkers, hasEmoMarker } from '../lib/emo-marker.js'
import { splitForSend } from '../lib/split.js'

test('emo:剥掉半/全角与别名,未闭合原样保留', () => {
  assert.equal(stripEmoMarkers('我明白了。[emo:2] 但这个我不能答应你。'), '我明白了。 但这个我不能答应你。')
  assert.equal(stripEmoMarkers('【emotion：2】你好'), '你好')
  assert.equal(stripEmoMarkers('[style:强调·上扬]走'), '走')
  assert.equal(stripEmoMarkers('他说[emo:2'), '他说[emo:2')
  assert.equal(stripEmoMarkers(null), '')
})

test('出站缝:带标记的行进来 ⇒ 发出去的每一段都没有标记', () => {
  const row = { id: 7, text: '我明白了。[emo:2] 但这个我不能答应你。' }
  // deliver() 的两步(见 lib/index.js 的 deliver:先剥,再 splitForSend(text, …))
  const segments = splitForSend(stripEmoMarkers(row.text), 500)
  assert.equal(segments.length, 1)
  for (const s of segments) {
    assert.equal(hasEmoMarker(s), false, '到他手机屏上的字不许带机器语法')
  }
  assert.equal(segments.join(''), '我明白了。 但这个我不能答应你。', '除了指令,一个字不许少')
})

test('出站缝:超长文本剥完再分段,段数与内容都不受影响', () => {
  const body = ('测试[emo:2]一句话。').repeat(120) // 剥完 720 字 ⇒ 必然 > 500 要分段
  const segments = splitForSend(stripEmoMarkers(body), 500)
  assert.ok(segments.length > 1)
  for (const s of segments) {
    assert.ok(s.length <= 500)
    assert.equal(hasEmoMarker(s), false)
  }
  assert.equal(segments.join(''), ('测试一句话。').repeat(120))
})

test('出站缝:整行只有标记 ⇒ 剥完为空(deliver 据此销账不发,不留死行)', () => {
  assert.equal(stripEmoMarkers('[emo:2]').trim(), '')
  assert.deepEqual(splitForSend(stripEmoMarkers('[emo:2]'), 500), [],
    '空文本 ⇒ 空数组(所以 deliver 必须先判空并销账,否则回执不上、租约重发打转)')
})

test('接线守卫:deliver 里必须"先剥再分段"(源码级)', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ stripEmoMarkers \} from '\.\/emo-marker\.js'/, 'import 必须在')
  assert.match(src, /const text = stripEmoMarkers\(row\.text\)[\s\S]{0,600}?splitForSend\(text, settings\.replyMaxChars\)/,
    'deliver 必须先剥 row.text,再把剥过的 text 交给 splitForSend')
})
