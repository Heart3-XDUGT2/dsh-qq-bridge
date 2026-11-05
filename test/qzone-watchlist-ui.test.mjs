/**
 * 空间评论白名单的**写口** + 诊断页的编辑框 —— 2026-10-20
 * ==================================================================
 * 他要「白名单加进设置界面」。
 *
 * ⚠️ **一个必须说清的边界**：`settings-fields.js` 只在**主包** `dsh-echo` 里，
 * 管的是 `~/.dsh/echo/config.json`；而 `qzoneWatchList` 是**插件的**配置
 * （`~/.dsh/echo-qq/config.json`）。往主包字段表加 = 写进另一个文件，
 * 面板改了也不会生效 ⇒ 只能做在**插件自己的诊断页** `/echo-qq/` 上。
 *
 * 这个写口的三条纪律（都写进代码注释了，这里再钉一遍）：
 *   ① 只认 `POST`，且必须带 `x-echo-qq-edit: 1`
 *   ② **只允许改 `qzoneWatchList`** 一个键 —— 不是通用配置写口
 *   ③ 写完立刻 `reload()`，值 ≤1 秒进活视图
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const SRC = read('../lib/index.js')
const HTML = read('../web/index.html')
const APP = read('../web/app.js')

/** 抠出写口那段 handler。 */
function writeRouteBlock () {
  const at = SRC.indexOf("/api/echo-qq/qzone-watchlist")
  assert.ok(at > 0, '找不到白名单写口路由')
  const end = SRC.indexOf("'echo-qq.api.qzoneWatchList()'", at)
  assert.ok(end > at, '找不到写口的收尾')
  return SRC.slice(at, end)
}

test('① ★ 写口只认 POST（GET 一律 405）', () => {
  const b = writeRouteBlock()
  assert.match(b, /req\.method !== 'POST'/, '★ 不挡 GET 就等于给了个只读口')
  assert.match(b, /405/, '应回 405')
})

test('② ★ 写口必须校验 x-echo-qq-edit: 1（防别的页面顺手 POST）', () => {
  const b = writeRouteBlock()
  assert.match(b, /x-echo-qq-edit/, '★ 没有这个头就不许写')
  assert.match(b, /403/, '缺头应回 403')
})

test('③ ★ 只允许改 qzoneWatchList 一个键（不是通用配置写口）', () => {
  const b = writeRouteBlock()
  // saveSettings 的 patch 里只许出现这一个键
  const m = b.match(/saveSettings\(\{([\s\S]*?)\}/)
  assert.ok(m, '找不到 saveSettings 调用')
  const keys = [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1])
  assert.deepEqual(keys, ['qzoneWatchList'], '★ patch 只该有 qzoneWatchList，实际: ' + keys.join(', '))
  // 不许出现"把整个 body 当 patch"的写法
  assert.ok(!/saveSettings\(body\)/.test(b), '★ 不许直接把请求体整个存进去')
})

test('④ 写完立刻 reload()（值 ≤1 秒进活视图）', () => {
  const b = writeRouteBlock()
  assert.match(b, /await reload\(\)/, '★ 写完必须 reload，否则活视图还是旧值')
  assert.match(b, /parseWatchList\(/, '回包里要带上解析后的数组（好让页面回填）')
})

test('⑤ ★ 请求体有上限，且坏 JSON 不许炸', () => {
  assert.match(SRC, /function readJsonBody \(req, limitBytes = 64 \* 1024\)/,
    '要有 64KB 上限的读体工具')
  assert.match(SRC, /if \(size > limitBytes\) \{ finish\(null\); return \}/, '超限要中断')
  const b = writeRouteBlock()
  assert.match(b, /body === null/, '坏 JSON 要回 400，不许抛出去变 500')
})

test('⑥ ★ 诊断页有编辑框（textarea）+ 保存按钮', () => {
  assert.match(HTML, /id="wl"/, '要有编辑框')
  assert.match(HTML, /<textarea[^>]*id="wl"/, '★ 必须是 textarea 多行（一行一个 QQ 号）')
  assert.match(HTML, /id="wlsave"/, '要有保存按钮')
  assert.match(HTML, /留空 = 只感知主人/, '文案要写清留空的含义')
  assert.match(HTML, /一行一个 QQ 号/, '文案要写清格式')
})

test('⑦ ★ 编辑框不会被 2 秒轮询冲掉（正在编辑/改过就跳过）', () => {
  assert.match(APP, /document\.activeElement !== wlEl/, '焦点在框里时不覆盖')
  assert.match(APP, /!wlDirty/, '用户改过之后不覆盖')
})

test('⑧ ★ wlDirty 必须声明在 render() **之前**（顶层脚本，否则 TDZ）', () => {
  const lines = APP.split('\n')
  const declAt = lines.findIndex((x) => x.includes('let wlDirty = false'))
  const renderAt = lines.findIndex((x) => x.includes('function render ('))
  const tickAt = lines.findIndex((x) => x.trim() === 'tick()')
  assert.ok(declAt >= 0, '找不到 wlDirty 声明')
  assert.ok(declAt < renderAt, '★ 声明必须在 render 之前（render 由 tick() 立刻调用）')
  assert.ok(declAt < tickAt, '★ 声明必须在 tick() 之前')
})

test('⑨ 保存请求带上写头；成功后清 dirty 并用服务端解析结果回填', () => {
  assert.match(APP, /'x-echo-qq-edit': '1'/, '★ 保存必须带写头')
  assert.match(APP, /wlDirty = false/, '成功后要清 dirty，好让轮询回填')
  assert.match(APP, /fetch\('\/api\/echo-qq\/qzone-watchlist'/, '要打到正确的路径')
})


// ---- ★★ 2026-10-20：**`saveSettings` 漏 import 那个洞** ----------------------
//
// 现场：「网页前端设置没法写入白名单」。点保存 → 500
//   `{"ok":false,"reason":"write-failed","error":"saveSettings is not defined"}`
//
// 成因：加 import 的那个脚本**在落盘前抛了错**（当时另一处锚点没找到），
// 而这条链路上原有的测试只断言了「`saveSettings(` 出现过」——
// **函数名出现在代码里 ≠ 它被 import 了**。所以全绿但生产必然 500。
//
// 这两条闸一个盯静态（跨模块符号必须 import），一个盯行为（真调一次）。

/** `lib/index.js` 里"被当函数调用"的跨模块符号。 */
const CROSS_MODULE = [
  'saveSettings', 'readSettings', 'parseWatchList', 'bridgeEventUrl',
  'createQzoneEventClient', 'allowsInbound', 'dataDirOf', 'webRootOf',
  'createWebPageHandler'
]

test('⑩ ★ 写口用到的跨模块符号必须真的 import 了（saveSettings 漏过）', () => {
  const importLines = SRC.split('\n').filter((l) => /^import\s/.test(l)).join('\n')
  const missing = []
  for (const name of CROSS_MODULE) {
    // 只在"被调用"时才要求 import（避免误判纯注释/字符串）
    const called = new RegExp('\\b' + name + '\\s*\\(').test(SRC)
    if (!called) continue
    // 本文件自己定义的不算（如 readJsonBody / json / log）
    const definedHere = new RegExp('function\\s+' + name + '\\s*\\(').test(SRC) ||
      new RegExp('const\\s+' + name + '\\s*=').test(SRC)
    if (definedHere) continue
    if (!new RegExp('\\b' + name + '\\b').test(importLines)) missing.push(name)
  }
  assert.deepEqual(missing, [],
    '★ 这些被调用了但没 import ⇒ 运行时 ReferenceError（这次就是这么炸的）: ' + missing.join(', '))
})

test('⑪ ★ 行为：config.js 真的导出 saveSettings，且能写回', async () => {
  const cfg = await import('../lib/config.js')
  assert.equal(typeof cfg.saveSettings, 'function', '★ config.js 要导出 saveSettings')

  // 写到一个临时目录，绝不碰真配置
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'qqcfg-'))

  const after = await cfg.saveSettings({ qzoneWatchList: '880000002,880000003' }, dir)
  assert.equal(after.qzoneWatchList, '880000002,880000003', '写回后应能取到新值')

  const reread = await cfg.readSettings(dir)
  assert.equal(reread.settings.qzoneWatchList, '880000002,880000003', '重新读盘也要是新值')
  // ⚠️ parseWatchList 在本文件作用域里不一定有 ⇒ 动态 import，别靠运气
  const ev = await import('../lib/qzone-events.js')
  assert.equal([...ev.parseWatchList(reread.settings.qzoneWatchList)].length, 2)
})
