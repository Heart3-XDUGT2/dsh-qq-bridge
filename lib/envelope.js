/**
 * QQ 事件 → 主包信封。
 *
 * **字段的唯一真源是主包** `lib/relay.js:107-148` 的 `parseEnvelope` —— 那里要什么,
 * 这里就造什么;形状对不上主包会整条拒掉(而且理由写得很清楚,便于查):
 *   { v:1, platform:'qq', chat:{id,type,title}, sender:{id,name,isMaster}, text, images, msgId, ts }
 *
 * ★ 2026-10-21：多了 `atMe` / `atOthers`（@ 感知）。
 *   **刻意不动 `text`** —— 见 `atHintsOfSegments` 上面那段长注释。
 *
 * 两条纪律:
 *   ① **群聊一律不构造** —— 主包 v0.29.0 起"群行是死行",我们连造都不造,不指望下游拦;
 *   ② `msgId` 必须带 —— 主包的幂等靠它(同一条消息重投两次,她只该说一次)。
 */
import { isAtMe } from './group-awake.js'
import { filesOfSegments } from './file-content.js'
import { normalizeGroupContext } from './group-context.js'

export const PLATFORM = 'qq'

/** 文本上限与主包一致量级:`relay.js` 的 MAX_TEXT(超了主包会拒)。 */
export const MAX_TEXT = 2000

/** 一封入站信最多带几张图(与主包 `relay.js` 的 MAX_IMAGES 同值:多的丢)。 */
export const MAX_IMAGES = 4

/**
 * 段字段读取器:**两种形状都认**。
 *
 * 这条是 2026-09-29 踩出来的 —— 第一版只读了 `seg.data.url`,而**生产里段是平铺的**:
 * `lib/onebot.js` 的 `normalizeSegment()` 已经把原始 OneBot 段
 * (`{type:'image', data:{url}}`)归一成 `{type:'image', url, file}` 才交给 `onEvent`。
 * 于是 `imagesOfSegments` 在真机上永远返回空 —— 而单元测试是绿的(夹具照的是原始
 * 形状),典型的假绿。现在两种形状都读,并且有用例拿**真 onebot 归一化路径**钉住。
 *
 * @param {object} seg 一段
 * @param {string} key 字段名(text / url / file / name …)
 */
function fieldOf (seg, key) {
  if (seg === null || typeof seg !== 'object') return ''
  const flat = seg[key]
  if (flat !== undefined && flat !== null && flat !== '') return String(flat)
  const data = (seg.data && typeof seg.data === 'object') ? seg.data : null
  if (data !== null) {
    const nested = data[key]
    if (nested !== undefined && nested !== null && nested !== '') return String(nested)
  }
  return ''
}

/**
 * OneBot 的 message 段 → 主包要的图记(形状对齐 `relay.js` 的 `parseImages`:
 * `url` / `path` / `file` / `data` + `name`,按 url > path > data 的优先级认)。
 *
 * 2026-09-29(S2-b):他现场说「我在 qq 发图片,貌似是无法识别的」—— 那时这一步
 * **还没接**:图片段被降级成正文里的「［图片］」四个字,她只能知道自己收到过一张图,
 * 看不到图。主包那一侧(抓取 / 体积上限 / MIME 嗅探 / 存附件 / 注入)早就完整,
 * 缺的只是这里把 OneBot 的图段**原样带过去**。
 *
 * 纪律:认不出来的段(没有 url 也没有 file)**不在这里发明** —— 留给
 * `textOfSegments` 的「［图片］」标记:宁可她只看到文字痕迹,也不发一个形状不对的
 * 段让主包把整条信拒掉(整条被拒 = 他连字都白打了)。
 */
export function imagesOfSegments (segments) {
  if (!Array.isArray(segments)) return []
  const out = []
  for (const seg of segments) {
    if (out.length >= MAX_IMAGES) break
    if (seg === null || typeof seg !== 'object') continue
    if (String(seg.type ?? '') !== 'image') continue
    const item = {}
    const url = fieldOf(seg, 'url').trim()
    if (url !== '') item.url = url
    // OneBot 的 `file` 常常是 bot 主机上的本地路径(与 DSH 同机时有用),
    // 也可能是 `file:///…`;识别不了的话主包会按"抓不到"记账,不会静默。
    const file = fieldOf(seg, 'file').trim()
    if (file !== '') item.file = file
    const name = (fieldOf(seg, 'name') || fieldOf(seg, 'filename')).trim().slice(0, 80)
    if (name !== '') item.name = name
    // ★ 2026-10-20：**表情包标记也要带过去**（他提的「表情包不要描述一通」）。
    //   `sub_type`（0=普通图 / 1=表情包）与 `summary`（如 `[动画表情]`）是 OneBot 的既有字段，
    //   上游 `onebot.js` 已经取回来了，这里再收一道 —— 不然主包那边照样判不出来。
    const subType = fieldOf(seg, 'sub_type').trim()
    if (subType !== '') {
      const n = Number(subType)
      if (Number.isFinite(n)) item.sub_type = n
    }
    const summary = fieldOf(seg, 'summary').trim().slice(0, 40)
    if (summary !== '') item.summary = summary
    if (item.url === undefined && item.file === undefined) continue
    out.push(item)
  }
  return out
}

/**
 * 已归一化的图记再收一遍口(给 `buildPrivateEnvelope` 的调用方用:谁都能递图,
 * 但只有"能当来源用"的才进信封)。
 */
function normalizeImageRefs (list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const one of list) {
    if (out.length >= MAX_IMAGES) break
    if (one === null || typeof one !== 'object' || Array.isArray(one)) continue
    const item = {}
    for (const key of ['url', 'path', 'file', 'data']) {
      const v = String(one[key] ?? '').trim()
      if (v !== '') item[key] = v
    }
    const name = String(one.name ?? '').trim().slice(0, 80)
    if (name !== '') item.name = name
    // ★ 2026-10-20：表情包标记同样不许在这一道被吃掉
    if (one.sub_type !== undefined && one.sub_type !== null && one.sub_type !== '') {
      const n = Number(one.sub_type)
      if (Number.isFinite(n)) item.sub_type = n
    }
    const summary = String(one.summary ?? '').trim().slice(0, 40)
    if (summary !== '') item.summary = summary
    if (item.url === undefined && item.path === undefined && item.file === undefined && item.data === undefined) continue
    out.push(item)
  }
  return out
}

/** 033：仅收件事实；音频地址、路径、字节长度均不成为转写或时长。 */
export function voicesOfSegments (segments) {
  if (!Array.isArray(segments)) return []
  const out = []
  for (const seg of segments) {
    if (out.length >= 4) break
    if (seg?.type !== 'record') continue
    const duration = seg.durationSeconds ?? seg.data?.durationSeconds
    out.push({
      received: true,
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
        ? { durationSeconds: duration } : {})
    })
  }
  return out
}

function receivedVoices (raw, segments) {
  if (!Array.isArray(raw)) return voicesOfSegments(segments)
  return raw.filter(one => one?.received === true).slice(0, 4).map(one => ({
    received: true,
    ...(typeof one.durationSeconds === 'number' && Number.isFinite(one.durationSeconds) && one.durationSeconds >= 0
      ? { durationSeconds: one.durationSeconds } : {})
  }))
}

function forwardedContent (raw) {
  if (!raw || raw.source !== 'qq-forward-quote') return null
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const notices = Array.isArray(raw.notices) ? raw.notices.filter(note => typeof note === 'string' && note !== '') : []
  const images = normalizeImageRefs(raw.images)
  if (nodes.length === 0 && notices.length === 0 && images.length === 0) return null
  return { ...raw, nodes, notices, images }
}

/** 034：只传收件元数据；QQ地址/文件ID留在渠道收件表。 */
function receivedFiles (raw, segments, source) {
  const values = Array.isArray(raw) ? raw : filesOfSegments(segments, source)
  return values.filter(one => one?.received === true).slice(0, 2).map(one => ({
    received: true, name: typeof one.name === 'string' ? one.name.slice(0, 240) : '',
    ...(Number.isSafeInteger(one.declaredSize) && one.declaredSize >= 0 ? { declaredSize: one.declaredSize } : {}),
    ...(typeof one.declaredType === 'string' ? { declaredType: one.declaredType.slice(0, 100) } : {}),
    ...(typeof one.ref === 'string' && /^[0-9a-f]{32}$/i.test(one.ref) && typeof one.label === 'string'
      ? { ref: one.ref.toLowerCase(), label: one.label.slice(0, 43) } : {})
  }))
}

/**
 * 把一个**私聊或群聊**事件变成主包信封（2026-10-15 加群聊）。
 *
 * @param {object} o
 * @param {'private'|'group'} [o.chatType] 默认 private（老调用方一字不用改）
 * @param {string} [o.groupId] chatType==='group' 时必填 —— 信封的 `chat.id` 用它
 *
 * ⚠️ **信封形状一字未变**（`contract.js` 顶部写明字段以主包 `relay.js:107-148` 为准）：
 *    群聊只是 `chat.type` 从 `'private'` 变成 `'group'`、`chat.id` 从 userId 变成 groupId。
 *    主包 `parseEnvelope` 本来就认这两个（`relay.js:128`）。
 *
 * @returns {{ok:true,envelope:object}|{ok:false,reason:string}}
 */
export function buildPrivateEnvelope ({
  userId, userName = '', messageId, text = '', images = [], ts = 0, isMaster = false,
  chatType = 'private', groupId = '',
  // ★ 2026-10-18：群聊**唤醒补档**正文（见 `lib/group-history.js`）。
  //   只在一件事上非空：主人 @ 她把她叫醒的那一刻，把"她休眠期间群里说过什么"
  //   附在这条消息旁边。**它不是她说的话、也不是他说的**，所以单独一个字段 ——
  //   塞进 `text` 会让主包把它当成"他说了这些"，进记忆就全错。
  historyDigest = '',
  // ★ 2026-10-21：**@ 感知**。段和她的号传进来，由 `atHintsOfSegments` 算出
  //   `atMe` / `atOthers` 两个**独立字段**（不进 `text`，理由见那个函数的注释）。
  segments = [], selfId = '', voices = null, forwardContent = null, files = null, groupContext = null
} = {}) {
  const isGroup = String(chatType ?? 'private') === 'group'
  // 群聊的会话 id 是**群号**，不是说话人的号 —— 一条群会话要认得出来
  const id = isGroup ? String(groupId ?? '').trim() : String(userId ?? '').trim()
  if (id === '') return { ok: false, reason: isGroup ? 'groupId 必填' : 'userId 必填' }
  const msgId = String(messageId ?? '').trim()
  if (msgId === '') return { ok: false, reason: 'msgId 必填(幂等要用)' }
  const body = String(text ?? '').trim()
  if (body.length > MAX_TEXT) return { ok: false, reason: 'text 过长(上限 ' + MAX_TEXT + ')' }
  const pics = normalizeImageRefs(images)
  const voiceFacts = receivedVoices(voices, segments)
  const forward = forwardedContent(forwardContent)
  const fileFacts = receivedFiles(files, segments, {
    chatId: id, chatType: isGroup ? 'group' : 'private', senderId: String(userId ?? '').trim(), isMaster
  })
  // 2026-09-29:一个字不打只发一张图,也是话 —— 与主包同一条规矩
  // (`relay.js`:`text 不能为空(除非他发的是图)`)。图片-only 以前在这里就被拒了。
  if (body === '' && pics.length === 0 && voiceFacts.length === 0 && forward === null && fileFacts.length === 0) {
    return { ok: false, reason: 'text 不能为空(除非他发的是图)' }
  }
  return {
    ok: true,
    envelope: {
      v: 1,
      platform: PLATFORM,
      // 群聊：chat.id = 群号；私聊：chat.id = 他的号（原样）
      chat: { id, type: isGroup ? 'group' : 'private', title: '' },
      // ★ sender 永远是**说话的那个人**（群里也一样）——
      //   主包据 `sender.isMaster` 判"这话是不是他说的"（决定进不进记忆）。
      sender: {
        id: String(userId ?? '').trim(),
        name: String(userName ?? '').trim().slice(0, 40),
        isMaster: isMaster === true
      },
      text: body,
      // S2-b 已接(2026-09-29):图段的形状由 `imagesOfSegments` 对齐主包;
      // 这里再收一遍口(上限 4、只留能当来源用的键)。
      images: pics,
      ...(voiceFacts.length > 0 ? { voices: voiceFacts } : {}),
      ...(forward !== null ? { forwardContent: forward } : {}),
      ...(fileFacts.length ? { files: fileFacts } : {}),
      msgId,
      ts: Number(ts) || 0,
      ...(isGroup && normalizeGroupContext(groupContext, id)
        ? { groupContext: normalizeGroupContext(groupContext, id) } : {}),
      // ★ 2026-10-21：@ 感知（独立字段，**不动 `text`**）。
      //   只有真有 @ 段时才带 —— 没 @ 时信封形状与从前逐位一致。
      ...(() => {
        const at = atHintsOfSegments(segments, selfId)
        if (!at.atMe && at.atOthers.length === 0) return {}
        const others = at.atOthers.slice(0, 8)
        const broadcast = at.atOthers.find(a => a.qq === 'all' || a.qq === '0')
        if (isGroup && broadcast && !others.some(a => a.qq === 'all' || a.qq === '0')) others[7] = broadcast
        return {
          atMe: at.atMe,
          atOthers: others,  // 显示最多8个；尾部广播也必须保留。
          // 只给群聊加可选判定标志；在裁剪前检查完整目标，未知身份不能作确定否定。
          ...(isGroup ? {
            atMeKnown: /^[1-9]\d*$/.test(String(selfId ?? '').trim())
              && (at.atMe || segments.every(seg => String(seg?.type ?? '') !== 'at'
                || /^(?:all|\d+)$/.test(fieldOf(seg, 'qq').trim())))
          } : {})
        }
      })(),
      // 群聊唤醒补档；私聊恒空（私聊没有"群休眠"这回事）
      ...(isGroup && String(historyDigest ?? '').trim() !== ''
        ? { historyDigest: String(historyDigest).trim().slice(0, 4000) }
        : {})
    }
  }
}

/**
 * OneBot 的 message 段数组 → 纯文本。
 * 支持的段:text / image / face / at / reply;其余段原样忽略(不炸、也不猜)。
 *
 * 2026-09-29(S2-b):**能当图送过去的段不再在正文里写「［图片］」** ——
 * 她真的会看到那张图(主包注入时会附上"看到几张/几张没看到"的实况行),
 * 正文里再写一遍是重复劳动,还会让她以为"只有个标记、没图"。
 * 送不过去的(没有 url/file 的怪段)照旧留标记:别让"他发过一张图"这件事静静消失。
 */
export function textOfSegments (segments) {
  if (typeof segments === 'string') return segments
  if (!Array.isArray(segments)) return ''
  const parts = []
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue
    const type = String(seg.type ?? '')
    if (type === 'text') parts.push(fieldOf(seg, 'text')) // 平铺(生产)与 data 嵌套(原始事件)都认
    else if (type === 'image') {
      if (imagesOfSegments([seg]).length === 0) parts.push('［图片］')
    } else if (type === 'face') parts.push('［表情］')
    // at / reply 不进文本:主包关心的是他说了什么,不是标记
  }
  return parts.join('').trim()
}

/**
 * ★ 2026-10-21：**@ 感知** —— 一条消息里"@ 了她"和"@ 了哪些别人"。
 *
 * ## 为什么单开一个函数，而不是往 `text` 里塞
 *
 * `env.text` 有三处消费者，塞 `@你` 会把它们一起弄坏：
 *   ① `text === ''` 是「他单发图/表情 ⇒ 这条不用回」的判据（`index.js` 的 `noReply`）
 *      —— 一条 "@她 + 一张图" 会因此不再被当成"没写字"；
 *   ② `rawText`（`index.js` 注入时带的 `source.rawText`）是**记忆检索的查询词**
 *      —— 塞标记进去会污染召回；
 *   ③ 审计 `relay_in` 的 `user_input` 也用它。
 *
 * ⇒ 所以 `text` 保持干净，@ 走**独立字段**，由主包渲染正文时另拼一句。
 *
 * ## 判据复用
 *
 * `atMe` 直接用 `group-awake.js` 的 `isAtMe` —— **不写第二份**。
 * （`group-history.js:56-65` 也是这么干的：先拍平再交给它。）
 *
 * @param {Array<object>} segments 消息段（平铺 `{type,qq,name?}` 或原始嵌套 `{type,data:{qq}}` 都认）
 * @param {string} selfId 她的号（判"@ 的是不是她"）
 * @returns {{ atMe: boolean, atOthers: Array<{qq: string, name: string}> }}
 */
export function atHintsOfSegments (segments, selfId = '') {
  const out = { atMe: false, atOthers: [] }
  if (!Array.isArray(segments)) return out
  const me = String(selfId ?? '').trim()

  // 先拍平成 `{ type:'at', qq, name }`（兼容原始嵌套形状）
  const flat = []
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue
    if (String(seg.type ?? '') !== 'at') continue
    const rawQq = fieldOf(seg, 'qq').trim()
    // `@全体成员` 的 qq 是 `all`（或 0）—— Number('all') 是 NaN，保留原串
    const n = Number(rawQq)
    flat.push({
      type: 'at',
      qq: /^\d+$/.test(rawQq) && Number.isFinite(n) ? n : rawQq,
      name: fieldOf(seg, 'name').trim().slice(0, 40)
    })
  }

  out.atMe = isAtMe(flat, me)

  for (const a of flat) {
    const qq = String(a.qq ?? '').trim()
    if (me !== '' && qq === me) continue          // @ 她自己的那条不重复进 atOthers
    if (qq === '' && a.name === '') continue      // 两样都没有 = 没有信息量
    out.atOthers.push({ qq, name: a.name })
  }
  return out
}

/**
 * OneBot `post_type=message` 事件 → 我们关心的最小事实(纯函数,单测覆盖)。
 *
 * 2026-10-15 加群聊:私聊与群聊两条都读,并带出 `chatType` / `groupId` / `selfId`。
 * **不是私聊也不再一律拒** —— "这个群允不允许收"是 `allowsInbound` 的事,
 * "现在该不该收"是 `lib/group-awake.js` 的事。这里只回答"这一帧长什么样"。
 *
 * （名字保持 `readPrivateEvent` 不动:它是 `lib/index.js` 的**公开导出**(`:603`),
 *   改名是破坏性的。语义从"只读私聊"扩成"读私聊或群聊",下面带 `chatType` 自明。）
 */
export function readPrivateEvent (raw) {
  const r = (raw && typeof raw === 'object') ? raw : null
  if (r === null) return { ok: false, reason: '事件不是对象' }
  if (r.post_type !== 'message') return { ok: false, reason: '不是消息事件' }
  const chatType = r.message_type === 'group' ? 'group' : (r.message_type === 'private' ? 'private' : '')
  if (chatType === '') return { ok: false, reason: '不是私聊也不是群聊(guild/频道等不收)' }
  const userId = String(r.user_id ?? '').trim()
  if (userId === '') return { ok: false, reason: '缺 user_id' }
  const groupId = chatType === 'group' ? String(r.group_id ?? '').trim() : ''
  if (chatType === 'group' && groupId === '') return { ok: false, reason: '缺 group_id' }
  const messageId = String(r.message_id ?? '').trim()
  const selfId = String(r.self_id ?? '').trim()
  // 自己发的回声:OneBot 里 user_id === self_id 的消息不是"他说的"
  if (selfId !== '' && selfId === userId) return { ok: false, reason: '是自己的回声' }
  return {
    ok: true,
    event: {
      userId,
      userName: String(r.sender?.nickname ?? '').slice(0, 40),
      messageId,
      text: textOfSegments(r.message),
      segments: Array.isArray(r.message) ? r.message : [],
      // ★ 2026-10-15:这三项是下游分辨"群还是私聊 / 哪个群 / 她被 @了没"的全部依据。
      chatType,
      groupId,
      selfId,
      ts: Number(r.time) > 0 ? Number(r.time) * 1000 : Date.now()
    }
  }
}
