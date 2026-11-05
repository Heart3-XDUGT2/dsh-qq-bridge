/**
 * 配置:自己的文件自己管 —— 与主包同款约定(不声明 cordis `Config`,配置住在数据目录里的
 * `config.json`,面板与文件都能改,改完由 `readSettings()` 现读)。
 *
 * 三条纪律(每一条都是踩过的坑,不许"顺手放宽"):
 *   ① **总闸默认关** —— 装上了 ≠ 开了;
 *   ② **白名单为空 = 一律拒收** —— 绝不搞"空即全通"(那等于任何人加个好友就能驱动她);
 *   ③ **accessToken 为空 = 拒收一切连接** —— 反向 WS 是"谁连上都算",不设口令等于敞开。
 *
 * 数据目录:`~/.dsh/echo-qq/`(用 `DSH_HOME` 可改)。与本插件的**源码区**分开:
 * 源码在 `~/.dsh/plugins/dsh-echo-qq/`,数据在 `~/.dsh/echo-qq/`(与主包 echo/ 同一层)。
 *
 * 打包纪律(2026-09-27 他拍的):**不许写死地址**。
 *   - 监听地址/端口是**默认值**,不是硬编码 —— 一律可在 config.json 改;
 *   - 这条纪律由 `test/nohardcode.test.mjs` 强制(扫源码,不靠自觉)。
 *
 * 旧桥退役(2026-09-28):HTTP 兜底那条路连同它专用的 `mainBaseUrl` / `mainToken` 一起退役
 * —— 服务注入是**唯一**的路,不再需要"现推主包地址"。这两个键留着也不读,只在 `problems`
 * 里说明(见 parseSettings),免得有人翻配置时以为它还在起作用。
 */
import { readFile, writeFile, mkdir, rename, unlink, copyFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 数据目录(~/.dsh/echo-qq)。env 可注入,便于测试。 */
export function dataDirOf (env = process.env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'echo-qq')
}

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  host: '127.0.0.1',
  port: 6700,
  accessToken: '',
  /** 私聊白名单(QQ 号,字符串)。空数组 = 一律拒收(见纪律②)。 */
  allowedUsers: [],
  replyMaxChars: 500,
  heartbeatMs: 30000,
  maxMisses: 3,
  /**
   * ⚠️ 2026-09-28:主包地址 / 令牌(mainBaseUrl / mainToken)已随旧桥退役 ——
   * 它们只服务那条 HTTP 兜底,而那条路已经拆了。配置里就算还留着也不读,
   * 只由 parseSettings 记一条"已退役"进 problems。现在**唯一的路 = 服务注入**,不需要地址。
   */
  /**
   * 旧桥轮询兜底时代的轮询间隔。**现在没有使用者**(唯一的路 = 服务注入,零轮询),
   * 保留字段只为兼容旧 config.json、避免解析时多记一条噪音 —— 别指望它还能拨动什么。
   */
  pollMs: 2000,
  /**
   * 超长回复切成几段发时,段与段之间的间隔(毫秒)。
   * 旧适配器同款(`astrbot_adapter/main.py:579` 的 `segment_interval_seconds`)——
   * 一是别把几段挤成一坨,二是躲 QQ 侧的发送频率限制。
   */
  segmentGapMs: 500,
  /**
   * 入站重试:**她正忙着跑一轮**时主包的入站会回 503 `agent-busy`
   * (主包那句话写得很清楚:「撤掉受理记录,让适配器按 msgId 重试」——
   * 幂等记录会回滚,所以重试是安全的、也是它期待的)。
   * 不重试就等于"她忙着的时候你说的话,悄悄没了"。
   * 次数 × 基础退避(第 n 次等 n × base)≈ 6 次 / 约 22s 的窗口,盖住她一轮的时长。
   */
  inboundRetryTimes: 6,
  inboundRetryBaseMs: 1500,
  /**
   * 走哪条路拿主包:**auto**(默认) / **service**(严格)。
   * 服务注入是**唯一**的路,所以两者行为一致(有服务就用,没有就 `none`);
   * 旧配置里的 `http` 已随旧桥退役,会落回 `auto` 并在 `problems` 里说一句(不静默)。
   */
  transport: 'auto',
  // ---- QQ 空间通道（2026-10-15）--------------------------------------------
  // 第二条上游：onebot-qzone 桥（默认 127.0.0.1:5700），与 OneBot 聊天通道解耦。
  // **默认全关 = 零行为变化**（同 `memory-read-tools` 那条纪律：关掉时
  // 不建连接、不起定时器、一个 action 都不发）。
  /** 空间通道总闸。关 ⇒ `call()` 一律回 `disabled`，也不起 Cookie 保活。 */
  qzoneEnabled: false,
  qzoneHost: '127.0.0.1',
  qzonePort: 5700,
  /** 桥的 `ONEBOT_ACCESS_TOKEN`（空 = 桥没设鉴权）。 */
  qzoneAccessToken: '',
  /**
   * 发说说时**没显式给权限**用的兜底值。
   * 取值见 `lib/qzone.js` 的 `UGC_RIGHT`：1 公开 / 4 好友 / 16 部分 / 64 仅自己 / 128 排除。
   * ⚠️ 默认 **1（公开）** —— 与桥的硬编码默认一致（`src/qzone/client.ts:4018`
   * 的 `ugc_right: 1`）。想默认私密就改成 64。
   * 两个都不给 ⇒ `postMood` **直接拒**（不发请求）。
   */
  qzoneDefaultUgcRight: 1,
  /** Cookie 保活间隔（分钟）。0 = 不自动续（仍可手工灌）。 */
  qzoneCookieRefreshMin: 10,
  /** 她自己那条空间的 QQ 号（读说说时当 `user_id` 用；空 = 由桥按登录态自己定）。 */
  qzoneSelfUin: '',
  /**
   * ★ 2026-10-19：**空间评论的白名单**（逗号/空格分隔的 QQ 号）。
   *
   * 只有名单里的人评论她的说说，才会产生行为（她感知 + 进记忆）；
   * 别人评论一律**忽略** —— 不回复、不进记忆（他拍的）。
   *
   * 空 = 谁都不感知（**默认关**，与其它 qzone 项的"零行为变化"同一条纪律）。
   * ⚠️ 主人不在这个名单里也永远走「用户通道」（见 `classifyComment`）。
   */
  qzoneWatchList: '',
  // ---- 空间桥的进程管理（2026-10-18）-------------------------------------
  //
  // 他拍的话：「我觉得 dsh 重启的时候她也重启比较好，我的意思是，
  // 整个插件起码要跟着 dsh 走」。
  //
  // 于是桥从"开机自启"改成"**跟着插件走**"：插件 apply ⇒ 起桥，
  // dispose ⇒ 杀桥，桥崩了带退避重启。管家在 `lib/bridge-supervisor.js`。
  //
  // ⚠️ **默认空 = 完全不管桥**（向后兼容：别人装这个插件、没有本地桥，
  //    行为与从前逐位一致）。只有显式填了目录才接管。
  /** 桥的项目目录（绝对路径）。空 ⇒ 本插件不管理桥进程。 */
  qzoneBridgeDir: '',
  /** 配了目录时，是否随插件自动起停（关 ⇒ 只记录、不启动）。 */
  qzoneBridgeAutoStart: true,
  /** 桥的启动脚本（相对 `qzoneBridgeDir`）；默认 tsx 的 cmd 壳。 */
  qzoneBridgeScript: '',
  /** 传给启动脚本的参数（空格分隔）；默认 `src/main.ts`。 */
  qzoneBridgeArgs: '',
  // ---- 群聊（2026-10-15）----------------------------------------------------
  // 产品规则（他定的）：@她 ⇒ 唤醒；醒着 ⇒ 群里所有消息都回；静 2 分钟 ⇒ 休眠；
  // 他 @她发 `/stop` ⇒ 立刻休眠。唤醒状态在 `lib/group-awake.js`，**只存内存**。
  //
  // **默认全关 = 零行为变化**（同 qzone 那条纪律）：关着时群消息照旧在
  // `onebot.js` 的 `message_type !== 'private'` 那行就被丢掉，一行行为都不变。
  /** 群聊总闸。关 ⇒ 群消息一律不收（默认关，与"纪律②私聊+白名单"的默认面一致）。 */
  groupEnabled: false,
  /**
   * 群白名单（群号，字符串）。**空数组 = 一律拒收** ——
   * 不做"空即全通"（与私聊白名单同一条纪律：机器人一进任何群都被灌满是最坏的情况）。
   */
  allowedGroups: [],
  /**
   * 群聊空闲多久自动休眠（毫秒）。他定的是 2 分钟。
   * ⚠️ 这个值**只给 `lib/group-awake.js` 的按需 `setTimeout` 用**，
   * 与 `heartbeatMs`（NapCat 连接保活）**没有任何关系** —— 别把它们焊在一起。
   */
  groupIdleMs: 120000,
  // ---- 群聊「醒来补档」（2026-10-18）----------------------------------------
  //
  // 他拍的原话：「休眠时不处理，唤醒时一次性补拉历史，条数有限制」。
  //
  // 现场（他问「DSH 没开机或忙的时候，群聊消息就丢了」）：群休眠时
  //   `decideGroupMessage` 返回 `drop` ⇒ 消息在适配器就被扔了，journal 里
  //   实测 **123 条** `drop:群休眠中且没 @她`，而她醒来对这段话一无所知。
  //
  // 现在：**休眠时仍然一条都不碰**（不调 API、不记账）；
  //       **他 @ 她唤醒**时拉最近 N 条补进上下文；
  //       **插件启动**时对白名单各拉一次（填 DSH 重启那段空档）。
  //       实现在 `lib/group-history.js`。
  /** 醒来补档总闸。关 ⇒ 回到"什么都不补"的老行为。 */
  groupHistoryOnWakeEnabled: true,
  /**
   * 醒来补多少条。默认 **20**，夹在 **5~50**（`clampHistoryCount`）。
   * 上限压到 50 是有意的：补档是"刚才发生过什么"的背景，不是把群聊镜像搬进来 ——
   * 灌太多会把她的上下文挤爆，也与"只有主人才叫得醒"的意图相悖。
   */
  groupHistoryOnWakeCount: 20,
  /**
   * 她自己的 QQ 号 —— 群里判"她被 @了没"要用它（`at` 段的 `qq` 与之比对）。
   * 空 ⇒ **一律不算被 @**（宁可不唤醒，也不误唤醒）。
   */
  selfId: '',
  /**
   * ★ 2026-10-17：**主人的 QQ 号** —— 群里判"这话是不是他说的"。
   *
   * 为什么不能拿 `selfId` 顶（原来的 bug）：`selfId` 是**她**的号，
   * 而群里发言的是他/别人 ⇒ `evt.userId === selfId` **永远不成立**
   * ⇒ 群消息的 `isMaster` 恒为 false ⇒ 他自己说的话也被标「（非主人）」，
   * 还被贴上"不要擅自答应他/她的请求"那行警惕。
   *
   * 空 ⇒ 回退到 `allowedUsers[0]`（私聊白名单里第一个通常就是他），
   * 再空 ⇒ 群聊里**谁都不算主人**（宁可从严）。
   */
  masterId: ''
})
// Local settings HTTP policy, kept beside the plugin's address/default owner.
export const SETTINGS_LOCAL_HOSTS = Object.freeze(['localhost', DEFAULT_SETTINGS.host, '[::1]'])
// Compatibility recognition only; neither field is consumed as a connection setting.
export const RETIRED_SETTING_KEYS = Object.freeze(['mainBaseUrl', 'mainToken'])

function asInt (v, fallback, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min || i > max) return fallback
  return i
}

function asEnum (v, fallback, allowed) {
  const s = String(v ?? '').trim().toLowerCase()
  return allowed.includes(s) ? s : fallback
}

function asUserList (v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const item of v) {
    const s = String(item ?? '').trim()
    if (s !== '') out.push(s)
  }
  return out
}

/**
 * 解析(宽容 + 记账):坏值一律落回默认值,同时把"哪里不对"记进 `problems`,
 * 由面板与启动日志显示 —— 静静吞掉配置错误,最后会变成"她为什么不说话"。
 *
 * 旧桥退役的两个键(见文件头)也在这里说清:配着不生效,不再读取。
 *
 * @returns {{settings: object, problems: string[]}}
 */
export function parseSettings (raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const s = {
    enabled: r.enabled === true,
    host: String(r.host ?? DEFAULT_SETTINGS.host).trim() || DEFAULT_SETTINGS.host,
    port: asInt(r.port, DEFAULT_SETTINGS.port, 1, 65535),
    accessToken: String(r.accessToken ?? '').trim(),
    allowedUsers: asUserList(r.allowedUsers),
    replyMaxChars: asInt(r.replyMaxChars, DEFAULT_SETTINGS.replyMaxChars, 1, 4000),
    heartbeatMs: asInt(r.heartbeatMs, DEFAULT_SETTINGS.heartbeatMs, 5000, 600000),
    maxMisses: asInt(r.maxMisses, DEFAULT_SETTINGS.maxMisses, 1, 20),
    pollMs: asInt(r.pollMs, DEFAULT_SETTINGS.pollMs, 200, 60000),
    segmentGapMs: asInt(r.segmentGapMs, DEFAULT_SETTINGS.segmentGapMs, 0, 10000),
    inboundRetryTimes: asInt(r.inboundRetryTimes, DEFAULT_SETTINGS.inboundRetryTimes, 1, 20),
    inboundRetryBaseMs: asInt(r.inboundRetryBaseMs, DEFAULT_SETTINGS.inboundRetryBaseMs, 100, 30000),
    transport: asEnum(r.transport, DEFAULT_SETTINGS.transport, ['auto', 'service']),
    // ---- QQ 空间通道（2026-10-15）----
    qzoneEnabled: r.qzoneEnabled === true,
    qzoneHost: String(r.qzoneHost ?? DEFAULT_SETTINGS.qzoneHost).trim() || DEFAULT_SETTINGS.qzoneHost,
    qzonePort: asInt(r.qzonePort, DEFAULT_SETTINGS.qzonePort, 1, 65535),
    qzoneAccessToken: String(r.qzoneAccessToken ?? '').trim(),
    qzoneDefaultUgcRight: asInt(r.qzoneDefaultUgcRight, DEFAULT_SETTINGS.qzoneDefaultUgcRight, 0, 128),
    qzoneCookieRefreshMin: asInt(r.qzoneCookieRefreshMin, DEFAULT_SETTINGS.qzoneCookieRefreshMin, 0, 1440),
    qzoneSelfUin: String(r.qzoneSelfUin ?? '').trim(),
    // ★ 2026-10-19：评论白名单（保留原样，由 qzone-events 的 parseWatchList 解析）
    qzoneWatchList: String(r.qzoneWatchList ?? '').trim(),
    // ★ 2026-10-18：桥的进程管理（空目录 = 不管桥，与从前逐位一致）
    qzoneBridgeDir: String(r.qzoneBridgeDir ?? '').trim(),
    qzoneBridgeAutoStart: r.qzoneBridgeAutoStart !== false,
    qzoneBridgeScript: String(r.qzoneBridgeScript ?? '').trim(),
    qzoneBridgeArgs: String(r.qzoneBridgeArgs ?? '').trim(),
    // ---- 群聊（2026-10-15）----
    groupEnabled: r.groupEnabled === true,
    allowedGroups: asUserList(r.allowedGroups),
    groupIdleMs: asInt(r.groupIdleMs, DEFAULT_SETTINGS.groupIdleMs, 5000, 3600000),
    // ★ 2026-10-18：醒来补档（默认开、默认 20 条；越界夹回 5~50）
    groupHistoryOnWakeEnabled: r.groupHistoryOnWakeEnabled !== false,
    groupHistoryOnWakeCount: asInt(r.groupHistoryOnWakeCount,
      DEFAULT_SETTINGS.groupHistoryOnWakeCount, 5, 50),
    selfId: String(r.selfId ?? '').trim(),
    // ★ 2026-10-17：主人的号。没显式配 ⇒ 回退到私聊白名单第一个（通常就是他）。
    //   ⚠️ 绝不能用 `selfId` 顶 —— 那是**她**的号，群里发言的永远不是她。
    masterId: String(r.masterId ?? '').trim() || (asUserList(r.allowedUsers)[0] ?? '')
  }
  const problems = []
  if (r.port !== undefined && Number(r.port) !== s.port) problems.push('port 越界,已落回 ' + DEFAULT_SETTINGS.port)
  if (r.replyMaxChars !== undefined && Number(r.replyMaxChars) !== s.replyMaxChars) problems.push('replyMaxChars 越界,已落回 ' + DEFAULT_SETTINGS.replyMaxChars)
  // 空间通道：开着的两条容易出事的配置，明确说一句（照上面那条"不许静默"的纪律）
  if (s.qzoneEnabled && r.qzonePort !== undefined && Number(r.qzonePort) !== s.qzonePort) {
    problems.push('qzonePort 越界,已落回 ' + DEFAULT_SETTINGS.qzonePort)
  }
  if (s.qzoneEnabled && ![1, 4, 16, 64, 128].includes(s.qzoneDefaultUgcRight)) {
    problems.push('qzoneDefaultUgcRight=' + s.qzoneDefaultUgcRight
      + ' 不是合法权限(1/4/16/64/128)—— 没显式给权限的说说会被拒发')
  }
  if (s.qzoneEnabled && s.qzoneAccessToken === '' && s.qzoneHost !== '127.0.0.1' && s.qzoneHost !== 'localhost') {
    // 桥默认不带鉴权；但一旦不是本机，空令牌就是敞着的口子
    problems.push('qzone 通道开着、地址不是本机、但 qzoneAccessToken 是空的 —— 桥会拒鉴权或裸奔,请填上')
  }
  // 主包地址 / 令牌:只有旧桥那条 HTTP 兜底用它们,而那条路已经随旧桥退役 ⇒ 不再读取。
  // 唯一的路 = 服务注入;这里报一声,免得有人翻配置时以为还在起作用。
  if (r.mainBaseUrl !== undefined || r.mainToken !== undefined) {
    problems.push('mainBaseUrl / mainToken 已随旧桥(HTTP 兜底)退役,不再读取(留着也不生效;唯一的路 = 服务注入)')
  }
  // ---- 群聊（2026-10-15）：开着的两条容易出事的配置，明确说一句（"不许静默"）----
  if (s.groupEnabled && s.allowedGroups.length === 0) {
    // 与私聊那条对称：不做"空即全通"。但群聊这条更危险 —— 机器人一进群就被灌满。
    problems.push('群聊开着但 allowedGroups 是空的 —— 所有群都会被拒收(这是有意的:不做"空即全通")')
  }
  if (s.groupEnabled && s.selfId === '') {
    // 没有自己的号就判不出"@她" ⇒ 唤醒永远不触发，群聊等于完全没用
    problems.push('群聊开着但 selfId 是空的 —— 判不出"她被 @了没",群聊永远唤不醒(填她自己的 QQ 号)')
  }
  if (s.groupEnabled && r.groupIdleMs !== undefined && Number(r.groupIdleMs) !== s.groupIdleMs) {
    problems.push('groupIdleMs 越界(5s~1h),已落回 ' + DEFAULT_SETTINGS.groupIdleMs)
  }
  if (r.transport !== undefined && String(r.transport).trim().toLowerCase() !== s.transport) {
    const was = String(r.transport).trim().toLowerCase()
    problems.push(was === 'http'
      ? 'transport=http 已随旧桥(HTTP 兜底)退役,已落回 auto(唯一的路 = 服务注入)'
      : 'transport 只认 auto/service,已落回 ' + DEFAULT_SETTINGS.transport)
  }
  if (s.enabled && s.accessToken === '') problems.push('总闸开着但 accessToken 是空的 —— 反向 WS 会拒收一切连接')
  if (s.enabled && s.allowedUsers.length === 0) problems.push('总闸开着但白名单是空的 —— 所有私聊都会被拒收(这是有意的:不做"空即全通")')
  if (s.enabled && s.transport === 'service' && s.allowedUsers.length > 0) {
    // 严格模式是验收用的:提醒一句,免得忘了改回去以后某天主包没起、她"莫名其妙不说话"
    problems.push('transport=service 是严格模式(唯一的路 = 服务注入;主包不在时一律 none,没有可回落的路)—— 验收完记得改回 auto')
  }
  return { settings: s, problems }
}

export function configPathOf (dir = dataDirOf()) {
  return join(dir, 'config.json')
}

/** 现读配置(文件不存在 = 全默认值;文件坏了 = 全默认值 + problems 里明说)。 */
export async function readSettings (dir = dataDirOf()) {
  const path = configPathOf(dir)
  if (!existsSync(path)) {
    const { settings, problems } = parseSettings({})
    return { settings, problems, path, exists: false }
  }
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    const { settings, problems } = parseSettings(raw)
    return { settings, problems, path, exists: true }
  } catch (err) {
    const { settings } = parseSettings({})
    return { settings, problems: ['config.json 读不动/不是 JSON(' + String(err?.message ?? err) + '),已按默认值跑'], path, exists: true }
  }
}

/** 写回(浅合并 patch),写前落目录。返回写完后的配置。 */
export async function atomicSettingsWrite (path, text, io = { writeFile, rename, unlink }) {
  const temporary = path + '.tmp-' + randomUUID()
  try {
    await io.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
    await io.rename(temporary, path)
  } finally { try { await io.unlink(temporary) } catch { /* already renamed or not created */ } }
}
const saves = new Map()
export async function saveSettings (patch, dir = dataDirOf(), options = {}) {
  const previous = saves.get(dir) || Promise.resolve()
  const run = previous.catch(() => {}).then(() => saveSettingsNow(patch, dir, options))
  saves.set(dir, run)
  try { return await run } finally { if (saves.get(dir) === run) saves.delete(dir) }
}
async function saveSettingsNow (patch, dir, options) {
  const path = configPathOf(dir)
  const text = existsSync(path) ? await readFile(path, 'utf8') : null
  const revision = text === null ? null : createHash('sha256').update(text).digest('hex')
  if (Object.hasOwn(options, 'revision') && options.revision !== revision) throw Object.assign(new Error('settings conflict'), { code: 'conflict' })
  let cur = {}
  if (text !== null) {
    try { cur = JSON.parse(text); if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw Error('not an object') } catch (error) {
      if (options.repair !== true) throw error
      await copyFile(path, path + '.bad-backup-' + randomUUID())
      cur = {}
    }
  }
  const next = { ...(cur && typeof cur === 'object' ? cur : {}), ...(patch ?? {}) }
  await mkdir(dir, { recursive: true })
  await atomicSettingsWrite(path, JSON.stringify(next, null, 2) + '\n')
  return parseSettings(next).settings
}

/**
 * 入站该不该收（纯函数，便于单测）。
 *
 * 2026-10-15：**加群聊**。判据按类型分开：
 *
 *   私聊 —— 白名单 `allowedUsers` 里的人才收（原样不变）
 *   群聊 —— ① 总闸开 ② `groupEnabled` 开 ③ 群在 `allowedGroups` 白名单里
 *            **成员不设白名单**：群里谁说话都收（他要的"群里所有消息都回"）；
 *            "谁说的话进记忆"由主包按信封里的 `isMaster` 判 —— 那是**记账**，
 *            不是**准入**，两件事分开（他 2026-10-15 拍的分层）。
 *
 * ⚠️ **唤醒状态不在这里判** —— 那是 `lib/group-awake.js` 的活。
 *    这里只回答"这个群**允许**收吗"，不回答"现在**该**收吗"。
 */
export function allowsInbound (settings, { userId, groupId, chatType = 'private' } = {}) {
  if (settings?.enabled !== true) return { ok: false, reason: 'disabled' }
  if (chatType === 'group') {
    if (settings.groupEnabled !== true) return { ok: false, reason: 'group-disabled' }
    const gid = String(groupId ?? '').trim()
    if (gid === '') return { ok: false, reason: 'no-group' }
    const groups = Array.isArray(settings.allowedGroups) ? settings.allowedGroups : []
    // 空名单 = 一律拒收（与私聊那条同一条纪律：**不做"空即全通"**）
    if (!groups.includes(gid)) return { ok: false, reason: 'group-not-allowlisted' }
    return { ok: true, chatType: 'group' }
  }
  if (chatType !== 'private') return { ok: false, reason: 'not-private' }
  const id = String(userId ?? '').trim()
  if (id === '') return { ok: false, reason: 'no-user' }
  const list = Array.isArray(settings.allowedUsers) ? settings.allowedUsers : []
  if (!list.includes(id)) return { ok: false, reason: 'not-allowlisted' }
  return { ok: true, chatType: 'private' }
}
