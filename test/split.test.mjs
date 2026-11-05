/**
 * `lib/split.js` 的单测 —— 超长回复**切段而不是截断**。
 *
 * 为什么值得钉:头一版这里是 `text.slice(0, maxChars)`,超出部分**真丢**
 * (他永远看不到),而且丢得毫无痕迹。旧适配器是切段发
 * (`astrbot_adapter/main.py:575-584`),这里补回来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MAX_CHARS, splitForSend } from '../lib/split.js'

test('够短就一段(不动她的话,一个空格都不加)', () => {
  assert.deepEqual(splitForSend('在的。', 500), ['在的。'])
  assert.deepEqual(splitForSend('', 500), [], '空文本 ⇒ 空数组(不发明空消息)')
  assert.deepEqual(splitForSend('  ', 500), ['  '], '空白也是有内容的')
})

test('超长:每段都 ≤ cap,而且拼起来一个字不少', () => {
  const text = 'A'.repeat(1200)
  const segs = splitForSend(text, 500)
  assert.equal(segs.length, 3)
  for (const s of segs) assert.ok(s.length <= 500, '每段都要 ≤ 上限(QQ 侧)')
  assert.equal(segs.join(''), text, '**一个字都不许丢**(这就是它和截断的区别)')
})

test('优先按换行切:她的换行是有意的停顿,别被切碎', () => {
  const text = ['第一行', '第二行', '第三行'].join('\n')
  const segs = splitForSend(text, 10)
  assert.deepEqual(segs, ['第一行\n第二行', '第三行'], '尽量整行搬,别拆散')
  assert.equal(segs.join('\n'), text)
})

test('单行本身就超长 ⇒ 硬切', () => {
  const segs = splitForSend('B'.repeat(25), 10)
  assert.deepEqual(segs.map((s) => s.length), [10, 10, 5])
  assert.equal(segs.join(''), 'B'.repeat(25))
})

test('cap 兜底:没给/给垃圾都用默认值', () => {
  assert.equal(DEFAULT_MAX_CHARS, 500)
  const segs = splitForSend('C'.repeat(1001), 0)
  assert.equal(segs.length, 3, '0 不能变成"每段 1 个字"')
  for (const s of segs) assert.ok(s.length <= 500)
})

// ---- v0.42.0 审计修复(P1):硬切不许切开代理对(emoji) ----

/** 有没有段是以"半个字符"结尾/开头的(孤立代理 = 发出去就是乱码方块)。 */
function hasLoneSurrogate (s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xDC00 && n <= 0xDFFF)) return true
      i += 1
      continue
    }
    if (c >= 0xDC00 && c <= 0xDFFF) return true
  }
  return false
}

test('硬切:emoji 不许被切成两半(每个段都是合法字符串)', () => {
  // 每个 emoji 2 个码元,cap=5 ⇒ 落点必然撞在代理对中间
  const text = '😀'.repeat(6) // 12 码元
  const segs = splitForSend(text, 5)
  for (const s of segs) {
    assert.ok(!hasLoneSurrogate(s), '段落里不许有孤立代理(发给 QQ 就是乱码方块)')
  }
  assert.equal(segs.join(''), text, '拼起来仍是一个字不少')
  const long = splitForSend('字'.repeat(7) + '😀😀😀', 4)
  for (const s of long) assert.ok(!hasLoneSurrogate(s))
  assert.equal(long.join(''), '字'.repeat(7) + '😀😀😀')
})

test('硬切:退化情形(整段只剩一个 emoji、退无可退)也不许切半个字', () => {
  const segs = splitForSend('😀'.repeat(3), 1)
  for (const s of segs) assert.ok(!hasLoneSurrogate(s), 'cap 小于一个字符时,宁可超 1 个码元也不切半个')
  assert.equal(segs.join(''), '😀'.repeat(3))
})

test('正常的中文/英文文本一切照旧(修 emoji 不许动别的)', () => {
  assert.deepEqual(splitForSend('B'.repeat(25), 10).map((s) => s.length), [10, 10, 5])
  assert.deepEqual(splitForSend('第一行\n第二行', 10), ['第一行\n第二行'])
})
