/**
 * 长消息切段(纯函数,便于单测)。
 *
 * **为什么不能截断**:旧适配器(`astrbot_adapter/main.py:575-584`)对超长回复是
 * `split_segments(text, max_chars)` 之后**一段一段发**;头一版这里写成了
 * `text.slice(0, maxChars)` —— 那是**真丢话**(超出的部分他永远看不到),
 * 而且丢得毫无痕迹。2026-09-28 出站字段对齐时才看出来。
 *
 * 切法(宁少切、不切碎):
 *   ① 够短 ⇒ 原样一段;
 *   ② 否则**先按换行切**(她的换行是有意的停顿),把行贪心地塞进 ≤ maxChars 的段;
 *   ③ 单行本身就超长 ⇒ 硬切(maxChars 一块)。
 * 规则只有一条要守的:**每段 ≤ maxChars**(QQ 侧上限),且拼起来 ≡ 原文(不丢字)。
 */
export const DEFAULT_MAX_CHARS = 500

/**
 * 硬切的落点:**≤ cap,但绝不落在代理对(emoji)中间**(v0.42.0 审计修复 P1)。
 *
 * 一个 emoji 在 JS 里是 2 个码元(`😀` = `\uD83D\uDE00`),`slice(0, cap)` 正好
 * 切在中间就是两个半个字符 —— 发出去是两个乱码方块(2026 全仓审计已复现)。
 * 退一格:这一段少一个字符、下一段多一个字符,拼起来仍 ≡ 原文。
 * 退化情形(整段只剩这一个字符、退无可退)宁可这一段超 1 个码元,也不发半个字。
 */
function cutAt (s, cap) {
  const i = Math.min(cap, s.length)
  if (i >= s.length) return s.length
  const prev = s.charCodeAt(i - 1)
  const next = s.charCodeAt(i)
  const inPair = prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
  if (!inPair) return i
  return i - 1 > 0 ? i - 1 : i + 1
}

/**
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]} 段数组(空文本 ⇒ 空数组)
 */
export function splitForSend (text, maxChars = DEFAULT_MAX_CHARS) {
  const cap = Math.max(1, Math.floor(Number(maxChars) || DEFAULT_MAX_CHARS))
  const body = String(text ?? '')
  if (body === '') return []
  if (body.length <= cap) return [body]

  const out = []
  let cur = ''
  const flush = () => { if (cur !== '') { out.push(cur); cur = '' } }
  for (const line of body.split('\n')) {
    const piece = cur === '' ? line : '\n' + line
    if (cur !== '' && (cur.length + piece.length) > cap) flush()
    // 单行超长:硬切
    let rest = cur === '' ? line : line
    if (cur === '' && rest.length > cap) {
      while (rest.length > cap) {
        const cut = cutAt(rest, cap)
        out.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      cur = rest
      continue
    }
    cur = cur === '' ? rest : cur + '\n' + rest
  }
  flush()
  return out
}
