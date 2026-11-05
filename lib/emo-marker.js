/**
 * `[emo:…]` 语气指令的剥离(QQ 出站收口,2026-10-05 拍板 2-A)。
 *
 * 这是**自带的第二份**(他拍的:各留一份 + 两份都指向同一注释出处)。
 * 权威出处:主包 `dsh-echo/lib/emo-marker.js`(完整背景、为什么不"在上游统一剥"、
 * 刻意不做的事都写在那边);正则源头是 heart-tts 的 `host/impl.js:148`。
 *
 * 为什么 QQ 侧还要再来一道(主包 `dsh-echo/lib/index.js:2501` 已经剥过一次):
 *   `deliver()` 发出去的是 `relay_outbox` 里的一行 `row.text`,那一行的来源
 *   不止一条路(自动回话入队 / 她用手 `echo_qq_say` / 主动话 / 队列里早先
 *   留下的旧行)。**出站收口这里是最后一道**:无论上游哪条路漏下来,
 *   到他手机屏上的字都不带机器语法。
 *
 * ⚠️ 两份必须同步改:口径一旦分叉,就会出现"DSH 干净、QQ 不干净"这种最难查的形状。
 *    改这个正则时,**同时**改主包那份,并跑两边的测试。
 */

/** 出处:`dsh-plugin-heart-tts-main/host/impl.js:148`(与主包那份逐字相同)。 */
const MARKER_G = /[\[［【]\s*(?:emo|emotion|style)\s*[:：]\s*[^\]］】\[]{1,40}?\s*[\]］】]/gi

/**
 * 剥掉语气指令;非字符串按空串;未闭合/畸形写法原样保留。
 * @param {unknown} text
 * @returns {string}
 */
export function stripEmoMarkers (text) {
  const s = typeof text === 'string'
    ? text
    : (text === null || text === undefined ? '' : String(text))
  if (s === '') return ''
  return s.replace(MARKER_G, '')
}

/** 有没有语气指令(诊断用,不动文本)。 */
export function hasEmoMarker (text) {
  const s = typeof text === 'string' ? text : ''
  if (s === '') return false
  MARKER_G.lastIndex = 0
  const hit = MARKER_G.test(s)
  MARKER_G.lastIndex = 0
  return hit
}
