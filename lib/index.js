/**
 * dsh-echo-qq —— Echo 的「嘴」:QQ(OneBot 11 / NapCat)渠道插件。
 *
 * 分工:**主包 `dsh-echo` = 脑**(人格/记忆/气泡/节奏/打断/想念),**本插件 = 嘴**(收发/送达/心跳)。
 * 她要不要说、说什么、分几泡、什么时候说 —— 全在主包;本插件只负责"把他发来的递进去、
 * 把她要说的发出去、发到了回执",以及一张自己的页面。
 *
 * 本文件 = plan 的 S2-a 骨架接线;收发主体在 `lib/onebot.js`(借来的 OneBot 客户端,见 THIRD_PARTY.md)。
 *
 * 纪律(与主包一致,不是这里自创的):
 *   ① **总闸默认关** —— 装上了 ≠ 开了;关着就只挂页面,连 WS 都不监听;
 *   ② **私聊 + 白名单** —— 群聊一律不收,白名单为空一律拒收;
 *   ③ **fail-soft** —— 宿主服务缺了、ws 没装、配置坏了,都只降级 + 说清理由,绝不把宿主拖崩;
 *   ④ **不抢主包的活** —— 这里**不注册工具、不写记忆、不发系统提示词**。她那两只手
 *      (`echo_qq_say` / `echo_qq_call`)仍住在主包。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChannel, registrationAction, serviceOf, SERVICE_NAME } from './contract.js'
import { buildPrivateEnvelope, readPrivateEvent, imagesOfSegments } from './envelope.js'
import { expandForwardContent, hasForwardContent, FORWARD_NOTICES } from './forward-content.js'
import { createContentQueue } from './content-queue.js'
import { createForwardCache } from './forward-cache.js'
import { filesOfSegments, resolveFileDownload } from './file-content.js'
import { createFileReceipts } from './file-receipts.js'
import { createQQFileSendService } from './file-send-service.js'
import { allowsInbound, dataDirOf, DEFAULT_SETTINGS, readSettings, saveSettings } from './config.js'
import { handleSettingsRequest } from './settings-api.js'
import { appendInbound, inboundEntry } from './journal.js'
// 2026-10-15 加群聊：唤醒状态机（@唤醒 / 2 分钟休眠 / /stop）。
// 住渠道不住主包 —— 判它要用三件**只有渠道才知道**的事实（群里刚有没有人说话、
// 她被没被 @、/stop 是不是冲她说的），放进主包就得把这三样塞进跨仓信封契约。
import { createGroupAwake, decideGroupMessage, isAtMe, isStopCommand, DEFAULT_IDLE_MS } from './group-awake.js'
// 2026-10-18：群聊「醒来补档」（休眠时一条不碰，只在 wake / 启动时拉一次）
import { createGroupHistory, clampHistoryCount } from './group-history.js'
import { createGroupContext, replyIdOfSegments, messageIdOf, historyBefore } from './group-context.js'
import { createWebPageHandler, webRootOf } from './webpage.js'
import { splitForSend } from './split.js'
// 2026-10-05 拍板 2-A:出站收口剥掉 `[emo:…]` 语气指令(自带一份,出处见 lib/emo-marker.js)
import { stripEmoMarkers } from './emo-marker.js'
import { summarizeTiming } from './verdict.js'
// 2026-10-15:QQ 空间通道（第二条上游：onebot-qzone 桥）。
// 只做通道 + Cookie 保活；**工具仍由主包注册**（纪律 ④）。
import { createQzoneChannel, QZONE_ACTIONS, makeGetCookies } from './qzone.js'
// ★ 2026-10-19：空间**评论事件**（连桥的正向 WS，不碰桥的 src/）
import { createQzoneEventClient, bridgeEventUrl, parseWatchList } from './qzone-events.js'
// 2026-10-18：空间桥的进程管家（桥的命 = 插件的命，他拍的口径）
import { createBridgeSupervisor } from './bridge-supervisor.js'

/**
 * 版本号**只从 package.json 读**(v0.42.0 审计修复:这里原来写死 `'0.1.2'`,
 * 而 package.json 早就是 0.1.3 —— 状态页/日志里报的是过期版本,排查时会被带偏。
 * 两份真源必然漂,所以只留一份)。
 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return String(pkg?.version ?? '0.0.0')
  } catch { return '0.0.0' } // 读不到不影响收发;状态页会显示 0.0.0,那是"读不到"的实话
})()

/** 等 `notBefore` 的封顶(A 侧同款:`min(wait, 3.0)`)—— 一条不许堵住整个循环。 */
const BUBBLE_WAIT_CAP_MS = 3000

/**
 * 一批出站的**时间预算**(v0.42.0 审计修复 P1)。
 * 主包那轮出站租约是 30s(`dsh-echo` 的 relay 队列):一批要是发得比租约还久,
 * 租约一过期主包就会把这批**再推一遍** —— 他会收到两份一样的话。
 * 20s 留出安全边距;超预算的行不回执,下一轮再说。
 */
const DELIVER_BUDGET_MS = 20000

/** 绑不上端口时的退避重试(切换期:6199 可能还被 AstrBot 占着)。15s × 20 ≈ 5 分钟。 */
const BIND_RETRY_MS = 15000
const BIND_MAX_TRIES = 20

export const name = 'dsh-echo-qq'

/**
 * 只注入页面要用到的宿主服务。
 * **故意不 inject `echo:relay`** —— 那会让主包不在时本插件永不激活(见 contract.js 顶部注释)。
 */
export const inject = ['webServer']

export function apply (ctx, config) {
  const webServer = ctx?.get ? ctx.get('webServer') : null
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    ctx.logger.warn('echo-qq: inactive — webServer 服务不可用')
    return
  }

  const dir = dataDirOf()
  const log = (level, msg, extra) => {
    const fn = ctx.logger?.[level] ?? ctx.logger?.info
    if (typeof fn === 'function') (extra === undefined ? fn.call(ctx.logger, msg) : fn.call(ctx.logger, msg + ' ' + safeJson(extra)))
  }

  let settings = null
  let problems = []
  let onebot = null
  let onebotCreating = null
  let channel = null
  let lastState = null
  const contentState = { epoch: 0, socialEpoch: 0, disposed: false, seen: new Map(), scopes: new Map() }
  const contentQueue = createContentQueue()
  const groupContext = createGroupContext()
  function invalidateGroup (groupId) {
    const key = 'group:' + String(groupId)
    contentState.scopes.delete(key)
    contentQueue.invalidate(key)
    groupContext.forget(String(groupId))
    groupHistory.forget(String(groupId))
    forwardCache.invalidateChat(key)
    fileReceipts.invalidateChat(key)
  }
  const forwardCache = createForwardCache()
  const fileReceipts = createFileReceipts({
    resolve: (file, source, execution) => resolveFileDownload(file, source, {
      ...execution,
      call: (action, params, options) => onebot?.call
        ? onebot.call(action, params, options) : Promise.resolve({ ok: false })
    })
  })
  const chatKeyOf = source => source.chatType + ':' + source.chatId
  const contentAllowed = source => {
    if (contentState.disposed || !source || !['private', 'group'].includes(source.chatType)) return false
    const gate = allowsInbound(settings, {
      userId: source.senderId, chatType: source.chatType,
      groupId: source.chatType === 'group' ? source.chatId : ''
    })
    return gate.ok === true && (source.chatType !== 'group' || groupAwake.isAwake(source.chatId))
  }
  ctx.effect(() => ctx.provide('echo:qq-content', {
    readForward: args => contentAllowed(args?.source)
      ? forwardCache.readForward(args)
      : { ok: false, reason: 'source-unavailable' },
    inspectFile: args => contentAllowed(args?.source)
      ? fileReceipts.inspectFile(args) : { ok: false, reason: 'source-unavailable' },
    openFile: args => contentAllowed(args?.source)
      ? fileReceipts.openFile(args) : { ok: false, reason: 'source-unavailable' }
  }), 'echo-qq.content()')

  // ---- 2026-10-15 群聊唤醒状态机 -------------------------------------------
  // **只存内存**（他定）：重启后一律从"休眠"开始 —— 不会出现"重启完她还在群里叨叨"。
  // `groupIdleMs` 是**现读**的（配置改了下一拍生效）；定时器按需挂、状态一变就撤旧挂新。
  const groupAwake = createGroupAwake({
    idleMs: DEFAULT_IDLE_MS,
    onSleep: groupId => invalidateGroup(groupId),
    log: (m) => log('info', 'echo-qq: ' + m)
  })
  const fileSendService = createQQFileSendService({
    clientOf: () => onebot, settingsOf: () => settings,
    isAwake: groupId => groupAwake.isAwake(groupId),
    isCurrent: () => !contentState.disposed
  })
  ctx.effect(() => ctx.provide('echo:qq-file-send', fileSendService), 'echo-qq.file-send()')
  /** 把回调里的动作落到状态机上（`decideGroupMessage` 只出判据，不碰状态）。 */
  const groupAwakeApply = (groupId, action) => {
    try {
      if (action === 'sleep' || (action === 'wake' && !groupAwake.isAwake(groupId))) {
        const key = 'group:' + String(groupId)
        contentState.scopes.delete(key)
        contentQueue.invalidate(key)
        forwardCache.invalidateChat(key)
        fileReceipts.invalidateChat(key)
        groupContext.forget(String(groupId))
        if (action === 'sleep') groupHistory.forget(String(groupId))
      }
      if (action === 'wake') groupAwake.wake(groupId)
      else if (action === 'touch') groupAwake.touch(groupId)
      else if (action === 'sleep') groupAwake.sleep(groupId)
      // 'drop' / 'ignore' ⇒ 什么都不做
      //   2026-10-17 加 `ignore`（休眠中**别人** @ 她）：状态效果与 drop 相同
      //   （不唤醒、不续命），分开只为让日志能区分"没人叫她"和"叫她的不是主人"。
    } catch (err) {
      log('warn', 'echo-qq: 群唤醒状态机出错(不影响这一条)', { error: String(err?.message ?? err) })
    }
  }

  // ---- 2026-10-18 群聊「醒来补档」 -----------------------------------------
  //
  // 他拍的口径：「休眠时不处理，唤醒时一次性补拉历史，条数有限制」。
  //
  // 为什么：群休眠时 `decideGroupMessage` 返回 `drop` ⇒ 消息在适配器就扔了
  // （journal 实测 123 条），她醒来对刚才群里说过什么完全不知道。
  //
  // ⚠️ **休眠时一条都不拉**：这个模块没有任何定时器，只在两处被叫 ——
  //   ① 主人 @ 她、判定 `wake` 的那一刻（拉 + 注入）；
  //   ② 插件启动时对白名单各拉一次（只填缓冲，**不注入、不触发回复**）。
  //
  // `fetch` 用 `onebot.call` 现取连接 —— 桥没连上时 `call` 自己返回
  // `{ok:false, error:'no client connected'}`，这里降级成"这轮不补"，不抛。
  const groupHistory = createGroupHistory({
    fetch: async (groupId, count) => {
      let client = null
      try { client = await ensureClient() } catch { client = null }
      if (client === null || typeof client.call !== 'function') return null
      const r = await client.call('get_group_msg_history', {
        group_id: String(groupId),
        count: Number(count),
        reverse_order: false
      }, { timeoutMs: 10000 })
      if (r === null || r === undefined || r.ok !== true) return null
      return r.data ?? null
    },
    log: (level, msg, extra) => log(level, msg, extra)
  })

  /**
   * 启动补拉：对白名单里的每个群各拉一次。
   *
   * ⚠️ **只填缓冲、绝不注入** —— 他明确要求"不要触发回复"。注入会等于
   * 替群里发了条消息给她，她会当场回一句；那正是"休眠时不处理"要避免的。
   *
   * 失败静默（桥可能还没连上，几秒后 `ensureClient` 才有活连接）——
   * 补档是增益，不许影响插件起来。
   */
  async function primeGroupHistory () {
    // reload has already committed the parsed view; readSettings returns a
    // Promise<{settings}>, not the settings object itself.
    const s = settings
    if (s === null || s.enabled !== true || s.groupEnabled !== true) return
    if (s.groupHistoryOnWakeEnabled === false) return
    const groups = Array.isArray(s.allowedGroups) ? s.allowedGroups : []
    if (groups.length === 0) return
    const n = Number(s.groupHistoryOnWakeCount) > 0 ? Number(s.groupHistoryOnWakeCount) : 20
    const epoch = contentState.epoch
    for (const gid of groups) {
      const isCurrent = () => !contentState.disposed && epoch === contentState.epoch &&
        settings?.enabled === true && settings?.groupEnabled === true &&
        settings?.allowedGroups?.map(String).includes(String(gid))
      try {
        await groupHistory.pull(gid, n, { selfId: s.selfId, masterId: s.masterId, isCurrent })
      } catch { /* 单个群失败不影响其它群 */ }
    }
    log('info', 'echo-qq: 启动补拉群历史完成', groupHistory.status())
  }

  /**
   * 分段耗时(验收那张表的原料):"主包把话推来" → "真送到他手机" → "回执销账"。
   * 旧桥轮询时代这条链路是 2 秒一格;现在唯一的路 = 服务注入(零轮询),该是毫秒级 ——
   * 数字由插件自己记,免得验收时还得在旁边架个秒表。样本只留最近 50 条(够看 P50/P95)。
   */
  const stats = { pushes: 0, rows: 0, sent: 0, failed: 0, dropped: 0, last: null, samples: [] }

  function noteSent (pushAt, sentAt, ackAt) {
    stats.last = {
      pushAt,
      sentAt,
      ackAt,
      pushToSentMs: sentAt - pushAt,
      sentToAckMs: ackAt - sentAt
    }
    if (stats.samples.length >= 50) stats.samples.shift()
    stats.samples.push(sentAt - pushAt)
  }

  /** 现读配置(每轮都读文件,改完不用重启;坏值不静默)。 */
  async function reload () {
    let next = null
    try {
      const r = await readSettings(dir)
      next = r.settings
      problems = r.problems
    } catch (err) {
      problems = ['读配置失败,按默认值跑:' + String(err?.message ?? err)]
      next = { ...DEFAULT_SETTINGS }
    }
    const admission = value => JSON.stringify([
      value?.enabled, value?.groupEnabled, value?.allowedUsers, value?.allowedGroups,
      value?.masterId, value?.selfId
    ])
    if (settings !== null && admission(settings) !== admission(next)) {
      contentState.epoch += 1
      contentState.seen.clear()
      contentState.scopes.clear()
      forwardCache.clear()
      fileReceipts.clear()
      groupAwake.stop()
      groupHistory.clear()
      groupContext.clear()
    }
    if (settings !== null && (settings.groupSocialEnabled !== false) !== (next.groupSocialEnabled !== false)) {
      contentState.socialEpoch = (contentState.socialEpoch ?? 0) + 1
      for (const key of [...contentState.scopes.keys()]) {
        if (!key.startsWith('group:')) continue
        contentState.scopes.delete(key)
        contentQueue.invalidate(key)
        forwardCache.invalidateChat(key)
        fileReceipts.invalidateChat(key)
      }
      groupContext.clear()
    }
    settings = next
    return { settings, problems }
  }

  // 配置的**活视图**:面板/文件改完不用重启 —— channel 拿的是这个,不是一份快照
  // (否则改 transport 要重启才生效,而"现读配置"是本插件许诺过的)
  const settingsView = {
    get pollMs () { return settings === null ? 2000 : settings.pollMs },
    get transport () { return settings === null ? 'auto' : settings.transport },
    get inboundRetryTimes () { return settings === null ? DEFAULT_SETTINGS.inboundRetryTimes : settings.inboundRetryTimes },
    get inboundRetryBaseMs () { return settings === null ? DEFAULT_SETTINGS.inboundRetryBaseMs : settings.inboundRetryBaseMs }
  }

  // ---- QQ 空间通道（2026-10-15）--------------------------------------------
  //
  // 第二条上游:onebot-qzone 桥(默认值见 config.js 的 qzoneHost/qzonePort)。**与聊天解耦** ——
  // 桥挂了,OneBot 那条路一个字都不受影响。
  //
  // 拿的同样是**活视图**(不是快照):面板改完 qzone* 项,下一轮 action 就按新值走。
  // 兜底值一律取 `DEFAULT_SETTINGS`(唯一真源;本文件不许出现 loopback 字面量)。
  const qzoneSettingsView = {
    get qzoneEnabled () { return settings !== null && settings.qzoneEnabled === true },
    get qzoneHost () { return settings === null ? DEFAULT_SETTINGS.qzoneHost : settings.qzoneHost },
    get qzonePort () { return settings === null ? DEFAULT_SETTINGS.qzonePort : settings.qzonePort },
    get qzoneAccessToken () { return settings === null ? '' : settings.qzoneAccessToken },
    get qzoneDefaultUgcRight () { return settings === null ? DEFAULT_SETTINGS.qzoneDefaultUgcRight : settings.qzoneDefaultUgcRight },
    get qzoneCookieRefreshMin () { return settings === null ? DEFAULT_SETTINGS.qzoneCookieRefreshMin : settings.qzoneCookieRefreshMin },
    get qzoneSelfUin () { return settings === null ? '' : settings.qzoneSelfUin },
    // ★★ 2026-10-20 修：**上面这串 getter 漏了两个键**，而 `qzone.js` 的 `cfg()` 要读它们
    //    （`lib/qzone.js:269-270`）⇒ 生产里一直读到 `undefined`：
    //
    //      · `watchList` ⇒ 永远**空集** ⇒
    //          - `listFeeds` 永远 `watchlist-empty`
    //          - `listMoods(uin)` 看谁都 `not-in-watchlist`
    //          - **`replyComment` 的白名单闸永远 false**
    //      · `masterId` ⇒ 永远**空串** ⇒ 连**他本人**都过不了那道闸
    //
    //    ⚠️ 这个洞从 `a7f636f`（2026-10-19「评论感知」第一段）就在，一直没人发现 ——
    //    因为单测一律直接给 `createQzoneChannel` 喂**完整 settings**，
    //    而生产喂的是这张**裁剪过的视图**。现在补一条静态闸钉住这个对齐关系
    //    （见 `test/qzone-settings-view.test.mjs`）。
    get qzoneWatchList () { return settings === null ? DEFAULT_SETTINGS.qzoneWatchList : settings.qzoneWatchList },
    get masterId () { return settings === null ? DEFAULT_SETTINGS.masterId : settings.masterId }
  }
  const qzone = createQzoneChannel({
    settings: qzoneSettingsView,
    log,
    // ★ Cookie 保活靠这一根线:经**已有的** OneBot 反向 WS 向 NapCat 要 cookie。
    // 实现抽到 `lib/qzone.js` 的 `makeGetCookies` —— **为了能测**（见那边的注释）：
    // 内联在这就只能靠源码文本断言，测不出"真的传了什么"。
    // ★★ 2026-10-15：`get_cookies` 的 `domain` **必填**（漏了真机回 1400）。
    getCookies: makeGetCookies(() => onebot)
  })

  // ★ 2026-10-19：**空间评论事件**。
  //
  // 方向：我们**连出去**到桥的正向 WS `/event`（`server.ts:179-182` 开的四条路径之一）。
  // ⚠️ 绝不能反过来让桥连进 6199 —— `lib/onebot.js:375-381` 的 `currentSocket()`
  //    取"最后连上的那个 OPEN 连接"，桥连进来就会把 `send_msg` 抢走 ⇒ QQ 消息全断。
  //
  // 谁算数：主人 ⇒ `kind:'master'`（走用户通道）；白名单 ⇒ `kind:'space'`（空间事件）；
  // 其他人 ⇒ 直接丢（不回复、不进记忆）。
  const commentSubs = new Set()
  let commentWired = false
  let wsImpl = null

  function dispatchComment (kind, ev) {
    for (const cb of [...commentSubs]) {
      try {
        cb({ kind, ...ev })
      } catch (err) {
        log('warn', 'qzone-events: 订阅者抛错 — ' + String(err?.message ?? err))
      }
    }
  }

  const qzoneEvents = createQzoneEventClient({
    wsFactory: (url) => {
      if (wsImpl === null) throw new Error('ws 客户端还没加载好')
      return new wsImpl(url, { handshakeTimeout: 10000 })
    },
    url: () => bridgeEventUrl({
      host: qzoneSettingsView.qzoneHost,
      port: qzoneSettingsView.qzonePort,
      token: qzoneSettingsView.qzoneAccessToken
    }),
    who: () => ({
      masterId: String(settings?.masterId ?? ''),
      watchList: parseWatchList(settings?.qzoneWatchList)
    }),
    onMaster: (ev) => dispatchComment('master', ev),
    onSpace: (ev) => dispatchComment('space', ev),
    log
  })

  /** 懒装 ws + 起事件客户端（fail-soft：ws 没装只报错，不崩宿主）。 */
  async function ensureQzoneEvents () {
    if (commentWired) return
    commentWired = true
    try {
      const m = await import('ws')
      wsImpl = m.WebSocket ?? m.default
      qzoneEvents.start()
    } catch (err) {
      commentWired = false
      log('warn', 'qzone-events: ws 加载不了，评论事件收不到 — ' + String(err?.message ?? err))
    }
  }

  /**
   * 空间通道的自报家门(与主包 `echo:relay` 的 `hello()` 同一个口径)。
   * 消费端(主包)先读它做能力探测,再决定要不要注册那几个工具。
   */
  const QZONE_SERVICE_NAME = 'echo:qzone'
  const QZONE_SERVICE_VERSION = 1
  const QZONE_CAPABILITIES = Object.freeze(['post', 'list', 'delete', 'refreshCookie', 'commentEvents', 'commentReply', 'commentRead', 'feedRead'])

  /** 起 OneBot 客户端(懒装 + fail-soft):ws 没装、端口占了,都只报错不崩宿主。 */
  async function ensureClient () {
    if (contentState.disposed || settings === null) return null
    if (onebot !== null) return onebot
    if (onebotCreating !== null) return onebotCreating
    const creationSettings = { ...settings }
    const creationKey = value => JSON.stringify([
      value?.enabled, value?.host, value?.port, value?.accessToken,
      value?.heartbeatMs, value?.maxMisses
    ])
    const expectedKey = creationKey(creationSettings)
    const current = () => !contentState.disposed && creationKey(settings) === expectedKey
    const pending = (async () => {
    let createOneBot = null
    try {
      ({ createOneBot } = await import('./onebot.js'))
    } catch (err) {
      log('warn', 'echo-qq: lib/onebot.js 加载不了(ws 没装?)' + ' — ' + String(err?.message ?? err))
      return null
    }
    if (!current()) return null
    const created = createOneBot({
      host: creationSettings.host,
      port: creationSettings.port,
      accessToken: creationSettings.accessToken,
      // 2026-09-27 小工验收抓到的真 bug:这两个没传下去 ⇒ 真机永远用默认
      // 30000/3,config.json 与网页里那个 heartbeatMs 到不了客户端。
      heartbeatMs: creationSettings.heartbeatMs,
      maxMisses: creationSettings.maxMisses,
      log,
      onState: (st) => {
        if (lastState?.state !== st?.state && ['closed', 'listening', 'client-connected'].includes(st?.state)) {
          contentState.epoch += 1
          contentState.scopes.clear()
          groupAwake.stop()
          groupHistory.clear()
          groupContext.clear()
        }
        lastState = st
        log('info', 'echo-qq: 连接状态', st)
        // NapCat 一接上,先把积压的泡冲一遍(重启前留下的、或上一轮还没到点的那几泡)。
        // 真机第一轮就留了一泡在队列里没人取 —— 推送只在新话出现时来。
        if (st?.state === 'client-connected') channel.drain().catch(() => {})
      },
      onEvent: (evt) => {
        // 2026-09-29:每一步都留一行账(`<dataDir>/inbound.jsonl`)—— 他发图那次
        // 「什么都没发生」,而死亡点是"门口就拒了"这件事只有宿主日志知道。见 lib/journal.js。
        const journal = (entry) => { try { appendInbound(dir, inboundEntry(entry)) } catch { /* 记不上不影响传话 */ } }
        const chatType = evt?.chatType === 'group' ? 'group' : 'private'
        const groupId = chatType === 'group' ? String(evt?.groupId ?? '') : ''
        // 群聊这一条的判定结果（下面"要不要补档"要看它是不是 `wake`）
        let verdictRef = null

        // ---- 2026-10-15 加群聊：三层判据，各管各的，谁也别抢谁的活 ----
        //
        //   ① `allowsInbound`  ——  **允许**收吗？（群白名单 / 群闸 / 总闸）
        //   ② 唤醒状态机       ——  现在**该**收吗？（@唤醒 / 2 分钟休眠 / /stop）
        //   ③ 信封 + 送进去     ——  形状对了就出门
        //
        // ⚠️ `isMaster` 的语义在群里变了：私聊白名单过了就是"他"（单主人）；
        //    群里**谁说话都收**，"这话算不算他说"由**他本人的 QQ 号**判 ——
        //    主包据 `sender.isMaster` 决定进不进记忆（他 2026-10-15 拍的分层：
        //    **准入在渠道、记账在主包**）。
        //    ★ 2026-10-17：群里判「这话是不是他说的」用 **masterId**（他的号）。
        //    原来这里拿 `settings.selfId` 比 —— 那是**她**的号，
        //    而群里发言的永远不是她 ⇒ `isMaster` 恒为 false ⇒
        //    他自己说的话也被标「（非主人）」+ 被贴"不要擅自答应"的警惕。
        const senderId = String(evt?.userId ?? '').trim()
        const masterId = String(settings.masterId ?? '').trim()
        const senderIsMaster = masterId !== '' && senderId === masterId
        const atMe = chatType === 'group' ? isAtMe(evt?.segments, settings.selfId) : false
        // 唤醒的唯一凭据：**主人** @ 她（他拍：「唤醒必须要我来把关」）
        const atMeByMaster = atMe && senderIsMaster
        const stopCommand = chatType === 'group' && atMe && isStopCommand(evt?.text)
        const gate = allowsInbound(settings, { userId: evt?.userId, groupId, chatType })
        if (!gate.ok) {
          log('info', 'echo-qq: 入站被拒', { reason: gate.reason, userId: evt?.userId, groupId })
          journal({ ok: false, stage: 'gate', reason: gate.reason, userId: evt?.userId })
          return
        }
        if (chatType === 'group') {
          const verdict = decideGroupMessage({
            atMe, atMeByMaster, awake: groupAwake.isAwake(groupId), stopCommand
          })
          verdictRef = verdict
          groupAwakeApply(groupId, verdict.action)
          if (verdict.send !== true) {
            log('info', 'echo-qq: 群消息不送', { groupId, action: verdict.action, reason: verdict.reason, senderIsMaster })
            journal({ ok: false, stage: 'group-awake', reason: verdict.action + ':' + verdict.reason, userId: evt?.userId })
            return
          }
        }
        const isMaster = chatType === 'group' ? senderIsMaster : true
        const socialEnabled = chatType === 'group' && settings.groupSocialEnabled !== false
        const pics = imagesOfSegments(evt.segments)
        const source = { chatId: chatType === 'group' ? groupId : senderId, chatType, senderId, isMaster }
        const key = chatKeyOf(source)
        const epoch = contentState.epoch
        let scope = contentState.scopes.get(key)
        if (!scope) {
          while (contentState.scopes.size >= 128) contentState.scopes.delete(contentState.scopes.keys().next().value)
          scope = {}
        } else contentState.scopes.delete(key)
        contentState.scopes.set(key, scope)
        const isCurrent = () => epoch === contentState.epoch && contentState.scopes.get(key) === scope && contentAllowed(source)
        const seenKey = key + ':' + String(evt.messageId)
        const receivedAt = Date.now()
        for (const [id, until] of contentState.seen) if (until <= receivedAt) contentState.seen.delete(id)
        if (contentState.seen.has(seenKey)) return
        while (contentState.seen.size >= 256) contentState.seen.delete(contentState.seen.keys().next().value)
        contentState.seen.set(seenKey, receivedAt + 300000)
        const isGroupWake = chatType === 'group' && verdictRef?.action === 'wake'
        const wantHistory = isGroupWake && settings.groupHistoryOnWakeEnabled !== false
        const fallback = () => ({
          historyDigest: '',
          expanded: hasForwardContent(evt.segments) ? {
            forwardContent: { source: 'qq-forward-quote', present: true, nodes: [],
              notices: [FORWARD_NOTICES.requestFailed], truncated: false, stats: {} },
            images: []
          } : { forwardContent: null, images: [] }
        })
        const prepare = async (guard) => {
          const expanded = hasForwardContent(evt.segments)
            ? expandForwardContent(evt.segments, {
                limits: { maxMessages: 80, maxChars: 24000 },
                getForward: (id, options) => guard.isCurrent()
                  ? onebot.call('get_forward_msg', { id }, { timeoutMs: options.timeoutMs })
                  : Promise.resolve({ ok: false })
              })
            : Promise.resolve({ forwardContent: null, images: [] })
          const history = !wantHistory ? Promise.resolve('') : Promise.resolve().then(async () => {
            if (!guard.isCurrent()) return ''
            const n = clampHistoryCount(settings.groupHistoryOnWakeCount)
            await groupHistory.pull(groupId, n, { selfId: settings.selfId, masterId: settings.masterId, isCurrent: guard.isCurrent })
            return groupHistory.digest(groupId, {
              limit: n, excludeMessageId: evt.messageId,
              beforeMessageId: evt.messageId, beforeTs: evt.ts,
              masterName: String(settings.masterName ?? '') || '主人'
            })
          }).catch(() => '')
          const results = await Promise.allSettled([expanded, history])
          const safe = fallback()
          return {
            expanded: results[0].status === 'fulfilled' ? results[0].value : safe.expanded,
            historyDigest: results[1].status === 'fulfilled' ? results[1].value : ''
          }
        }
        const deliver = (prepared, guard) => {
          if (!guard.isCurrent()) return { ok: false, reason: 'inbound-cancelled' }
          let historyTruncated = false
          if (socialEnabled && wantHistory && groupContext.snapshot(groupId).recent.length === 0) {
            const entries = groupHistory.list(groupId)
            const earlier = historyBefore(entries, evt.messageId, evt.ts)
            historyTruncated = earlier.truncated
            for (const entry of earlier.entries) {
              if (entry.messageId === String(evt.messageId)) continue
              // Self-authored history is not a confirmed send receipt from this channel.
              if (String(entry.userId) === String(settings.selfId)) continue
              historyTruncated ||= entry.textTruncated === true
              groupContext.record(groupId, {
                messageId: entry.messageId, senderId: entry.userId, senderName: entry.userName,
                ts: entry.at, text: entry.text, atMe: entry.atMe, atOthers: entry.atOthers,
                isMaster: entry.isMaster === true,
                replyToMessageId: entry.replyToMessageId,
                direction: 'incoming', source: 'wake-history'
              })
            }
          }
          let forward = null
          if (prepared.expanded?.forwardContent) {
            try { forward = forwardCache.put(prepared.expanded, source) } catch { /* 后续页不可用仍交首段 */ }
            if (forward === null) forward = { ...prepared.expanded.forwardContent, images: prepared.expanded.images ?? [] }
          }
          const built = buildPrivateEnvelope({
            userId: evt.userId, userName: evt.userName, messageId: evt.messageId,
            text: evt.text, images: pics, ts: evt.ts, chatType, groupId, isMaster,
            historyDigest: String(prepared.historyDigest ?? ''),
            forwardContent: forward,
            files: fileReceipts.put(filesOfSegments(evt.segments, source), source, { isCurrent }),
            segments: evt.segments, selfId: evt.selfId,
            groupContext: socialEnabled ? { ...groupContext.snapshot(groupId, {
              excludeMessageId: String(evt.messageId), replyMessageId: replyIdOfSegments(evt.segments)
            }), ...(historyTruncated ? { truncated: true } : {}) } : null
          })
          if (!built.ok) {
            journal({ ok: false, stage: 'envelope', reason: built.reason,
              userId: evt.userId, msgId: evt.messageId, text: evt.text, images: pics })
            contentState.seen.delete(seenKey)
            return { ok: false, reason: built.reason }
          }
          journal({ ok: true, stage: 'sent', userId: evt.userId, msgId: evt.messageId, text: evt.text, images: pics })
          return channel.inject(built.envelope, { isCurrent }).then((r) => {
            if (r?.ok === true && socialEnabled && guard.isCurrent()) {
              groupContext.record(groupId, {
                messageId: String(evt.messageId), senderId, senderName: String(evt.userName ?? ''),
                ts: evt.ts, text: evt.text, direction: 'incoming', source: 'live',
                isMaster,
                atMe: built.envelope.atMe, atOthers: built.envelope.atOthers,
                replyToMessageId: replyIdOfSegments(evt.segments)
              })
            }
            if (r?.ok !== true) {
              contentState.seen.delete(seenKey)
              journal({ ok: false, stage: 'core-refused', reason: String(r?.reason ?? 'unknown'),
                userId: evt.userId, msgId: evt.messageId, text: evt.text, images: pics })
            }
            return r
          }).catch((err) => {
            contentState.seen.delete(seenKey)
            journal({ ok: false, stage: 'core-error', reason: String(err?.message ?? err).slice(0, 80),
              userId: evt.userId, msgId: evt.messageId, text: evt.text, images: pics })
            return { ok: false, reason: 'core-error' }
          })
        }
        const queued = contentQueue.enqueue(key, { prepare, deliver, fallback }, { isCurrent })
        if (!queued.accepted) {
          contentState.seen.delete(seenKey)
          journal({ ok: false, stage: 'content-queue', reason: queued.reason,
            userId: evt.userId, msgId: evt.messageId, text: evt.text, images: pics })
        }
        queued.done.then(result => {
          if (result.status !== 'delivered') {
            contentState.seen.delete(seenKey)
            journal({ ok: false, stage: 'content-queue', reason: result.reason ?? result.status,
              userId: evt.userId, msgId: evt.messageId, text: evt.text, images: pics })
          }
        }).catch(() => {})
      }
    })
    if (!current()) {
      try { await created?.stop?.() } catch { /* stale construction must not publish */ }
      return null
    }
    onebot = created
    return created
    })()
    onebotCreating = pending
    try { return await pending } finally {
      if (onebotCreating === pending) onebotCreating = null
    }
  }

  /**
   * 出站:把主包给的每一行发出去,只把**真发成功**的 id 回执。
   *
   * 两条从旧适配器搬过来的纪律(`astrbot_adapter/main.py:551-589`),头一版都漏了:
   *   ① **等 `notBefore`**(这一泡什么时候该发) —— 不等就把她的分泡节奏压成一串,
   *      而"手里这泡发完就停"正是 barge-in 的前提。等不到就照发(封顶 3s,同 A 侧
   *      `min(wait, 3.0)`,免得一条堵住整个循环)。
   *   ② **分段发,不截断** —— 超长回复切成 ≤ maxChars 的几段、段间留一点间隔;
   *      截断是真丢话(超出的部分他永远看不到)。
   */
  async function deliver (rows) {
    const okIds = []
    const segmentGapMs = Number(settings.segmentGapMs) > 0 ? Number(settings.segmentGapMs) : 500
    // v0.42.0 审计修复(P1:整批超过主包那 30s 租约 ⇒ 同一批被重发一遍):
    // 一行的「等 notBefore(封顶 3s)+ 逐段发 + 段间 500ms」叠起来,行数一多就能
    // 把 30 秒的租约耗光 —— 租约一过期,主包会把**已经发出去**的行再推一次。
    // 现在给整批一个时间预算(留出安全边距),用完了剩下的**不回执**(留在队列里
    // 等下一轮),还没到点的那几泡也直接跳过(不硬等)。宁可下一轮再发,不可重复发。
    const startedAt = Date.now()
    let attempted = 0
    let deferred = 0
    for (const row of rows) {
      if (typeof row.chatId !== 'string' || row.chatId === '') continue
      const sendEpoch = contentState.epoch
      const socialEpoch = contentState.socialEpoch
      const sendScope = contentState.scopes.get('group:' + row.chatId)
      if (Date.now() - startedAt > DELIVER_BUDGET_MS) { deferred += 1; continue } // 预算用完:原地留着
      const nb = Number(row.raw?.notBefore ?? 0)
      if (nb > 0) {
        const waitMs = nb * 1000 - Date.now()
        if (waitMs > 0) {
          // 等这一泡到点会挤爆预算 ⇒ 跳过(下一轮它就到点了),不硬等
          if (Date.now() - startedAt + Math.min(waitMs, BUBBLE_WAIT_CAP_MS) > DELIVER_BUDGET_MS) { deferred += 1; continue }
          await new Promise((r) => setTimeout(r, Math.min(waitMs, BUBBLE_WAIT_CAP_MS)))
        }
      }
      // 2026-10-05 拍板 2-A:QQ 出站收口 —— 先剥语气指令,再分段发。
      // 剥完若是空的(整行只有标记那种病态行):没有可发的话,直接销账 ——
      // 否则 splitForSend 返回空数组 ⇒ allOk=false ⇒ 不回执 ⇒ 主包租约到期重发,死循环。
      const text = stripEmoMarkers(row.text)
      if (text.trim() === '') {
        log('info', 'echo-qq: 这一行剥掉语气指令后没有内容,销账不发', { id: row.id })
        okIds.push(row.id)
        continue
      }
      attempted += 1
      const segments = splitForSend(text, settings.replyMaxChars)
      let allOk = segments.length > 0
      // 2026-10-15 加群聊：这一泡发到群里还是私聊？
      // `normalizeOutboundRow` 会落回 'private'（主包的 lease item 还没带这个字段，
      // 第 2 步加）⇒ 今天的行为一字不变。
      const toGroup = row.chatType === 'group'
      for (let i = 0; i < segments.length; i++) {
        if (i > 0 && segmentGapMs > 0) await new Promise((r) => setTimeout(r, segmentGapMs))
        const r = toGroup
          ? await onebot.sendGroupMsg(row.chatId, segments[i])
          : await onebot.sendPrivateMsg(row.chatId, segments[i])
        if (r?.ok !== true) {
          allOk = false
          log('warn', 'echo-qq: 这一段没送出去(整条留给主包租约重发)',
            { id: row.id, seg: i, to: toGroup ? 'group' : 'private', error: r?.error ?? '' })
          break
        }
        if (toGroup && settings.groupSocialEnabled !== false && !contentState.disposed &&
            sendEpoch === contentState.epoch && socialEpoch === contentState.socialEpoch &&
            groupAwake.isAwake(row.chatId) && contentState.scopes.get('group:' + row.chatId) === sendScope) {
          groupContext.record(row.chatId, {
            messageId: messageIdOf(r.messageId),
            senderId: String(settings.selfId ?? ''), senderName: 'Echo',
            ts: Date.now(), text: segments[i], direction: 'outgoing', source: 'live'
          })
        }
      }
      if (allOk) okIds.push(row.id)
    }
    if (deferred > 0) {
      log('info', 'echo-qq: ' + deferred + ' 行留给下一轮(本批时间预算用完或还没到点,已回执的照常销账)')
    }
    stats.sent += okIds.length
    // failed 只数**真试过**的:被预算推迟的那些不是失败,别把账记错
    stats.failed += Math.max(0, attempted - okIds.length)
    return okIds
  }

  /**
   * S3-b:向主包**自报家门**(`registerChannel`)。
   * 报上去之后,主包的门(`hasChannel()`)就不再只依赖旧桥总闸 ——
   * 这就是"旧桥退役、由本插件接管"那一步的前置。
   * 撤回很重要:一条已经关掉的嘴还挂在那儿,主包会以为她够得到他。
   */
  let mouthOff = null
  let mouthRegistered = false
  function syncMouth () {
    const svc = serviceOf(ctx)
    const action = registrationAction({
      enabled: settings !== null && settings.enabled === true,
      serviceAvailable: svc !== null && typeof svc.registerChannel === 'function',
      registered: mouthRegistered
    })
    if (action === 'idle') return action
    if (action === 'register') {
      try {
        const off = svc.registerChannel({
          name,
          status: () => (channel === null ? {} : channel.status()),
          close: () => { }
        })
        mouthOff = typeof off === 'function' ? off : null
        mouthRegistered = true
        log('info', 'echo-qq: 已向主包自报家门(她有一条嘴)')
      } catch (err) {
        log('warn', 'echo-qq: 自报家门失败(不影响收发)', { error: String(err?.message ?? err) })
      }
    } else {
      try { if (mouthOff !== null) mouthOff() } catch { /* 已经摘掉了 */ }
      mouthOff = null
      mouthRegistered = false
      log('info', 'echo-qq: 已向主包撤回(她没这条嘴了)')
    }
    return action
  }

  // ---- 空间桥的进程管家（2026-10-18）--------------------------------------
  //
  // 他拍的话：「我觉得 dsh 重启的时候她也重启比较好，我的意思是，
  // 整个插件起码要跟着 dsh 走」。
  //
  // 之前桥是开机自启（启动文件夹 + 计划任务）⇒ 三个毛病：
  //   · 开机就占资源，哪怕他没开 DSH；
  //   · `dsh web` 重启后桥还是**旧进程**（可能半死）；
  //   · 插件卸载了桥还在跑 —— 孤儿。
  //
  // 现在：**桥的命 = 插件的命**。不配 `qzoneBridgeDir` 就一行都不做
  // （向后兼容，见 `lib/bridge-supervisor.js` 顶部那三条纪律）。
  //
  // ⚠️ **定义必须在 `reload()` 之前**：下面的 `reload().then()` 要用它。
  //   第一版把这个 `const` 放在 `apply` 后半段（`qzoneProvided` 那块），
  //   `.then()` 里引用会撞 TDZ；而且第一版还在 `settings` 还是 `null` 时
  //   就 `start()` ⇒ 读到空目录 ⇒ **桥永远起不来**（就是"重启了但桥没起"那次）。
  const bridge = createBridgeSupervisor({
    settings: {
      get qzoneEnabled () { return settings !== null && settings.qzoneEnabled === true },
      get qzoneBridgeDir () { return settings === null ? '' : settings.qzoneBridgeDir },
      get qzoneBridgeAutoStart () { return settings === null ? true : settings.qzoneBridgeAutoStart },
      get qzoneBridgeScript () { return settings === null ? '' : settings.qzoneBridgeScript },
      get qzoneBridgeArgs () { return settings === null ? '' : settings.qzoneBridgeArgs }
    },
    log
  })
  // 收尾：dispose 时杀桥。清理不依赖 settings，随时能跑。
  ctx.effect(() => () => {
    try { bridge.stop() } catch { /* 停不掉也不影响卸载 */ }
  }, 'echo-qq.bridgeSupervisor()')

  // ---- 接线 ----
  reload().then(async () => {
    // ★ 2026-10-18：**桥在这里起**（不是 `apply` 里）—— 此时 `settings` 才是真的。
    //   `bridge` 在 `apply` 里已建好（它读的是活视图，但 `start()` 那一刻要有值）。
    //   幂等：`start()` 内部 `child !== null` 就直接返回 ⇒ 重复调无副作用。
    try {
      // ★ 2026-10-20：`start()` 现在是 async（启动前要探端口自愈孤儿桥）
      const started = await bridge.start()
      const bst = bridge.status()
      log('info', 'echo-qq: 空间桥 ' + (started ? '已启动' : (bst.configured ? '未启动（已有实例或未启用）' : '未配置（不管理进程）')),
        { dir: bst.dir, autoStart: bst.autoStart })
    } catch (err) {
      log('warn', 'echo-qq: 起空间桥失败 — ' + String(err?.message ?? err))
    }
    // ★ 2026-10-18：**启动补拉群历史**（他拍：「启动时对 allowedGroups 各补拉一次」）。
    //
    // ⚠️ 只**填缓冲**，绝不注入 —— 他明确要求"不要触发回复"。
    //   （注入 = agent.followup = 替群里发她一条消息 ⇒ 她会当场回一句，
    //    那正是"休眠时不处理"要避免的。）
    //
    // ⚠️ **不 await**：桥可能还没连上（NapCat 每 5 秒重连一次），这里等它会把
    //   插件起来的速度拖住。它自己内部 fail-soft、每个群独立 try。
    //   真要补的时候（唤醒那一刻）会再拉一次，那次才是保证有货的。
    Promise.resolve().then(() => primeGroupHistory()).catch(() => {})
    channel = createChannel({
      ctx,
      settings: settingsView,
      log,
      // 有连接才去取行(见 contract.js 的 canSendNow):
      // 取行 = 占一轮租约;发不出去还去取,只会白占 30 秒。没连接就别抢。
      canSend: () => onebot !== null && Number(onebot.status()?.clients ?? 0) > 0
    })
    log('info', 'echo-qq v' + VERSION + ' 起来了', {
      mode: channel.mode(),
      dataDir: dir,
      problems
    })
    if (problems.length > 0) log('warn', 'echo-qq: 配置有问题', { problems })

    // 先自报家门,再开店(顺序无所谓:注册只影响主包那道门)
    syncMouth()
    // 总闸/宿主服务都可能后变(主包可能比我们晚挂),所以每 5 秒对一次账。
    // unref:这条定时器不该拖着进程不退。
    ctx.effect(() => {
      const timer = setInterval(() => {
        reload().then(() => syncMouth()).then(() => syncListener()).catch(() => { })
      }, 5000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'echo-qq.mouth()')

    ctx.effect(() => channel.onOutbound(async (rows) => {
      const pushAt = Date.now()
      stats.pushes += 1
      stats.rows += Array.isArray(rows) ? rows.length : 0
      const client = await ensureClient()
      if (client === null) {
        // 没连接 ⇒ 一个字不发、也不回执(留给主包租约重发)—— 这一笔要留痕
        stats.dropped += 1
        return
      }
      const okIds = await deliver(rows)
      const sentAt = Date.now()
      if (okIds.length > 0) {
        await channel.ack(okIds)
        noteSent(pushAt, sentAt, Date.now())
      } else {
        noteSent(pushAt, sentAt, sentAt)
      }
    }), 'echo-qq.outbound()')

    // ---- 反向 WS:**运行期对账**(v0.42.0 审计修复 P1) ----
    // 原来 `start()` 只在挂载那一刻跑一次。面板上把总闸从"关"拨到"开"(或补上
    // accessToken)之后,5 秒那一轮只重读配置 + 自报家门,**永远不会去起监听** ——
    // 看着是开的,其实根本没在听;契约里写着"关着就只挂页面,连 WS 都不监听",
    // 反过来同样该成立(开着就得真在听)。现在每轮对账:
    //   该听没听 ⇒ 起;不该听却在听 ⇒ 停;host/port/token 变了 ⇒ 先停再起。
    let listenerOn = false
    let listenerKey = ''
    let listenerBusy = false
    let disposed = false
    const wantKey = () => (settings !== null && settings.enabled === true && String(settings.accessToken ?? '') !== '')
      ? [settings.host, settings.port, settings.accessToken].join('\u0001')
      : ''

    /** 起监听(带退避重试):成功 true,放弃 false。 */
    async function startListener () {
      const client = await ensureClient()
      if (client === null) return false
      // 切换期容错:6199 可能还被 AstrBot 占着(2026-09-28 实测:那个端口归 AstrBot 的
      // python 后端)。**不能就此认命** —— 退避重试,让"先关 AstrBot 再重启"与
      // "先重启再关 AstrBot"两种顺序都走得通(每 15s 一次,最多 5 分钟)。
      // 一条进程只能占一个端口,所以这里永远只有一个嘴在听(切换期的双保险不是双发)。
      for (let tries = 1; tries <= BIND_MAX_TRIES; tries++) {
        if (disposed) return false
        try {
          await client.start()
          if (!disposed) log('info', 'echo-qq: 反向 WS 起来了' + (tries > 1 ? '(第 ' + tries + ' 次尝试)' : ''))
          return true
        } catch (err) {
          const last = tries >= BIND_MAX_TRIES
          log('warn', 'echo-qq: 反向 WS 起不来(第 ' + tries + '/' + BIND_MAX_TRIES + ' 次): '
            + String(err?.message ?? err)
            + (last ? ' —— 放弃重试;腾出端口后重启 dsh web' : ' —— ' + (BIND_RETRY_MS / 1000) + 's 后重试'))
          if (last) return false
          await new Promise((resolve) => {
            const t = setTimeout(resolve, BIND_RETRY_MS)
            if (typeof t.unref === 'function') t.unref()
          })
          // 先把半死的 server 收干净再起新的(start() 对 listening 幂等,但失败的
          // 那次会留下一个没绑上的 server 对象)。
          try { await client.stop() } catch { /* 没起来过就算了 */ }
        }
      }
      return false
    }

    /** 一次对账:把"该不该听"落成"在不在听"。 */
    async function syncListener () {
      if (listenerBusy || disposed) return
      const key = wantKey()
      if (key === '') {
        if (!listenerOn) return
        contentState.epoch += 1
        contentState.scopes.clear()
        groupAwake.stop()
        groupHistory.clear()
        groupContext.clear()
        forwardCache.clear()
        fileReceipts.clear()
        listenerBusy = true
        try {
          try { await onebot?.stop?.() } catch { /* 已经停了 */ }
          listenerOn = false
          listenerKey = ''
          log('info', 'echo-qq: 反向 WS 停了(总闸关了或没 accessToken)—— 只挂页面,不监听连接')
        } finally { listenerBusy = false }
        return
      }
      if (listenerOn && key === listenerKey) return
      listenerBusy = true
      try {
        if (listenerOn) {
          contentState.epoch += 1
          contentState.scopes.clear()
          groupAwake.stop()
          groupHistory.clear()
          groupContext.clear()
          forwardCache.clear()
          fileReceipts.clear()
          try { await onebot?.stop?.() } catch { /* 已经停了 */ }
          listenerOn = false
          listenerKey = ''
        }
        if (await startListener()) {
          listenerOn = true
          listenerKey = key
        }
      } finally { listenerBusy = false }
    }

    syncListener().catch(() => {})

  }).catch((err) => {
    log('warn', 'echo-qq: 启动失败', { error: String(err?.message ?? err) })
  })

  // ---- QQ 空间通道的自报家门 + Cookie 保活（2026-10-15）--------------------
  //
  // 纪律 ④：**本插件不注册工具**。这里只把通道**提供**出去（`ctx.provide`），
  // 工具（`echo_qzone_post` 那几个）仍住在主包 —— 与 `echo_qq_say`/`echo_qq_call`
  // 同一条分工线。主包不在时，这个服务没人消费，但通道与保活照常跑
  // （空间能力不依赖主包，这正是"与聊天解耦"的含义）。
  let qzoneProvided = false

  try {
    ctx.provide(QZONE_SERVICE_NAME, {
      version: QZONE_SERVICE_VERSION,
      /** 契约自报：消费端先读它做能力探测（照 `echo:relay` 的 `hello()` 口径）。 */
      hello: () => ({
        name: QZONE_SERVICE_NAME,
        version: QZONE_SERVICE_VERSION,
        capabilities: [...QZONE_CAPABILITIES]
      }),
      /**
       * 当前状态（含保活记账）。
       *
       * ★ 2026-10-18：多带一个 `bridge` —— 桥现在是**插件起的子进程**了，
       * 「桥到底活着没 / 重启了几次 / 上次为什么退」必须能从一处看到。
       * 以前桥是开机自启的独立进程，插件对它一无所知（那正是"孤儿"的来源）。
       */
      status: () => ({ ...qzone.status(), bridge: bridge.status() }),
      /** 探活 + 取昵称。 */
      loginInfo: () => qzone.loginInfo(),
      /** 读说说列表。 */
      listMoods: (opts) => qzone.listMoods(opts),
      /** ★ 发说说。`whoCanSee` 必填（或走面板默认值）—— 见 lib/qzone.js 纪律②。 */
      postMood: (opts) => qzone.postMood(opts),
      /** 删说说。 */
      deleteMood: (tid) => qzone.deleteMood(tid),
      /**
       * ★ 2026-10-19：**回复空间评论**。
       * 白名单闸在 `qzone.js` 的 `replyComment` 里（配置所在地），主包只转发。
       */
      replyComment: (opts) => qzone.replyComment(opts),
      /**
       * ★ 2026-10-20：**读某条说说下的评论**。
       * 补 replyComment 的眼 —— 它要 tid + targetUin，原来没人能读出来。
       */
      listComments: (opts) => qzone.listComments(opts),
      /**
       * ★ 2026-10-20：**读好友动态**（只读，按 qzoneWatchList 过滤）。
       */
      listFeeds: (opts) => qzone.listFeeds(opts),
      /** 手工触发一次 Cookie 续期（面板按钮 / 排障用）。 */
      refreshCookie: () => qzone.refreshOnce('manual'),
      /** 这个通道认识哪些 action（给排障看）。 */
      actions: () => [...QZONE_ACTIONS],
      /**
       * ★ 2026-10-19：订阅**空间评论事件**（`kind:'master'|'space'`）。
       *
       * 主包注册它之后，评论文本才进得了她的上下文 / 记忆。
       * 没订阅 = 事件照收但没人消费（不报错，与"通道开了但主包不在"同一条纪律）。
       *
       * @param {(ev:{kind:'master'|'space', commentId:string, userId:string,
       *              userName:string, content:string, postTid:string, time:number}) => void} cb
       * @returns {() => void} 退订
       */
      onComment: (cb) => {
        if (typeof cb !== 'function') return () => {}
        commentSubs.add(cb)
        return () => { commentSubs.delete(cb) }
      },
      /** 评论事件的实时状态（连上没 / 收了几条 / 忽略了几条）。 */
      commentStatus: () => qzoneEvents.status()
    })
    qzoneProvided = true
    log('info', 'echo-qq: 空间服务已提供 — ' + QZONE_SERVICE_NAME + ' v' + QZONE_SERVICE_VERSION)
  } catch (err) {
    // 挂不上不影响嘴：聊天那条路一个字都不动
    log('warn', 'echo-qq: 空间服务挂不上(' + QZONE_SERVICE_NAME + ')—— 不影响聊天:'
      + String(err?.message ?? err))
  }

  // Cookie 保活：开就起、关就停（现读配置 ⇒ 面板拨完下一拍生效，不用重启）。
  ctx.effect(() => {
    let running = false
    const sync = () => {
      const want = settings !== null && settings.qzoneEnabled === true
      if (want && !running) {
        const r = qzone.start()
        running = r.ok === true
        // 通道开了 ⇒ 评论事件也连上（两者都依 qzoneEnabled，单独控制没意义）
        if (running) ensureQzoneEvents().catch(() => {})
      } else if (!want && running) {
        qzone.stop()
        running = false
        try { qzoneEvents.stop() } catch { /* 停不掉就算了 */ }
        commentWired = false
        log('info', 'echo-qq: 空间通道关了 —— Cookie 保活已停')
      }
    }
    sync()
    // 配置是"现读"的：给一个低频对账，别让面板拨了开关却要重启才生效。
    const t = setInterval(sync, 30000)
    if (typeof t.unref === 'function') t.unref()
    return () => {
      try { clearInterval(t) } catch { /* 已经没了 */ }
      qzone.stop()
    }
  }, 'echo-qq.qzoneCookieKeeper()')

  // ---- 自带那一页 + 状态 JSON ----
  ctx.effect(() => webServer.register({
    kind: 'exact', path: '/api/echo-qq/settings',
    handler: async (req, res) => {
      const result = await handleSettingsRequest({ method: req.method, headers: req.headers,
        body: req.method === 'POST' ? await readJsonBody(req) : undefined, dir, reload })
      return json(res, result.status, result.payload)
    }
  }), 'echo-qq.api.settings()')
  const webRoot = webRootOf(import.meta.url)
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/echo-qq',
    handler: createWebPageHandler({ rootDir: webRoot, prefix: '/echo-qq' })
  }), 'echo-qq.webpage()')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo-qq/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, reason: 'method-not-allowed' })
      try {
        await reload()
        const ch = channel === null ? null : channel.status()
        return json(res, 200, {
          ok: true,
          version: VERSION,
          name,
          enabled: settings.enabled === true,
          dataDir: dir,
          configProblems: problems,
          host: settings.host,
          port: settings.port,
          allowlistSize: settings.allowedUsers.length,
          accessTokenSet: String(settings.accessToken ?? '') !== '',
          heartbeatMs: settings.heartbeatMs,
          connection: lastState,
          client: (onebot === null ? null : safeCall(() => onebot.status())),
          channel: ch,
          timing: summarizeTiming({ ...stats, skippedNoClient: Number(ch?.counters?.skippedNoClient ?? 0) }),
          mouth: { registered: mouthRegistered, serviceAvailable: serviceOf(ctx) !== null },
          serviceName: SERVICE_NAME,
          // 2026-10-15:空间通道（第二条上游）—— 与聊天解耦，单独一格
          qzone: {
            provided: qzoneProvided,
            serviceName: QZONE_SERVICE_NAME,
            ...qzone.status(),
            // ★ 2026-10-20：**白名单要能看见**。
            //   他改了 config.json 的 qzoneWatchList 之后，这页/这个接口
            //   什么都看不出来（qzone.status() 只报通道与保活）⇒ 他以为没生效。
            //   现在按**解析后的数组**返回，人眼一比对就知道读没读到。
            watchList: [...parseWatchList(settings === null ? '' : settings.qzoneWatchList)],
            watchListRaw: settings === null ? '' : String(settings.qzoneWatchList ?? ''),
            // ★ 空间桥的进程状态（起没起 / 重启几次 / 上次怎么退）。
            //   以前这里也没有 —— 查"孤儿进程占端口"时只能靠进程快照猜。
            bridge: bridge.status()
          }
        })
      } catch (err) {
        return json(res, 500, { ok: false, reason: String(err?.message ?? err) })
      }
    }
  }), 'echo-qq.api.status()')

  // ---- 空间白名单的写口（2026-10-20）--------------------------------------
  //
  // 他要的是「设置界面能改 qzoneWatchList」。⚠️ 它改的不是主包的
  // `~/.dsh/echo/config.json`（那份由 dsh-echo 的 settings-fields.js 管），
  // 而是**本插件的** `~/.dsh/echo-qq/config.json` ⇒ 必须在本插件里开口，
  // 写进主包字段表等于写到另一个文件，面板改了也不生效。
  //
  // 纪律三条：
  //   ① 只认 POST，且必须带 `x-echo-qq-edit: 1`（防别的页面顺手 POST，同主包那条）
  //   ② 只允许改 `qzoneWatchList` 这一个键 —— 这不是通用配置写口
  //   ③ 写完立刻 `reload()`，值 ≤1 秒就进活视图（本来也是每 5 秒刷一次）
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/echo-qq/qzone-watchlist',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method-not-allowed' })
      if (String(req.headers['x-echo-qq-edit'] ?? '') !== '1') {
        return json(res, 403, { ok: false, reason: 'missing-edit-header' })
      }
      const body = await readJsonBody(req)
      if (body === null) return json(res, 400, { ok: false, reason: 'bad-json' })
      const raw = body.qzoneWatchList
      if (raw !== undefined && typeof raw !== 'string' && !Array.isArray(raw)) {
        return json(res, 400, { ok: false, reason: 'bad-type' })
      }
      // 数组 ⇒ 逗号串（与 parseSettings 的归一化同一套；直接传数组也行，但我们自己先归一）
      const next = raw === undefined ? '' : (Array.isArray(raw) ? raw.join(',') : String(raw))
      try {
        await saveSettings({ qzoneWatchList: next }, dir)
      } catch (err) {
        return json(res, 500, { ok: false, reason: 'write-failed', error: String(err?.message ?? err) })
      }
      await reload()
      const parsed = [...parseWatchList(settings === null ? '' : settings.qzoneWatchList)]
      log('info', 'echo-qq: 空间评论白名单已更新', { count: parsed.length })
      return json(res, 200, {
        ok: true,
        watchList: parsed,
        watchListRaw: settings === null ? '' : String(settings.qzoneWatchList ?? '')
      })
    }
  }), 'echo-qq.api.qzoneWatchList()')


  // ---- 自己的收尾 ----
  ctx.effect(() => () => {
    contentState.disposed = true
    contentState.epoch += 1
    contentQueue.dispose()
    groupAwake.stop()
    groupHistory.clear()
    groupContext.clear()
    try { fileSendService.dispose() } catch { /* 关闭新提交，不影响旧文本收尾 */ }
    forwardCache.clear()
    fileReceipts.clear()
    contentState.seen.clear()
    contentState.scopes.clear()
    disposed = true // 让正在退避重试的 syncListener 别再往上起新连接
    try { if (mouthRegistered && mouthOff !== null) mouthOff() } catch { /* 摘不掉也不影响卸载 */ }
    mouthRegistered = false
    try { channel?.dispose() } catch { }
    try { qzone.stop() } catch { /* 空间通道没起过就算了 */ }
    try { onebot?.stop?.() } catch { }
  }, 'echo-qq.dispose()')
}

function safeCall (fn) {
  try { return fn() } catch { return null }
}

function safeJson (v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}

/**
 * ★ 2026-10-20：读一个小的 JSON 请求体（本插件第一个写接口要用）。
 *
 * 上限 **64 KB** —— 这个接口只收几个 QQ 号；再多一律当"太大"拒掉，
 * 免得有人拿它往插件进程里灌东西。
 *
 * @returns {Promise<object|null>} 解析失败 / 超限 ⇒ null
 */
function readJsonBody (req, limitBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) { finish(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8').trim()
        finish(s === '' ? {} : JSON.parse(s))
      } catch { finish(null) }
    })
    req.on('error', () => finish(null))
  })
}
function json (res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

// 供单测/诊断直接引用(不出现在插件表里)
export { readPrivateEvent }
