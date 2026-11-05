/**
 * 验收用的**纯逻辑**:分段耗时统计 + 体检判据 + 排版。
 *
 * 为什么单独一个文件:这些东西必须能单测(`test/verdict.test.mjs`),
 * 而"去 HTTP 问状态"那部分是 I/O,放在 `scripts/acceptance.mjs` 里(那文件不进包)。
 * 本文件**不含任何地址 / 端口**(打包纪律门卫扫 lib/ 时也扫它)。
 */

/** 出站送达 P95 的目标(ms)。旧桥轮询时代是 ~1000 均值 / ~2000 最坏;服务注入(零轮询)该是毫秒级。 */
export const OUTBOUND_P95_BUDGET_MS = 100

/**
 * 最近邻百分位(nearest-rank)。空样本 → null(而不是 0 —— "没样本"与"很快"不是一回事)。
 * @param {number[]} samples
 * @param {number} p 0..1
 */
export function pickPercentile (samples, p) {
  const xs = (Array.isArray(samples) ? samples : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b)
  if (xs.length === 0) return null
  const q = Math.min(1, Math.max(0, Number(p)))
  const rank = Math.ceil(q * xs.length)
  const i = Math.min(xs.length - 1, Math.max(0, rank - 1))
  return xs[i]
}

/**
 * 把插件自己记的原始计数整理成表格要用的形状。
 *
 * **两种输入都认**:① 插件的原始记录(带 `samples` 数组,这里现算百分位);
 * ② 插件已经算好的摘要(只有 `p50/p95/max/sampleCount`,原样透传)。
 * 为什么必须两种都认:插件发的就是摘要(它发的是 `summarizeTiming(stats)` 的结果),
 * 头一版只认原始样本 ⇒ 脚本永远显示"样本 0 条",还静默漏掉整条耗时结论
 * (2026-09-28 被 `scripts/acceptance.mjs` 的端到端自检抓出来)。
 * @param {{pushes?:number, rows?:number, sent?:number, failed?:number, dropped?:number,
 *          skippedNoClient?:number, samples?:number[], sampleCount?:number,
 *          p50?:number|null, p95?:number|null, max?:number|null, last?:object|null}} stats
 */
export function summarizeTiming (stats) {
  const s = stats ?? {}
  const hasSamples = Array.isArray(s.samples)
  const samples = hasSamples ? s.samples : []
  const num = (v) => (v === null || v === undefined || v === '' ? null
    : (Number.isFinite(Number(v)) ? Number(v) : null))
  return {
    pushes: Number(s.pushes) || 0,
    rows: Number(s.rows) || 0,
    sent: Number(s.sent) || 0,
    failed: Number(s.failed) || 0,
    dropped: Number(s.dropped) || 0,
    skippedNoClient: Number(s.skippedNoClient) || 0,
    sampleCount: hasSamples ? samples.length : (Number(s.sampleCount) || 0),
    p50: hasSamples ? pickPercentile(samples, 0.5) : num(s.p50),
    p95: hasSamples ? pickPercentile(samples, 0.95) : num(s.p95),
    max: hasSamples ? pickPercentile(samples, 1) : num(s.max),
    last: s.last ?? null
  }
}

const ok = (id, text) => ({ level: 'ok', id, text })
const warn = (id, text) => ({ level: 'warn', id, text })
const fail = (id, text) => ({ level: 'fail', id, text })

/**
 * 体检判据(**纯函数**)。输入是两边的状态 JSON,输出是一条条结论。
 *
 * 分级怎么定的:
 *   `fail` = 这条不通就**根本收不到 / 送不出**,别往下测了;
 *   `warn` = 能用,但有代价(NapCat 没连、心跳 stale、还没样本);
 *   `ok`   = 如实报出数字。
 *
 * @param {{plugin?: object|null, main?: object|null, timing?: object|null}} input
 */
export function preflight (input = {}) {
  const p = input.plugin ?? null
  const main = input.main ?? null
  const out = []

  if (p === null || typeof p !== 'object') {
    return [fail('plugin', '拿不到插件状态(插件没装 / 没启用 / 端口给错了)')]
  }
  out.push(ok('version', '本插件 v' + String(p.version ?? '?')))

  // 总闸:装上 ≠ 开了
  if (p.enabled === true) out.push(ok('enabled', '总闸:开'))
  else out.push(warn('enabled', '总闸:关 —— 装上了 ≠ 开了,打开之后再来跑这一条'))

  // 口令:空 = 拒收一切连接
  if (p.accessTokenSet === true) out.push(ok('token', '连接口令:已配'))
  else out.push(fail('token', '连接口令为空 = **拒收一切连接**(NapCat 那边也要填同一个)'))

  // 白名单:空 = 一律拒收(绝不"空即全通")
  const n = Number(p.allowlistSize) || 0
  if (n > 0) out.push(ok('allowlist', '私聊白名单:' + n + ' 人'))
  else out.push(fail('allowlist', '私聊白名单为空 = **一律拒收**(要填他的 QQ 号)'))

  const problems = Array.isArray(p.configProblems) ? p.configProblems : []
  if (problems.length > 0) out.push(warn('config', '配置有 ' + problems.length + ' 处问题:' + problems.join(' / ')))

  // 走哪条路:唯一的路 = 服务注入。它不通 = 她根本说不了话 ⇒ **挡路**(没有第二条路可退)。
  const mode = p.channel?.mode ?? 'none'
  if (mode === 'service') out.push(ok('mode', '传输:服务注入(零轮询)'))
  else out.push(fail('mode', '传输:none —— 唯一的路(服务注入)不通:没看到主包服务 echo:relay'
    + '(主包没挂 / 版本旧 / 没重载)。旧桥的 HTTP 兜底已于 2026-09-28 退役,没有备胎可回落'))

  if (p.channel?.serviceAvailable === true) out.push(ok('service', '主包服务 echo:relay:在'))
  else out.push(warn('service', '主包服务:没看到(主包版本旧 / 没挂 / 没重载)'))

  // 契约对账(2026-09-28 加,见 docs/PLAN_CORTICO_ADOPTION.md §3A2):
  // **能力名**对不上 = 她说不了话(挡路);**版本**对不上只是"该升谁"(警告,不拒 ——
  // 两个仓独立发布,拒载会把发布顺序锁死)。老主包没有 hello() ⇒ 降级对账 + 警告。
  const ctr = p.channel?.contract ?? null
  if (ctr !== null && typeof ctr === 'object' && ctr.available === true) {
    const apiText = (ctr.api === null || ctr.api === undefined)
      ? '老形状(主包没自报 api)'
      : ('api ' + ctr.api.min + '~' + ctr.api.max)
    if (ctr.ok === true && ctr.legacy === true) out.push(warn('contract', '契约:' + apiText + ' —— 按看到的方法降级对账(建议升级主包)'))
    else if (ctr.ok === true) out.push(ok('contract', '契约:' + apiText + ',能力 ' + (Array.isArray(ctr.have) ? ctr.have.length : 0) + ' 项'))
    else out.push(fail('contract', '契约对不上(' + String(ctr.code ?? '') + '):' + String(ctr.note ?? '')))
    if (ctr.apiIssue === 'too_new' || ctr.apiIssue === 'too_old') {
      out.push(warn('contract-api', '版本区间对不上(' + ctr.apiIssue + '):' + String(ctr.note ?? '')
        + ' —— **不拒**(能力名对得上就照跑:版本差异只当文案,拒载会把两仓发布顺序锁死)'))
    }
    if (Array.isArray(ctr.softMissing) && ctr.softMissing.length > 0) {
      out.push(warn('contract-soft', '少了可选能力:' + ctr.softMissing.join(',') + '(能用,但功能缺一块)'))
    }
  }

  // 主包的**干跑自检**(无副作用;见主包 lib/relay.js 的 selftest)。
  // 它是"链路在、契约形状没坏"的唯一现场证据 —— 没过就是挡路,而且要把失败项摆出来。
  const st = p.channel?.selftest ?? null
  if (st !== null && typeof st === 'object') {
    if (st.ok === true) {
      out.push(ok('selftest', '主包干跑自检:过(' + (Array.isArray(st.checks) ? st.checks.length : 0) + ' 项'
        + (String(st.note ?? '') === '' ? '' : ';' + String(st.note)) + ')'))
    } else {
      const fails = (Array.isArray(st.checks) ? st.checks : []).filter((c) => c?.ok !== true)
      out.push(fail('selftest', '主包干跑自检**没过**:'
        + (fails.length === 0 ? String(st.note ?? '没有明细') : fails.map((c) => String(c?.name ?? '?') + '(' + String(c?.detail ?? '') + ')').join('、'))))
    }
  }

  if (p.mouth?.registered === true) out.push(ok('mouth', '自报家门:已注册(主包知道她有一条嘴)'))
  else if (p.enabled === true) out.push(fail('mouth', '自报家门:没注册 —— 主包会以为她没嘴(工具/门全关)'))
  else out.push(warn('mouth', '自报家门:未注册(总闸关着就不会报 —— 这是对的)'))

  // NapCat 那条连接。**状态真值是 `closed | listening | client-connected`**
  // (lib/onebot.js 的 refreshState)——头一版只认 `open`,于是"已经连上"被报成
  // "没连上就收不到他的消息"(2026-09-28 真机第一次跑验收时才看出来)。
  const state = p.connection?.state ?? p.client?.state ?? null
  const connected = state === 'client-connected' || state === 'open'
  if (connected) out.push(ok('conn', 'NapCat 连接:' + state))
  else if (state === 'listening') out.push(warn('conn', 'NapCat 连接:正在听,但 NapCat 还没连上(它一重连上就好)'))
  else out.push(warn('conn', 'NapCat 连接:' + String(state ?? '未知') + '(没连上就收不到他的消息)'))
  if (p.client?.stale === true) out.push(warn('stale', '心跳:stale(连续 ' + String(p.client?.misses ?? '?') + ' 次没应答)'))
  if (Number(p.client?.rejectedAuth) > 0) out.push(fail('auth', '有 ' + p.client.rejectedAuth + ' 次连接被拒 —— 口令多半不对'))
  if (Number(p.client?.rejected) > 0) out.push(warn('rejected', '有 ' + p.client.rejected + ' 帧被拒(看看是不是群聊/白名单)'))

  // 入站被主包拒 —— **这是"她根本听不到他"**,不是小事。
  // 2026-09-28 真机就是这条:信封少 `isMaster`,主包每条都 403 not-master,
  // 而当时理由只在日志里,面板/验收都看不见 ⇒ 现在把主包给的 reason 直接摆出来。
  const inRejected = Number(p.channel?.counters?.inRejected) || 0
  if (inRejected > 0) {
    out.push(fail('inbound', '有 ' + inRejected + ' 条入站被主包拒了(最后理由:'
      + (String(p.channel?.lastRejectReason ?? '') || '未记') + ')—— 她根本听不到他'))
  } else if (Number(p.channel?.counters?.in) > 0) {
    const retried = Number(p.channel?.counters?.inRetried) || 0
    out.push(ok('inbound', '入站:已进来 ' + p.channel.counters.in + ' 条'
      + (retried > 0 ? '(其中 ' + retried + ' 次是"她正忙"时重试救回来的)' : '')))
  }

  // 主包那边看:桥的门、有没有看到 QQ 渠道
  if (main !== null && typeof main === 'object') {
    out.push(ok('main', '主包 v' + String(main.version ?? '?') + ' 在线'))
    const relayOn = main.relay?.enabled ?? main.relayEnabled ?? null
    if (relayOn === true) out.push(ok('gate', '主包的门:开(旧桥总闸开着 或 已看到她这条嘴)'))
    else if (relayOn === false) out.push(fail('gate', '主包的门:关 —— 入站会被 409 拒掉'))
    else out.push(warn('gate', '主包状态里没报门(版本旧?看 /api/echo/status)'))
  }

  // 分段耗时
  const t = input.timing ?? summarizeTiming(p.timing)
  if (t.pushes === 0) out.push(warn('timing', '还没有出站样本 —— 让他先给你发一条,或者你喊他一声,再跑这条'))
  else if (t.p95 !== null && t.p95 <= OUTBOUND_P95_BUDGET_MS) {
    out.push(ok('timing', '出站送达:样本 ' + t.sampleCount + ' 条,P50 ' + t.p50 + 'ms / P95 ' + t.p95 + 'ms(目标 ≤ ' + OUTBOUND_P95_BUDGET_MS + 'ms)'))
  } else if (t.p95 !== null) {
    out.push(warn('timing', '出站送达:P95 ' + t.p95 + 'ms 超过目标 ' + OUTBOUND_P95_BUDGET_MS + 'ms(样本 ' + t.sampleCount + ' 条)'))
  } else {
    // 有推送、却没有耗时数字:插件版本旧(没记分段耗时)——
    // 这一条**不能静默**:漏掉的话"零轮询到底多快"就没人回答了。
    out.push(warn('timing', '推来 ' + t.pushes + ' 次,但没有耗时数字(插件版本旧?)'))
  }
  if (t.failed > 0) out.push(warn('failed', '有 ' + t.failed + ' 行没送出去(留给主包租约重发)'))
  if (t.dropped > 0) out.push(warn('dropped', '有 ' + t.dropped + ' 次推来的时候没有可用连接(那些话没发)'))
  // 过渡期常见且**正常**的一种:我们还没接上,叫醒来了只能先记一笔。
  // 单列一条是为了别把它误读成故障(话没丢,主包租约过期会重发)。
  if (t.skippedNoClient > 0) {
    out.push(warn('skipped', '有 ' + t.skippedNoClient + ' 次叫醒时我们还没接上(那些话留给主包租约重发)'
      + ' —— NapCat 连上之后这条会停在计数上不再涨'))
  }
  // 最阴的一种坏:**主包喊了"有活儿",却一行都没发出去** —— 取行那一步断了(消费端 lease 缺失、
  // 或压根没连上)。2026-09-28 就是这个缺口:推送只带计数,没有 lease 就静默一个字发不出去。
  if (t.pushes > 0 && t.rows > 0 && t.sent === 0) {
    out.push(fail('sent', '主包喊了 ' + t.pushes + ' 次"有活儿"(' + t.rows + ' 行),但**一行都没送出去**'
      + ' —— 取行那一步断了(服务里没有 lease / 没有可用连接)'))
  }

  return out
}

/** 汇总:能不能收工。 */
export function verdictOf (checks) {
  const list = Array.isArray(checks) ? checks : []
  const fails = list.filter((c) => c.level === 'fail')
  const warns = list.filter((c) => c.level === 'warn')
  return {
    pass: fails.length === 0,
    fails: fails.length,
    warns: warns.length,
    oks: list.filter((c) => c.level === 'ok').length
  }
}

/** 排版(纯字符串,便于单测)。 */
export function renderReport ({ checks, timing, title } = {}) {
  const list = Array.isArray(checks) ? checks : []
  const v = verdictOf(list)
  const mark = { ok: '✔', warn: '!', fail: '✖' }
  const lines = []
  lines.push(title ?? 'dsh-echo-qq 验收体检')
  lines.push('─'.repeat(46))
  for (const c of list) lines.push(mark[c.level] + ' ' + c.text)
  lines.push('─'.repeat(46))
  const t = timing ?? null
  if (t !== null) {
    lines.push('分段耗时(插件自己记的):')
    lines.push('  推来 ' + t.pushes + ' 次 / ' + t.rows + ' 行;送出 ' + t.sent + ' 行,失败 ' + t.failed + ' 行,无连接丢弃 ' + t.dropped + ' 次'
      + (t.skippedNoClient > 0 ? ',叫醒时未接上 ' + t.skippedNoClient + ' 次' : ''))
    lines.push('  送达耗时:样本 ' + t.sampleCount + ' 条,P50 ' + String(t.p50 ?? '-') + 'ms,P95 ' + String(t.p95 ?? '-')
      + 'ms,最慢 ' + String(t.max ?? '-') + 'ms')
    if (t.last !== null && t.last !== undefined) {
      lines.push('  最近一次:推来→送出 ' + String(t.last.pushToSentMs ?? '-') + 'ms,送出→回执 ' + String(t.last.sentToAckMs ?? '-') + 'ms')
    }
  }
  lines.push(v.pass ? ('结论:通过(' + v.oks + ' 项正常' + (v.warns > 0 ? ',' + v.warns + ' 项注意' : '') + ')')
    : ('结论:没通过 —— ' + v.fails + ' 项挡路' + (v.warns > 0 ? ',' + v.warns + ' 项注意' : '')))
  return lines.join('\n')
}
