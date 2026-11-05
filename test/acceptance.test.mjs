/**
 * 验收脚本的**端到端**测试(不 spawn 子进程、不开端口 —— 用假 fetch 打真逻辑)。
 *
 * 为什么留着这一层:`lib/verdict.js` 的单测管"判据对不对",这里管**接起来对不对** ——
 * 2026-09-28 那两个真 bug 都是"零件都对、接起来错"那一类:
 *   ① 插件发的是**已算好的摘要**,脚本只认原始样本 ⇒ 永远"样本 0 条"、耗时结论被静默漏掉;
 *   ② `Number(null) === 0` 把"没样本"编成 `0ms`。
 * 所以这三条用例故意让"假宿主"回**真的形状**(与 `/api/echo-qq/status` 一致)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverBase, looksLikeOurPlugin, parseArgs, runAcceptance } from '../scripts/acceptance.mjs'

const PLUGIN_GOOD = {
  ok: true,
  version: '0.1.0',
  name: 'dsh-echo-qq',
  serviceName: 'echo:relay',
  enabled: true,
  accessTokenSet: true,
  allowlistSize: 1,
  configProblems: [],
  connection: { state: 'open', clients: 1 },
  client: { state: 'open', sent: 4, received: 3, rejectedAuth: 0, rejected: 0, stale: false },
  channel: { mode: 'service', transport: 'auto', serviceAvailable: true },
  mouth: { registered: true, serviceAvailable: true },
  // 注意:这里给的是**摘要**(插件发出来的就是这个,没有 samples 数组)
  timing: { pushes: 3, rows: 4, sent: 4, failed: 0, dropped: 0, sampleCount: 4, p50: 31, p95: 78, max: 78, last: { pushToSentMs: 31, sentToAckMs: 2 } }
}
const MAIN_GOOD = { ok: true, version: '0.30.1', enabled: true, relay: { enabled: true } }

/** 假 fetch:按 URL 回夹具;没命中就回 401(与真宿主对未知 /api/ 路由的行为一致)。 */
function fakeHost ({ plugin = PLUGIN_GOOD, main = MAIN_GOOD, pluginStatus = 200 } = {}) {
  const seen = []
  const impl = async (url) => {
    seen.push(String(url))
    if (String(url).endsWith('/api/echo/status')) return res(main === null ? 401 : 200, main ?? { ok: false, reason: 'unauthorized' })
    if (String(url).endsWith('/api/echo-qq/status')) return res(pluginStatus, plugin ?? { ok: false, reason: 'unauthorized' })
    return res(401, { ok: false, reason: 'unauthorized' })
  }
  const res = (status, body) => ({ status, json: async () => body })
  return { impl, seen }
}

const BASE = 'http://host.test'

/** 主包 `/api/echo/status` 的**真形状**(身份标记要看的那几个字段)。 */
const MAIN_REAL = { status: 'active', version: '0.30.1', enabled: true, dbPath: 'x', relay: { enabled: true }, personaChars: { prefix: 1, suffix: 1 } }
const res = (status, body) => ({ status, json: async () => body })

test('身份:像不像我们的插件(靠 serviceName + 那几个我们自己定的字段)', () => {
  assert.equal(looksLikeOurPlugin(PLUGIN_GOOD), true)
  // 2026-09-28 的教训:陌生服务也能回 200 + 一个 version 字段 —— 单凭"有响应/有 version"就会认错
  assert.equal(looksLikeOurPlugin({ version: '3' }), false)
  assert.equal(looksLikeOurPlugin({ status: 'active', version: '1.0', relay: {}, personaChars: {}, dbPath: 'x' }), false, '主包那份不算我们的')
  assert.equal(looksLikeOurPlugin(null), false)
  assert.equal(looksLikeOurPlugin({}), false)
})

test('寻址:陌生服务(28317)在前也不许认错;真宿主(3080)在后要认出来', async () => {
  const impl = async (url) => {
    const u = String(url)
    if (u.startsWith('http://127.0.0.1:28317')) {
      // svchost 那种:回了个带 version 的 JSON —— 头一版就是被它骗了
      return u.endsWith('/api/echo/status') ? res(200, { version: '3' }) : res(404, null)
    }
    if (u.startsWith('http://127.0.0.1:3080')) {
      return u.endsWith('/api/echo/status')
        ? res(200, MAIN_REAL) // 主包状态(此时插件还没挂上 ⇒ 我们那条路由 401)
        : res(401, { ok: false, reason: 'unauthorized' })
    }
    throw new Error('connect ECONNREFUSED')
  }
  const found = await discoverBase({ fetchImpl: impl, ports: [28317, 3080, 9] })
  assert.equal(found.base, 'http://127.0.0.1:3080', '要认出真宿主')
  assert.ok(found.hit.evidence.includes('/api/echo/status'), found.hit.evidence)
  assert.deepEqual([...found.tried].sort(),
    ['http://127.0.0.1:28317', 'http://127.0.0.1:9'].sort(), '认不出的要列出来(候选按端口号排)')
})

test('寻址:全是陌生服务 ⇒ 返回空 + 试过的清单(**绝不出报告**)', async () => {
  const impl = async () => res(200, { version: '3' })
  const found = await discoverBase({ fetchImpl: impl, ports: [28317, 445, 135] })
  assert.equal(found.base, '')
  assert.equal(found.tried.length, 3)
  assert.equal(found.hit, null)
})

test('寻址:优先"认得我们插件"的那个宿主(两个都在时)', async () => {
  const impl = async (url) => {
    const u = String(url)
    const port = Number(u.match(/:(\d+)\//)?.[1] ?? 0)
    if (u.endsWith('/api/echo-qq/status')) return port === 3081 ? res(200, PLUGIN_GOOD) : res(401, null)
    return res(200, MAIN_REAL)
  }
  const found = await discoverBase({ fetchImpl: impl, ports: [3080, 3081] })
  assert.equal(found.base, 'http://127.0.0.1:3081', '有插件状态的那个更该选它(后面那些问题它才答得了)')
})

test('寻址不再读配置里的"主包地址"(那个键已随旧桥退役)', async () => {
  // 旧版这里会先看 config.json 的 mainBaseUrl;它退役后,候选地址只能来自"本机在听的端口"。
  const home = mkdtempSync(join(tmpdir(), 'echo-qq-accept-'))
  mkdirSync(join(home, 'echo-qq'), { recursive: true })
  writeFileSync(join(home, 'echo-qq', 'config.json'),
    JSON.stringify({ mainBaseUrl: 'http://127.0.0.1:59999', mainToken: 'retired' }), 'utf8')
  const impl = async (url) => {
    const u = String(url)
    if (u.startsWith('http://127.0.0.1:3080')) {
      return u.endsWith('/api/echo/status') ? res(200, MAIN_REAL) : res(401, { ok: false, reason: 'unauthorized' })
    }
    throw new Error('connect ECONNREFUSED')
  }
  const found = await discoverBase({ fetchImpl: impl, env: { DSH_HOME: home }, ports: [3080] })
  assert.equal(found.base, 'http://127.0.0.1:3080', '该认端口表里的真宿主')
  assert.equal(found.tried.some((b) => b.includes('59999')), false, '配置里那个退役的地址不该被拿去试')
})

test('宿主身份不对 ⇒ 拒绝出报告(退出码 2),不许照陌生输入编结论', async () => {
  const impl = async (url) => String(url).endsWith('/api/echo-qq/status')
    ? res(200, { version: '3', ok: true })
    : res(200, { version: '3' })
  const r = await runAcceptance({ base: BASE, fetchImpl: impl })
  assert.equal(r.exitCode, 2)
  assert.equal(r.checks.length, 0, '一条结论都不许出')
  assert.ok(r.text.includes('不像我们的插件'), r.text)
})

test('验收:全好 ⇒ 通过(退出码 0),耗时用**摘要里的**数字而不是"样本 0 条"', async () => {
  const { impl } = fakeHost()
  const r = await runAcceptance({ base: BASE, fetchImpl: impl })
  assert.equal(r.exitCode, 0)
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('结论:通过'), r.text)
  assert.ok(r.text.includes('样本 4 条,P50 31ms,P95 78ms'), r.text)
  assert.ok(!r.text.includes('样本 0 条'), '不许把插件算好的摘要丢掉')
  assert.ok(r.text.includes('推来→送出 31ms'), r.text)
  assert.ok(r.text.includes('传输:服务注入'), r.text)
})

test('验收:挡路的三条都报出来(退出码 1)且给出"先修这几条"', async () => {
  const bad = {
    ...PLUGIN_GOOD,
    accessTokenSet: false,
    allowlistSize: 0,
    channel: { mode: 'none', serviceAvailable: false },
    mouth: { registered: false },
    timing: { pushes: 0, sampleCount: 0, p50: null, p95: null, max: null, last: null }
  }
  const { impl } = fakeHost({ plugin: bad })
  const r = await runAcceptance({ base: BASE, fetchImpl: impl })
  assert.equal(r.exitCode, 1)
  assert.equal(r.ok, false)
  assert.ok(r.text.includes('结论:没通过'), r.text)
  assert.ok(r.text.includes('要修的先看这几条:'), r.text)
  assert.ok(r.text.includes('连接口令为空'), r.text)
  assert.ok(r.text.includes('私聊白名单为空'), r.text)
  assert.ok(r.text.includes('传送:none') === false && r.text.includes('传输:none'), r.text)
  // "没样本"如实写 -,绝不许变成 0ms
  assert.ok(r.text.includes('样本 0 条,P50 -ms'), r.text)
  assert.ok(!r.text.includes('0ms'), r.text)
})

test('验收:插件这条路由不在(HTTP 401)⇒ 分清"端口错"还是"路由不在"', async () => {
  const { impl } = fakeHost({ plugin: null, pluginStatus: 401 })
  const r = await runAcceptance({ base: BASE, fetchImpl: impl })
  assert.equal(r.exitCode, 1)
  assert.ok(r.text.includes('HTTP 401'), r.text)
  assert.ok(r.text.includes('端口是对的'), r.text)
  assert.ok(r.text.includes('插件没装 / 装了没启用'), r.text)
  assert.equal(r.checks.length, 0, '拿不到状态就别硬编结论')
})

test('验收:连主包状态也拿不到 ⇒ 提示端口可能给错', async () => {
  const { impl } = fakeHost({ plugin: null, pluginStatus: 401, main: null })
  const r = await runAcceptance({ base: BASE, fetchImpl: impl })
  assert.equal(r.exitCode, 1)
  assert.ok(r.text.includes('端口是不是给错了'), r.text)
})

test('参数解析:--port / --base / 裸地址 / 补全协议 / 去尾斜杠', () => {
  assert.deepEqual(parseArgs(['--port', '3080']).port, 3080)
  assert.equal(parseArgs(['--base', '127.0.0.1:3080']).base, 'http://127.0.0.1:3080', '裸地址补协议')
  assert.equal(parseArgs(['--base', 'http://x:1/']).base, 'http://x:1', '去尾斜杠')
  assert.equal(parseArgs(['--port=3080']).port, 3080)
  assert.equal(parseArgs(['--json', 'http://x']).base, 'http://x')
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs([]).base, '')
})
