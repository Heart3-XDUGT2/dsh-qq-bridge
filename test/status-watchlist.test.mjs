/**
 * 状态接口要能看见「空间评论白名单」和「空间桥进程」—— 2026-10-20
 * ==================================================================
 * 现场：他往 `~/.dsh/echo-qq/config.json` 写了四个 QQ 号，重启后"接口没更新"。
 *
 * 盘下来发现**值其实生效了**（`readSettings()` 每次读盘、`index.js` 每 5 秒 `reload()`），
 * 真正的问题是 `/api/echo-qq/status` 的 `qzone` 段只展开 `qzone.status()` ——
 * 那里面**只有通道与保活**，`watchList` 和 `bridge` 一个都没有
 * ⇒ 没有任何地方能看见白名单读到了什么，也看不见桥起没起。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseSettings } from '../lib/config.js'
import { parseWatchList } from '../lib/qzone-events.js'

const SRC = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

/** 抠出 `qzone: { ... }` 那一段（状态路由里的）。 */
function qzoneStatusBlock () {
  const at = SRC.indexOf('qzone: {')
  assert.ok(at > 0, '找不到状态路由里的 qzone 段')
  const end = SRC.indexOf('}', at)
  return SRC.slice(at, end + 1)
}

test('① ★ 状态路由的 qzone 段必须带 watchList（解析成数组）', () => {
  const block = qzoneStatusBlock()
  assert.match(block, /watchList:\s*\[\.\.\.parseWatchList\(/,
    '★ 要按数组返回 —— 人眼一比就知道读没读到')
  assert.match(block, /watchListRaw:/, '同时留一份原始值，好排查"写成数组/串"的差异')
})

test('② ★ 状态路由的 qzone 段必须带 bridge（起没起/重启几次/上次怎么退）', () => {
  const block = qzoneStatusBlock()
  assert.match(block, /bridge:\s*bridge\.status\(\)/,
    '★ 桥的进程状态要透出来 —— 上次查孤儿进程时就是因为这里没有，只能靠进程快照猜')
})

test('③ 行为：四个号写成**数组**（他这次的写法）也能被完整读到', () => {
  const raw = ['880000001', '880000002', '880000003', '880000004']
  const s = parseSettings({ qzoneWatchList: raw }).settings
  assert.equal(typeof s.qzoneWatchList, 'string', 'parseSettings 会归一成逗号串')
  assert.equal(s.qzoneWatchList, '880000001,880000002,880000003,880000004')
  const set = parseWatchList(s.qzoneWatchList)
  assert.equal(set.size, 4, '★ 四个号都要解析出来')
  for (const n of raw) assert.ok(set.has(n), '漏了 ' + n)
})

test('④ 行为：逗号串 / 空格 / 中文逗号 三种写法等价', () => {
  const expect = ['100001', '200002', '300003']
  for (const form of ['100001,200002,300003', '100001 200002 300003', '100001，200002、300003']) {
    const set = parseWatchList(parseSettings({ qzoneWatchList: form }).settings.qzoneWatchList)
    assert.equal(set.size, 3, JSON.stringify(form) + ' 应解析出 3 个')
    for (const n of expect) assert.ok(set.has(n), form + ' 漏了 ' + n)
  }
})

test('⑤ 行为：留空 = 空集（只感知主人，不感知任何"别人"）', () => {
  for (const v of ['', null, undefined, []]) {
    const s = parseSettings({ qzoneWatchList: v }).settings
    assert.equal(parseWatchList(s.qzoneWatchList).size, 0, JSON.stringify(v) + ' 应为空集')
  }
})
