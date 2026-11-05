/**
 * dsh-echo-qq — QQ 空间**评论事件**接收（2026-10-19）
 * ============================================================
 * 他拍的「方案 A」：不碰桥的 `src/`，只开桥的评论事件，由我们连出去收。
 *
 * ## 为什么是「连出去」而不是「让桥连进来」
 *
 * 桥支持两种方向：
 *   · **反向 WS**：桥连到我们（`ONEBOT_WS_REVERSE_URLS`）
 *   · **正向 WS**：我们连到桥（`server.ts:179-182` 开了 `/` `/api` `/event` `/ws`）
 *
 * ⚠️ **绝不能走反向 WS 连到 6199**。`lib/onebot.js:375-381` 的 `currentSocket()` 是
 *   「取**最后连上**的那个 OPEN 连接」：
 *       for (const entry of connections.values()) {
 *         if (entry.socket.readyState === 1) found = entry.socket   // 后者覆盖前者
 *       }
 *   桥若在 NapCat 之后连进 6199，发 `send_msg` 就会发给**桥**而不是 NapCat
 *   ⇒ QQ 消息全断。所以这里连**桥的正向 `/event`**（纯事件，不接受 API 帧）。
 *
 * ## 事件形状（桥 `poller.ts:414-434` `buildCommentEvent`）
 *
 *   { post_type:'notice', notice_type:'qzone_comment',
 *     user_id:<评论人 QQ>, sender_name:<昵称>, comment_id:<唯一 ID>,
 *     comment_content:<内容>, post_tid:<说说 ID>, post_uin:<说说主人>, time:<秒> }
 *
 * ## 三条纪律
 *
 * ① **只看 `qzone_comment`**：`meta_event` / 别的 notice 一律丢（桥还可能推新说说/点赞）。
 * ② **按 `comment_id` 去重**：桥自己已经去过重（`poller.ts:966-971`），但重连后它会把
 *    内存里没见过的当新的 —— 我们这边再兜一层，防重复感知。
 * ③ **白名单外的评论不产生任何行为**：不回复、不进记忆（他拍的）。
 *    主人单独走「用户通道」（`kind:'master'`），与白名单走「空间事件」（`kind:'space'`）。
 */

/** 桥推的评论通知类型。 */
export const QZONE_COMMENT_NOTICE = 'qzone_comment'

/** 去重表上限（内存，重启即清；桥那边才是主去重）。 */
const SEEN_MAX = 500

/**
 * 把一帧原始 WS 文本解析成「评论事件」。
 *
 * 纯函数 —— 不是 JSON、不是评论通知、没有 `comment_id`，一律返回 `null`。
 *
 * @param {string|object} frame
 * @returns {null | {commentId:string, userId:string, userName:string, content:string,
 *                   postTid:string, postUin:string, time:number}}
 */
export function parseQzoneCommentFrame (frame) {
  let obj = frame
  if (typeof frame === 'string') {
    if (frame === '') return null
    try { obj = JSON.parse(frame) } catch { return null }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (String(obj.post_type ?? '') !== 'notice') return null
  if (String(obj.notice_type ?? '') !== QZONE_COMMENT_NOTICE) return null
  const commentId = String(obj.comment_id ?? '').trim()
  if (commentId === '') return null   // 没有唯一 ID 就没法增量，宁可丢
  const userId = String(obj.user_id ?? '').trim()
  if (userId === '') return null
  return {
    commentId,
    userId,
    userName: String(obj.sender_name ?? '').trim(),
    content: String(obj.comment_content ?? '').trim(),
    postTid: String(obj.post_tid ?? '').trim(),
    postUin: String(obj.post_uin ?? '').trim(),
    time: Number(obj.time) || 0
  }
}

/**
 * 把配置里的白名单字符串解析成 Set（逗号/空格/分号分隔）。
 * @param {unknown} raw
 * @returns {Set<string>}
 */
export function parseWatchList (raw) {
  const out = new Set()
  for (const piece of String(raw ?? '').split(/[\s,;，、]+/)) {
    const v = piece.trim()
    if (/^\d{4,15}$/.test(v)) out.add(v)   // 只认像 QQ 号的
  }
  return out
}

/**
 * 决定一条评论事件该怎么处置。
 *
 * @param {{userId:string}} ev
 * @param {{masterId?:string, watchList?:Set<string>}} who
 * @returns {'master'|'space'|'ignore'}
 *   · `master` = 他本人 ⇒ 走**用户通道**（进 `capture.userText`，与 QQ 私聊同款）
 *   · `space`  = 白名单里的人 ⇒ 记成**空间事件**（进 `capture.qzoneComment`，不碰用户画像）
 *   · `ignore` = 其他人 ⇒ 不回复、不进记忆
 */
export function classifyComment (ev, who = {}) {
  const uid = String(ev?.userId ?? '')
  if (uid === '') return 'ignore'
  if (who.masterId && uid === String(who.masterId)) return 'master'
  if (who.watchList instanceof Set && who.watchList.has(uid)) return 'space'
  return 'ignore'
}

/**
 * 建一个空间评论事件接收器。
 *
 * 依赖全部注入 ⇒ **离线可测**（测试喂假 WebSocket）。
 *
 * @param {object} deps
 * @param {(url:string, opts:object) => any} deps.wsFactory 造 WebSocket（默认真的 ws）
 * @param {() => string} deps.url 现读（改了端口/令牌下一轮重连即生效）
 * @param {() => {masterId:string, watchList:Set<string>}} deps.who 现读白名单
 * @param {(ev:object) => void} [deps.onMaster] `kind:'master'`
 * @param {(ev:object) => void} [deps.onSpace]  `kind:'space'`
 * @param {(level:string, msg:string, extra?:object) => void} [deps.log]
 * @param {(fn:Function, ms:number) => any} [deps.setTimer]  默认 setTimeout
 * @param {(h:any) => void} [deps.clearTimer] 默认 clearTimeout
 * @param {number} [deps.reconnectMs]
 */
export function createQzoneEventClient ({
  wsFactory,
  url = () => '',
  who = () => ({ masterId: '', watchList: new Set() }),
  onMaster = () => {},
  onSpace = () => {},
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  reconnectMs = 5000
} = {}) {
  let socket = null
  let timer = null
  let running = false
  let attempts = 0
  const seen = []
  const seenSet = new Set()
  // ⚠️ 别把计数器叫 `connected` —— `status()` 里那个 `connected` 是**布尔**（现在连着没），
  //    同名字段被 `...stats` 展开覆盖过一次（测试当场抓到：布尔变成了 1）。
  const stats = {
    connects: 0, frames: 0, comments: 0, master: 0, space: 0,
    ignored: 0, dup: 0, bad: 0, lastError: '', lastAt: 0
  }

  function remember (id) {
    if (seenSet.has(id)) return false
    seenSet.add(id)
    seen.push(id)
    while (seen.length > SEEN_MAX) {
      const drop = seen.shift()
      if (drop !== undefined) seenSet.delete(drop)
    }
    return true
  }

  function handleFrame (raw) {
    stats.frames += 1
    const ev = parseQzoneCommentFrame(raw)
    if (ev === null) { stats.bad += 1; return }
    stats.comments += 1
    if (!remember(ev.commentId)) { stats.dup += 1; return }
    const kind = classifyComment(ev, who())
    stats.lastAt = Date.now()
    if (kind === 'master') { stats.master += 1; onMaster(ev); return }
    if (kind === 'space') { stats.space += 1; onSpace(ev); return }
    stats.ignored += 1
  }

  function scheduleReconnect () {
    if (!running) return
    if (timer !== null) return
    attempts += 1
    const wait = Math.min(reconnectMs * attempts, 60000)
    timer = setTimer(() => {
      timer = null
      connect()
    }, wait)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function connect () {
    if (!running) return
    const target = String(url() ?? '')
    if (target === '') {
      stats.lastError = 'no-url'
      scheduleReconnect()
      return
    }
    let socketRef = null
    try {
      socketRef = wsFactory(target, {})
    } catch (err) {
      stats.lastError = String(err?.message ?? err)
      scheduleReconnect()
      return
    }
    socket = socketRef
    try {
      socket.on('open', () => {
        attempts = 0
        stats.connects += 1
        stats.lastError = ''
        log('info', 'qzone-events: 已连上空间的评论事件流')
      })
      socket.on('message', (data) => { handleFrame(typeof data === 'string' ? data : String(data)) })
      socket.on('error', (err) => {
        stats.lastError = String(err?.message ?? err)
        log('warn', 'qzone-events: 连接出错 — ' + stats.lastError)
      })
      socket.on('close', () => {
        socket = null
        if (running) log('info', 'qzone-events: 连接断开，准备重连')
        scheduleReconnect()
      })
    } catch (err) {
      stats.lastError = String(err?.message ?? err)
      scheduleReconnect()
    }
  }

  return {
    start () {
      if (running) return false
      running = true
      connect()
      return true
    },
    stop () {
      running = false
      if (timer !== null) { clearTimer(timer); timer = null }
      const s = socket
      socket = null
      if (s && typeof s.close === 'function') {
        try { s.close() } catch { /* 关不掉就算了 */ }
      }
      return true
    },
    /** 供测试/诊断直接把一帧喂进来（不走网络）。 */
    feed: handleFrame,
    status () {
      return {
        running,
        connected: socket !== null,
        url: String(url() ?? ''),
        ...stats,
        seen: seenSet.size
      }
    }
  }
}

/**
 * 现读配置拼出连桥的 URL。
 *
 * 桥的鉴权（`server.ts:25-32`）认两种：`Authorization: Bearer <token>`
 * 或 `?access_token=<token>`。这里用查询参数 —— WebSocket 握手头部不好加，
 * 而查询参数在浏览器的限制之外、`ws` 包也照收。
 *
 * @param {{host:string, port:number, token:string}} cfg
 * @returns {string}
 */
export function bridgeEventUrl (cfg = {}) {
  // ⚠️ 这里**不写默认 host/port** —— 地址一律来自 `config.js` 的 `qzoneHost`/`qzonePort`
  //    （`nohardcode` 闸对这两样是有意收紧的：能写死一次就能写死第二次）。
  const host = String(cfg.host ?? '').trim()
  const port = Number(cfg.port)
  if (host === '' || !(port > 0)) return ''
  const token = String(cfg.token ?? '').trim()
  const base = `ws://${host}:${port}/event`
  return token === '' ? base : base + '?access_token=' + encodeURIComponent(token)
}
