#!/usr/bin/env node
/**
 * **验收体检** —— 一条命令看清"她这条嘴到底通没通"。
 *
 * 只读:只 GET 状态接口。**不发消息、不写库、不改配置。**
 * 判据与排版都在 `lib/verdict.js`(纯函数,有单测);这里只负责跑 I/O。
 * `runAcceptance()` 是导出的,所以 `test/acceptance.test.mjs` 能拿假 fetch 端到端测它
 * (不 spawn 子进程、不开端口 —— 那种测法在受限沙箱里还会因管道 EPERM 假红)。
 *
 * 用法:
 *   node scripts/acceptance.mjs --port 3080
 *   node scripts/acceptance.mjs --base http://<主机>:<端口>
 *   node scripts/acceptance.mjs                 # 不给也行:自动找他本机在听的端口
 *   node scripts/acceptance.mjs --json          # 只出原始 JSON(给别的脚本用)
 *
 * 为什么地址要从参数/现推来:打包纪律(**源码里不许写死地址**)。这个脚本不进包
 * (`package.json` 的 `files` 里没有 `scripts/`),但它也照同一条纪律写 —— 免得不小心
 * 被谁复制进 lib/。下面那个 `LOOPBACK` 只用于"探测本机",不是"约定的地址"。
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { preflight, renderReport, summarizeTiming, verdictOf } from '../lib/verdict.js'

const LOOPBACK = '127.0.0.1' // 探测本机用;真正的地址由 --base/--port 给,或从本机监听里现找

export function parseArgs (argv) {
  const out = { base: '', port: null, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--base') out.base = String(argv[++i] ?? '')
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a.startsWith('--base=')) out.base = a.slice(7)
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7))
    else if (!a.startsWith('-') && out.base === '') out.base = a
  }
  if (out.base !== '' && !/^[a-z]+:\/\//i.test(out.base)) out.base = 'http://' + out.base
  if (out.base !== '' && out.base.endsWith('/')) out.base = out.base.slice(0, -1)
  return out
}

/** 本机正在监听的端口(问操作系统,不问配置)。拿不到就空数组。 */
function listeningPorts () {
  try {
    const ps = 'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort'
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 8000 })
    return [...new Set(String(out).split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number))]
  } catch { return [] }
}

function getJson (fetchImpl, url, ms = 3000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  const p = (url.startsWith('http') || typeof fetchImpl !== 'function')
    ? fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } })
    : fetchImpl(url)
  return Promise.resolve(p)
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
    .catch((err) => ({ status: 0, body: null, error: String(err?.message ?? err) }))
    .finally(() => clearTimeout(timer))
}

/** 这一份状态 JSON 像不像**我们的**插件(字段是我们自己定的,所以能当身份标记)。 */
export function looksLikeOurPlugin (body) {
  const b = body
  if (b === null || typeof b !== 'object') return false
  return b.serviceName === 'echo:relay'
    && b.mouth !== null && typeof b.mouth === 'object'
    && b.timing !== null && typeof b.timing === 'object'
    && typeof b.enabled === 'boolean'
    && typeof b.accessTokenSet === 'boolean'
}

/** 这一份状态 JSON 像不像**主包**的 /api/echo/status(宿主身份;插件还没挂上时用)。 */
function looksLikeMainStatus (body) {
  const m = body
  if (m === null || typeof m !== 'object') return false
  return m.status === 'active' && typeof m.version === 'string'
    && m.relay !== undefined && m.personaChars !== undefined && m.dbPath !== undefined
}

/**
 * 一个候选地址到底是不是"我们的宿主"。
 *
 * ⚠️ 2026-09-28 真实踩到的坑:**只看"回了 200 + 有个 version 字段"是不够的** ——
 * 本机 `28317` 是一个 `svchost`(Windows 服务)的端口,它也回了个带 `version` 的 JSON,
 * 于是整个体检照着**陌生服务的垃圾输入**编出一份"看起来很合理"的报告
 * ("本插件 v3 / 主包 v3 在线 / 3 项挡路")。体检工具最坏的失败就是**假通过或假失败**,
 * 所以这里的规矩是:**认出身份才干活;认不出来就说"没找到",绝不编报告。**
 */
export async function identifyHost (fetchImpl, base) {
  const mine = await getJson(fetchImpl, base + '/api/echo-qq/status', 1200)
  if (looksLikeOurPlugin(mine.body)) {
    return { base, plugin: mine.body, main: null, evidence: '/api/echo-qq/status 回了 serviceName=echo:relay' }
  }
  const main = await getJson(fetchImpl, base + '/api/echo/status', 1200)
  if (looksLikeMainStatus(main.body)) {
    return { base, plugin: null, main: main.body, evidence: '/api/echo/status 回了主包状态(v' + main.body.version + ')' }
  }
  return null
}

/**
 * 挨个候选试,认出宿主就用它(**靠身份标记,不靠"有没有响应"**)。
 * 返回 `{base, hit, tried}`;认不出来时 `base` 是空串,`tried` 是试过的地址(给人看)。
 * `ports` 可注入 —— 单测不许去问操作系统的端口表。
 *
 * 2026-09-28:旧桥的 HTTP 兜底退役后,配置里不再有"主包地址"这个键(它只服务那条路),
 * 所以这里不再读配置 —— 候选地址一律来自"本机在听哪些端口",靠身份标记认。
 */
export async function discoverBase ({ fetchImpl = globalThis.fetch, ports = null } = {}) {
  const list = ports ?? listeningPorts()
  // 固定顺序:端口号从小到大。之前这里按操作系统的返回顺序挑第一个"看着像"的,
  // 结果挑中了陌生服务 —— 顺序不定 + 判据太松 = 报告不可信。
  const candidates = [...new Set(list)].sort((a, b) => a - b).map((p) => 'http://' + LOOPBACK + ':' + p)
  if (candidates.length === 0) return { base: '', hit: null, tried: [] }
  const hits = (await Promise.all(candidates.map((b) => identifyHost(fetchImpl, b)))).filter((h) => h !== null)
  // 优先"认得我们插件"的那个(它才答得了后面那些问题)
  const pick = hits.find((h) => h.plugin !== null) ?? hits[0] ?? null
  const tried = candidates.filter((b) => !hits.some((h) => h.base === b))
  return { base: pick === null ? '' : pick.base, hit: pick, tried }
}

/**
 * 跑一轮体检(**导出**给测试用;不 spawn、不开端口)。
 * @returns {Promise<{ok:boolean, exitCode:number, text:string, checks:object[], timing:object, payload:object}>}
 */
export async function runAcceptance ({ base, fetchImpl = globalThis.fetch, log = () => { }, title } = {}) {
  const lines = []
  const say = (s) => { lines.push(s); log(s) }
  say('宿主:' + base)

  const plugin = await getJson(fetchImpl, base + '/api/echo-qq/status')
  const main = await getJson(fetchImpl, base + '/api/echo/status')
  const payload = {
    base,
    pluginHttpStatus: plugin.status,
    plugin: plugin.body,
    mainHttpStatus: main.status,
    main: main.body
  }

  if (plugin.status !== 200) {
    // 实测(2026-09-28):宿主对**未知/未挂载**的 /api/ 路由回 401 而不是 404,
    // 所以 401 多半是"这条路由压根不在",不是"口令不对"。
    say('✖ 拿不到 `/api/echo-qq/status`(HTTP ' + plugin.status + ')')
    if (main.status === 200) say('  → 端口是对的(主包状态拿到了 HTTP 200),所以是插件这条路由不在:')
    else say('  → 连主包状态也没拿到(HTTP ' + main.status + '):端口是不是给错了?')
    say('  → 插件没装 / 装了没启用 / 装在别处 / 宿主还没重载(装完要重启一次 dsh web)。')
    return { ok: false, exitCode: 1, text: lines.join('\n'), checks: [], timing: null, payload }
  }
  // 第二道闸(2026-09-28):200 也可能是**别的东西**回的。这一份不像我们的插件就拒绝出报告 ——
  // 体检宁可说"没找到",也不许照陌生服务的输入编一份看着合理的结论。
  if (!looksLikeOurPlugin(plugin.body)) {
    say('✖ 这个地址回的 `/api/echo-qq/status` **不像我们的插件**(可能根本不是 DSH 宿主)')
    say('  → 不敢照它出报告。用 `--port <他的端口>` 指定宿主端口再来。')
    return { ok: false, exitCode: 2, text: lines.join('\n'), checks: [], timing: null, payload }
  }

  const checks = preflight({ plugin: plugin.body, main: main.status === 200 ? main.body : null })
  const timing = summarizeTiming(plugin.body?.timing)
  say(renderReport({ checks, timing, title }))
  const v = verdictOf(checks)
  if (!v.pass) {
    say('要修的先看这几条:')
    for (const f of checks.filter((c) => c.level === 'fail')) say('  - ' + f.text)
  }
  return { ok: v.pass, exitCode: v.pass ? 0 : 1, text: lines.join('\n'), checks, timing, payload }
}

async function main (argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('用法: node scripts/acceptance.mjs [--port <端口> | --base <URL>] [--json]')
    return 0
  }
  let base = args.base
  if (base === '' && Number.isFinite(args.port) && args.port > 0) base = 'http://' + LOOPBACK + ':' + args.port
  if (base === '') {
    console.log('没给 --port/--base,先找他本机在听的端口……')
    const found = await discoverBase()
    if (found.base === '') {
      console.log('✖ 没找到 DSH 宿主(试过 ' + found.tried.length + ' 个端口,没有一个认得出身份)。')
      console.log('  体检**故意**不猜:认不出宿主就出的报告只会误导你。')
      console.log('  用 `node scripts/acceptance.mjs --port <他的端口>` 指定宿主端口再来。')
      return 2
    }
    base = found.base
    console.log('  ' + found.hit.evidence)
  } else {
    // 他给了地址也要认一眼身份:认不出来就明说"这份报告没意义",而不是硬出。
    const hit = await identifyHost(globalThis.fetch, base)
    if (hit === null) {
      console.log('✖ ' + base + ' 回的既不像我们的插件、也不像主包状态 —— 它多半不是 DSH 宿主。')
      console.log('  换个端口(宿主端口见 `dsh web` 的启动输出),或者先确认 dsh web 在跑。')
      return 2
    }
    console.log('  ' + hit.evidence)
  }
  const r = await runAcceptance({ base, log: (s) => console.log(s) })
  if (args.json) console.log(JSON.stringify(r.payload, null, 2))
  return r.exitCode
}

// 只在**被当作命令跑**的时候执行:被 import 进测试时不跑(否则测试会连带发请求、设退出码)
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) process.exitCode = await main()
