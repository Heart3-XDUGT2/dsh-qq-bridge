/**
 * 渠道接缝 —— **本插件是消费端**,主包是提供端。
 *
 * **唯一的路 = 服务注入**(2026-09-28 起):主包在 ⇒ `ctx.get('echo:relay')` 拿得到 ⇒
 * 她要说的话**直接推**过来,零轮询,出站段延迟从"平均 ~1000 ms / 最差 ~2000 ms
 * (旧桥 AstrBot 2 s 轮询)"降到个位数毫秒。
 *
 * 旧的 **HTTP 兜底**已随"旧桥完整退役"于 2026-09-28 拆除,这里没有第二条路可退 ——
 * 主包不在,就是 `none`(她根本说不了话)。为什么必须拆掉,而不是"留着以防万一":
 *   ① 那条路打的几个主包 HTTP 端点**已经不存在了**(主包 `lib/index.js` 里已无该路由)
 *      ⇒ 它永远不可能成功;
 *   ② 它**只会骗人** —— 服务注入不可用时它去打一堆 404/401,状态里却还显示"HTTP 轮询(兜底)",
 *      让人以为还有条备胎。一条永远失败、还谎报存在的路,比没有路更危险。
 *
 * 为什么用 `ctx.get` 而不是 `export const inject = ['echo:relay']`:
 *   `inject` 的语义是"等服务出现才激活" —— 主包若一直不提供,本插件**永远不激活**。
 *   `ctx.get` 才是"在就用,不在就退"(证据:
 *   `cordis/lib/types/reflect.d.ts:7/115` —— "Read a service from the store without the
 *   inject requirement")。
 *
 * 服务契约(**主包侧 `ctx.provide('echo:relay', …)` 已照它实现**,见主包
 * `lib/index.js` 的 S3 那一段;消费端只**能力探测**,不硬性要求后两项):
 *   {
 *     version: 1,
 *     hello?() -> {name, version, api:{min,max}, capabilities:string[]}   // 契约自报(2026-09-28 加)
 *     inject(envelope) -> {ok, reason?}     // 私聊来信进管道(主包九步:白名单/幂等/入队/ensureCompanion…)
 *     subscribeOutbound(fn) -> dispose       // "有活儿"了叫一声(**只喊信号,不带正文** —— 见下)
 *     ack(ids) -> {rows?}                    // 送达确认:主包据此销账、想念 ×0.5
 *     lease({platform, limit, leaseSec}) -> {items, ...}  // **现取**她要说的话(平台自己那份队列)
 *     registerChannel?(ch) -> dispose        // 可选:渠道自报家门(注册后主包 hasChannel() 不再依赖旧桥总闸)
 *     status() -> object                     // 面板/健康(2026-09-28 起**追加** api/capabilities,老键不动)
 *     selftest?() -> {ok, checks[], note}    // 干跑自检(无副作用)
 *   }
 * ⚠️ 判定口径(2026-09-28):**以能力名为准**(`probeService` 算 `REQUIRED_CAPABILITIES - have`),
 *   **版本只做文案**;老主包没有 `hello()` ⇒ 降级对账 + warning,**不拒**(单向宽容:
 *   两个仓独立发布,拒载会把发布顺序锁死)。
 * ⚠️ 为什么推送**不带正文**、而要消费端再 `lease` 一次(2026-09-28 定):
 *   正文必须只留在出站队列那一份账上 —— 租约、销账、`held`(DSH 窗口里说的话不自动发到 QQ)、
 *   想念 ×0.5 全靠那份账。推送要是把正文捎过来,渠道就等于绕过租约直接发,重发/双发就回来了。
 *   所以推送 = "有活儿"(带 `rows` **计数**),取行 = `lease`(按平台取,天然分渠)。
 * 字段以主包 `lib/relay.js:107-148`(入站信封)与 `lib/relay.js:775`(lease)为准。
 * 跨仓没有共享常量,靠主包 `tests/relay-service.test.js` 与这里各钉一次字面量。
 */

export const SERVICE_NAME = 'echo:relay'
export const SERVICE_VERSION = 1

/**
 * 我们**硬要求**的能力(少一样 = 她说不了话):入站 / 现取行 / 销账 / "有活儿"通知。
 * 判定以**能力名**为准(Cortico 那种"版本不符即拒载"会把两仓发布顺序锁死,见
 * `docs/PLAN_CORTICO_ADOPTION.md` §3A2)。
 */
export const REQUIRED_CAPABILITIES = Object.freeze(['inject', 'lease', 'ack', 'subscribeOutbound'])
/** 有更好、没有只降级的:少 `registerChannel` ⇒ 主包以为她没嘴;少 `status` ⇒ 面板少一块。 */
export const EXPECTED_CAPABILITIES = Object.freeze(['registerChannel', 'status'])
/** 我们认得的主包契约区间(`api.max` = 提供端说到第几版:1 老形状,2 加 hello/selftest)。 */
export const API_RANGE = Object.freeze({ min: 1, max: 2 })

/** 我们只收私聊(个人机器人),平台名与主包渠道表里的 `platform` 一致。 */
export const PLATFORM = 'qq'
/** 一次取多少行、租约多长(主包侧同默认)。 */
export const OUTBOX_LIMIT = 20
export const OUTBOX_LEASE_SEC = 30
/** `nextDueAt` 的跟进定时器封顶(泡与泡之间是秒级,不用等太久;封顶只是防呆)。 */
export const FOLLOWUP_MAX_MS = 60000

/**
 * 走哪条路(settings.transport):`auto` 自动挑 / `service` 严格只走服务注入。
 * 服务注入是**唯一**的路,所以两者现在的行为一致(有服务就 `service`,没有就 `none`);
 * 枚举里留着 `service` 只是为了兼容旧配置与验收脚本的写法。
 */
export const TRANSPORTS = Object.freeze(['auto', 'service'])

/**
 * 主包的服务句柄 —— **每次现取**(主包后起也能自动接上)。
 * 单独导出,是因为插件接线(S3-b 的"自报家门")也要用它,不该只活在 createChannel 里。
 * 形状不对(没有 `inject`)就当作"没有主包",`mode()` 于是是 `none`。
 */
export function serviceOf (ctx) {
  try {
    const s = ctx?.get ? ctx.get(SERVICE_NAME) : null
    if (s === null || s === undefined) return null
    if (typeof s.inject !== 'function') return null
    return s
  } catch { return null }
}

/**
 * 契约探测(**纯函数**,好单测)。三种输入都要认,因为两个仓是**独立发布**的:
 *   ① 老主包(没有 `hello()`):只有"看得见 inject"这一个证据 ⇒ 可用,但标 `legacy`,
 *      按**看到的方法**降级对账 —— **不拒**(单向宽容:拒了就等于"主包比我旧,我罢工")。
 *   ② 新主包:能力名对账 + 版本区间对账。
 *   ③ 什么都没有:不可用(`echo_relay_unavailable`)。
 *
 * 返回 `ok:false` 只因为**必需能力名缺失**(硬失败);版本区间对不上只写进 `apiIssue` + `note`,
 * **绝不拒** —— 拒了就等于"主包比我新/旧,我罢工",那正是 Cortico 锁死发布顺序的地方。
 * @param {any} svc `ctx.get('echo:relay')` 拿到的服务句柄
 */
export function probeService (svc) {
  if (svc === null || svc === undefined || typeof svc.inject !== 'function') {
    return {
      available: false, legacy: false, ok: false, code: 'echo_relay_unavailable',
      missing: [...REQUIRED_CAPABILITIES], softMissing: [], have: [], api: null, apiIssue: '',
      note: '没看到主包服务 ' + SERVICE_NAME
    }
  }
  let hello = null
  try { hello = typeof svc.hello === 'function' ? svc.hello() : null } catch { hello = null }
  const caps = Array.isArray(hello?.capabilities) ? hello.capabilities.map((x) => String(x)) : []
  const probeNames = ['inject', 'lease', 'ack', 'subscribeOutbound', 'registerChannel', 'status', 'selftest']
  if (caps.length === 0) {
    const have = probeNames.filter((n) => typeof svc[n] === 'function')
    const missing = REQUIRED_CAPABILITIES.filter((n) => !have.includes(n))
    const softMissing = EXPECTED_CAPABILITIES.filter((n) => !have.includes(n))
    return {
      available: true, legacy: true, ok: missing.length === 0,
      code: missing.length > 0 ? 'echo_relay_capability_missing' : '',
      missing, softMissing, have, api: null, apiIssue: '',
      note: missing.length > 0
        ? '主包少能力:' + missing.join(',')
        : '主包没有 hello():按看到的方法降级对账(老版本,建议升级主包)'
    }
  }
  const have = caps
  const missing = REQUIRED_CAPABILITIES.filter((n) => !have.includes(n))
  const softMissing = EXPECTED_CAPABILITIES.filter((n) => !have.includes(n))
  const raw = hello?.api
  const api = (raw && typeof raw === 'object' && Number.isFinite(Number(raw.min)) && Number.isFinite(Number(raw.max)))
    ? { min: Number(raw.min), max: Number(raw.max) }
    : null
  // 版本只做文案:`too_new` = 主包说的契约比我们认得的新;`too_old` = 比我们认得的旧。
  let apiIssue = ''
  if (api !== null && api.min > API_RANGE.max) apiIssue = 'too_new'
  else if (api !== null && api.max < API_RANGE.min) apiIssue = 'too_old'
  let note = ''
  if (missing.length > 0) note = '主包少能力:' + missing.join(',')
  else if (apiIssue === 'too_new') note = '主包契约比本插件新(api.min ' + api.min + ' > ' + API_RANGE.max + '):建议升级本插件'
  else if (apiIssue === 'too_old') note = '主包契约比本插件旧(api.max ' + api.max + ' < ' + API_RANGE.min + '):建议升级主包'
  else if (softMissing.length > 0) note = '可用,但少可选能力:' + softMissing.join(',')
  return {
    available: true, legacy: false, ok: missing.length === 0,
    code: missing.length > 0 ? 'echo_relay_capability_missing' : '',
    missing, softMissing, have, api, apiIssue, note
  }
}

/**
 * 主包的干跑自检(无副作用,见主包 `lib/relay.js` 的 `selftest`):包装一层,
 * 让"它挂了"表现为一条可读的结论,而不是把整个 status 接口带崩。
 * @param {any} svc
 */
function safeSelftest (svc) {
  try {
    return svc.selftest()
  } catch (err) {
    return { ok: false, checks: [], note: 'selftest 抛错:' + String(err?.message ?? err) }
  }
}

/**
 * 该不该"自报家门"(**纯函数**,便于单测)。三种结果:`register` / `unregister` / `idle`。
 *
 * 规则:**自己的总闸开着**(装上 ≠ 开了)+ 主包服务在 ⇒ 报;任一不成立 ⇒ 撤。
 * 为什么关了要**撤回**而不是不管:主包拿它当"她有没有嘴"的判据(工具注册、提示词、
 * 入站那道门) —— 一条已经关掉的嘴还挂在那儿,主包就会以为她够得到他。
 */
export function registrationAction ({ enabled = false, serviceAvailable = false, registered = false } = {}) {
  const want = enabled === true && serviceAvailable === true
  if (want && registered !== true) return 'register'
  if (!want && registered === true) return 'unregister'
  return 'idle'
}

/**
 * 出站行的字段名**宽容解析**:主包 `store.relayLeaseOutbox` 的行字段以 S2-b 对齐为准,
 * 在那之前两种常见写法都认(主包自己也有同款先例:`lease` 参数名打错也认)。要改只改这一个函数。
 */
export function normalizeOutboundRow (row) {
  const r = (row && typeof row === 'object') ? row : {}
  const chat = (r.chat && typeof r.chat === 'object') ? r.chat : {}
  const id = String(r.id ?? r.outboxId ?? r.out_id ?? '').trim()
  const chatId = String(r.chatId ?? chat.id ?? r.peerId ?? r.to ?? '').trim()
  const text = String(r.text ?? r.content ?? r.body ?? '')
  // 2026-10-15 加群聊：这一泡要发到**群**还是**私聊**？
  // ⚠️ 主包的 lease item **现在还没带这个字段**（`store.js` 的 `relayLeaseOutbox`
  //    回的只有 id/chatId/kind/text/turnId/createdAt/notBefore/groupId/seq）——
  //    第 2 步会加上。**在此之前一律落回 `'private'`** ⇒ 今天的行为一字不变。
  //    两种写法都认（`chatType` / `chat_type`），与上面那句"两种常见写法都认"同一条纪律。
  const chatType = String(r.chatType ?? r.chat_type ?? chat.type ?? 'private').trim().toLowerCase() === 'group'
    ? 'group'
    : 'private'
  return { id, chatId, text, chatType, raw: r }
}

function rowsOf (payload) {
  const p = (payload && typeof payload === 'object') ? payload : {}
  for (const key of ['rows', 'items', 'messages', 'outbox']) {
    if (Array.isArray(p[key])) return p[key]
  }
  return []
}

/**
 * @param {object} opts
 * @param {any} opts.ctx               cordis 上下文(只用 ctx.get 做能力探测)
 * @param {object} opts.settings       lib/config.js 解析出来的设置
 * @param {(level:string,msg:string,extra?:any)=>void} [opts.log]
 * @param {() => number} [opts.now]
 * @param {() => boolean} [opts.canSend]  现在有连接吗(缺省恒真);见 canSendNow 的注释
 */
export function createChannel ({ ctx, settings, log = () => {}, now = () => Date.now(), canSend = null } = {}) {
  let disposed = false
  /** 装上的"冲一遍积压"的动作(服务分支装的) —— 见 drain()。 */
  let kick = null
  const counters = { in: 0, out: 0, ack: 0, inRejected: 0, inRetried: 0, dup: 0, errors: 0, skippedNoClient: 0 }
  const state = { lastInboundAt: 0, lastOutboundAt: 0, lastSkipAt: 0, lastError: '', lastRejectReason: '' }

  /**
   * 现在真的能发出去吗(有没有活着的连接)。缺省恒真。
   * 为什么要在**取行之前**问一句:取行就是**占一轮租约**(主包据此记账、销账靠 ack);
   * 发不出去还去取,等于白占 30 秒 —— 话没丢(租约过期会重发),但白白晚一轮。所以:发得出去才取行。
   */
  const canSendNow = () => {
    try { return typeof canSend === 'function' ? canSend() === true : true } catch { return true }
  }

  /** 主包的服务句柄(实现见 serviceOf;每次现取 —— 主包后起也能自动接上)。 */
  function serviceHandle () {
    return serviceOf(ctx)
  }

  /**
   * 这一轮该走哪条路。**只有两种可能**:
   *   service:主包服务在(唯一的路)
   *   none   :服务不在 ⇒ 她根本说不了话(旧桥的 HTTP 兜底已于 2026-09-28 退役,没有第二条路)
   * settings.transport(`auto` / `service`)不再改变结果 —— 只有一条路可挑。
   */
  function mode () {
    return serviceHandle() !== null ? 'service' : 'none'
  }

  /** 这一轮真的走服务吗(严格模式必须被尊重,否则"验收零轮询"就是假的)。 */
  const useService = () => mode() === 'service'

  /**
   * 主包拒了这条入站 —— **把理由留下来**。
   * 2026-09-28 真机踩过:理由只在日志里"喊"了一声(而宿主 stdout 我看不见),
   * 于是只能翻数据库反推"到底卡在哪一步"(结论是主包 `relay.js:341` 的 `not-master`)。
   * 理由必须能在 `/api/echo-qq/status` 里看见 —— 猜一次就够了。
   */
  function noteReject (r) {
    const reason = String(r?.reason ?? r?.detail ?? 'unknown')
    state.lastRejectReason = reason
    log('info', 'echo-qq: 主包没接这条入站', { reason })
  }

  /** 入站:一条私聊来信交给主包。返回主包的判定原样(不吞理由 —— "她为什么不回"要在日志里看得见)。 */
  async function injectOnce (envelope, execution) {
    const svc = mode() === 'service' ? serviceHandle() : null
    if (svc === null) {
      // 说人话:别让人以为"是不是还有条兜底没配" —— 唯一的路就是服务注入。
      return { ok: false, reason: '没有可用的主包通道:服务注入不在(旧桥的 HTTP 兜底已于 2026-09-28 退役)' }
    }
    const r = execution ? await svc.inject(envelope, execution) : await svc.inject(envelope)
    return r ?? { ok: false, reason: '主包没给判定' }
  }

  /**
   * 这条失败**值得再试一次**吗?(名单是白名单:不在里面的一律不重试)
   *   `agent-busy`        —— 她正在跑别的活;主包回这个之前会 `relayRollbackInbound`
   *                          (撤掉受理记录),"按 msgId 重试"是它写明的期待。
   *   `agent-unavailable` —— 暂时性的(引擎侧车没起、她刚重启)。
   *   `permission-unavailable` —— 陪伴会话的权限预设还没就位(宿主刚起),几秒后就位。
   *   `scope-off`         —— **启动窗口那一瞬**:门 = "有没有渠道插件自报家门",
   *                          宿主先起、我们后到(自报家门最迟 5 秒一轮),这中间的来信
   *                          若不重试就是"她刚醒、你说话她没听见"。6 次退避≈22 秒,覆盖得住。
   * 不值得试的:形状不对、不是主人、群聊、重复 —— 再试一万次也一样。
   */
  const RETRYABLE = new Set(['agent-busy', 'agent-unavailable', 'permission-unavailable', 'scope-off'])
  function worthRetry (r) {
    if (r === null || typeof r !== 'object' || r.ok === true) return false
    return RETRYABLE.has(String(r.reason ?? ''))
  }

  /**
   * 入站(带重试):**不重试就等于"她忙着的时候,你说的话悄悄没了"**。
   * 2026-09-28 真机第一次跑就撞上:他那 6 条里恰有 1 条落在她跑轮次的时候,
   * 主包 503 `agent-busy` —— 旧适配器有 `inbound_retry_times`(6 次 / 约 22s 窗口),
   * 头一版漏搬了。幂等靠 msgId,重试安全(重复会回 `duplicate: true` = 已收)。
   */
  async function inject (envelope, { isCurrent } = {}) {
    const execution = typeof isCurrent === 'function' ? { isCurrent } : undefined
    const times = Number(settings?.inboundRetryTimes) > 0 ? Number(settings.inboundRetryTimes) : 1
    const base = Number(settings?.inboundRetryBaseMs) > 0 ? Number(settings.inboundRetryBaseMs) : 1500
    let last = null
    for (let attempt = 1; attempt <= times; attempt++) {
      if (typeof isCurrent === 'function') {
        let current = false
        try { current = isCurrent() === true } catch { /* fail closed */ }
        if (!current) { last = { ok: false, reason: 'inbound-cancelled' }; break }
      }
      try {
        last = await injectOnce(envelope, execution)
      } catch (err) {
        counters.errors += 1
        state.lastError = String(err?.message ?? err)
        log('warn', 'echo-qq: 入站投递抛错', { error: state.lastError, attempt })
        last = { ok: false, reason: state.lastError }
      }
      if (last?.ok === true) {
        counters.in += 1
        if (last.duplicate === true) counters.dup += 1
        state.lastInboundAt = now()
        return last
      }
      if (!worthRetry(last) || attempt >= times) break
      counters.inRetried += 1
      log('info', 'echo-qq: 主包这会儿没空,按 msgId 重试', { reason: last.reason, attempt, of: times })
      await new Promise((r) => setTimeout(r, base * attempt))
    }
    counters.inRejected += 1
    noteReject(last)
    return last ?? { ok: false, reason: 'unknown' }
  }

  /**
   * 出站:主包叫一声"有活儿",我们**现取**自己平台那份队列,发完 ack。
   * handler 收到**已归一化**的行数组;返回"成功送达的 id 数组"用来 ack。
   *
   * 唯一的路 = 服务注入:取行就是 `svc.lease`(按平台取,天然分渠)。
   * 服务不在(没有 `subscribeOutbound`)⇒ 什么都不挂,也**不假装**有条路。
   */
  function onOutbound (handler) {
    const svc = useService() ? serviceHandle() : null
    if (svc !== null && typeof svc.subscribeOutbound === 'function') {
      let followup = null
      /**
       * 走一轮:取行 → 交给发送端 → (到点了再走一轮)。
       *
       * `nextDueAt` 是**下一泡什么时候到点**(`store.js` 的 `relayLeaseOutbox` 里算的;
       * 旧适配器靠它决定"这次取完隔多久再来")。我们零轮询,所以改成**到点自己再来一轮** ——
       * 否则同一组后面的泡要等他下一次说话才动,"手里这泡发完就停"的节奏就断了。
       */
      const round = async () => {
        if (disposed) return
        if (!canSendNow()) { counters.skippedNoClient += 1; state.lastSkipAt = now(); return }
        if (typeof handler !== 'function') return
        let list = []
        let dueAt = 0
        if (typeof svc.lease === 'function') {
          const leased = await svc.lease({ platform: PLATFORM, limit: OUTBOX_LIMIT, leaseSec: OUTBOX_LEASE_SEC })
          list = rowsOf(leased).map(normalizeOutboundRow).filter((r) => r.id !== '' && r.chatId !== '')
          dueAt = Number(leased?.nextDueAt ?? 0)
        }
        if (list.length > 0) {
          state.lastOutboundAt = now()
          counters.out += list.length
          await handler(list)
        }
        if (Number.isFinite(dueAt) && dueAt * 1000 > Date.now() && !disposed) {
          if (followup !== null) clearTimeout(followup)
          const waitMs = Math.min(Math.max(50, dueAt * 1000 - Date.now()), FOLLOWUP_MAX_MS)
          followup = setTimeout(() => { followup = null; round().catch(() => {}) }, waitMs)
          if (typeof followup.unref === 'function') followup.unref()
        }
      }
      // 连上 NapCat 之后要能把"刚才没发出去的"冲一遍(见 drain):推送只在新话出现时来,
      // 积压的泡(比如重启前留下的、或同一组还没到点的那几泡)得有人叫一声。
      kick = round
      const dispose = svc.subscribeOutbound(async (payload) => {
        try {
          // 推送里**直接带正文**的写法(数组或 {rows:[…]})也认:那就直接发,不必再取。
          const direct = Array.isArray(payload) ? payload.map(normalizeOutboundRow) : []
          if (direct.length > 0) {
            state.lastOutboundAt = now()
            counters.out += direct.length
            await handler(direct)
            return
          }
          await round()
        } catch (err) {
          counters.errors += 1
          state.lastError = String(err?.message ?? err)
          log('warn', 'echo-qq: 出站处理失败(行留给主包租约过期后重发)', { error: state.lastError })
        }
      })
      return () => {
        kick = null
        if (followup !== null) { clearTimeout(followup); followup = null }
        if (typeof dispose === 'function') dispose()
      }
    }
    // 服务不在 / 没有 subscribeOutbound ⇒ 没得挂(唯一的路就是服务注入)
    return () => {}
  }

  /** 送达确认:只有真的出去了才 ack(主包据此销账;漏 ack = 主包租约到期重发,宁可重不可丢)。 */
  async function ack (ids) {
    const list = Array.isArray(ids) ? ids.filter((x) => String(x ?? '').trim() !== '') : []
    if (list.length === 0) return { ok: true, acked: 0 }
    const svc = useService() ? serviceHandle() : null
    try {
      if (svc !== null && typeof svc.ack === 'function') {
        const r = await svc.ack(list)
        counters.ack += list.length
        return { ok: true, acked: list.length, rows: r?.rows ?? [] }
      }
      return { ok: false, reason: 'no-channel', acked: 0 }
    } catch (err) {
      counters.errors += 1
      state.lastError = String(err?.message ?? err)
      log('warn', 'echo-qq: ack 失败(主包会按租约重发)', { error: state.lastError, count: list.length })
      return { ok: false, reason: state.lastError, acked: 0 }
    }
  }

  function status () {
    const svc = serviceHandle()
    // transport 的合法值只有 auto|service(旧配置里的 http 由 config.js 落回 auto;这里再兜一道)。
    const want = String(settings?.transport ?? 'auto').trim().toLowerCase()
    return {
      mode: mode(),
      transport: want === 'service' ? 'service' : 'auto',
      serviceAvailable: svc !== null,
      serviceVersion: svc === null ? null : (Number(svc.version) || null),
      // 契约对账(能力名 + 版本区间):面板/验收要能一眼看出"是主包旧了还是我旧了"
      contract: probeService(svc),
      // 主包的干跑自检(无副作用):让验收/面板看到"链路在、契约形状没坏"。
      // 老主包没有 selftest ⇒ null(不是 fail —— 降级,由 contract.legacy 那条警告提示升级)。
      selftest: (svc !== null && typeof svc.selftest === 'function') ? safeSelftest(svc) : null,
      lastInboundAt: state.lastInboundAt,
      lastOutboundAt: state.lastOutboundAt,
      lastError: state.lastError,
      lastRejectReason: state.lastRejectReason,
      counters: { ...counters }
    }
  }

  function dispose () {
    disposed = true
  }

  /**
   * 冲一遍积压:现在就走一轮出站(取行 → 发 → 回执)。
   * 用途只有一个且很关键:**NapCat 一接上就叫一声** —— 不然"她早说好的那几泡"
   * 要等他下一次说话才动(真机第一次就留了一泡在队列里没人取)。
   */
  function drain () {
    const k = kick
    return typeof k === 'function' ? Promise.resolve(k()).catch(() => {}) : Promise.resolve()
  }

  return { inject, onOutbound, ack, status, mode, dispose, drain }
}
