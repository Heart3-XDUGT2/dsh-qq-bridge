/**
 * OneBot v11 反向 WebSocket 客户端（私聊专用精简版）。
 *
 * 来源：dsh-qq-onebot-bridge v0.5.7 的 lib/onebot.js
 *       （上游：https://github.com/cheesehaqi/dsh-qq-onebot-bridge ，MIT）
 *       本文件是把它整块借来后做的 DIY 改造版本，不是原文件。
 * 许可：MIT，原版权行保留如下 ——
 *       Copyright (c) 2026 dsh-qq-onebot-bridge contributors
 *
 * 运行形态：我们在 127.0.0.1:<port> 上开一个 WebSocketServer，OneBot 实现
 * （NapCat / LLOneBot / Lagrange / go-cqhttp …）用 ws-reverse:// 主动连进来。
 * 反向 WS 下「重连」= 等 NapCat 再连回来，我们不主动重连、不重建任何东西。
 *
 * ============================ 改动清单 ============================
 * 相对 lib/onebot.js（672 行）的差异，逐条列出，便于区分「哪些是借的、哪些是
 * 我们自己写的」。
 *
 * 【删除】
 * 1. 删除 `export class OneBotServer extends EventEmitter` 这个对外导出与它的
 *    对外事件面（'message' / 'notice' / 'request' / 'bot-connect' /
 *    'bot-disconnect'），改为工厂函数 + onEvent / onState 回调。
 * 2. 删除 `parseNotice()`、`parseRequest()` 两个导出函数，以及 #onFrame 里的
 *    notice / request 分支：本插件只关心私聊消息事件，通知与请求不再上报。
 * 3. 删除全部群聊支持：不再有 messageType 分支、group_id 参数、
 *    send_group_msg / send_group_forward_msg / 群专用 action，也不再有
 *    基于 config.botQq 的 atMe / ats 判定（私聊没有 @ 判定）。非私聊
 *    （group / guild 等）在 #onFrame 里直接 return 忽略。
 * 4. 删除 60+ 个 action 封装方法（setGroupBan / setGroupKick / deleteMsg /
 *    setGroupCard / setGroupSpecialTitle / setGroupWholeBan / setGroupLeave /
 *    setEssenceMsg / deleteEssenceMsg / sendGroupNotice / setMsgEmojiLike /
 *    groupPoke / friendPoke / setInputStatus / getEmojiLikes / sendLike /
 *    markGroupMsgAsRead / markPrivateMsgAsRead / groupSign /
 *    getGroupAtAllRemain / getGroupShutList / getGroupInfoEx /
 *    getGroupIgnoredNotifies / kickGroupMembers / groupTodo / setGroupProfile /
 *    setGroupMemberPermissions / setGroupNewMemberHistoryVisibility /
 *    moveGroupFile / renameGroupFile / deleteGroupFile / createGroupFileFolder /
 *    uploadImageToQunAlbum / setGroupAddRequest / setFriendAddRequest /
 *    uploadFile / sendForwardMsg / getForwardMsg / getGroupMemberList /
 *    getGroupMemberInfo / getGroupInfo / getFriendList / getGroupHonorInfo /
 *    getGroupNotice / getEssenceMsgList / getGroupMsgHistory /
 *    getFriendMsgHistory / getGroupRootFiles / getGroupFilesByFolder /
 *    getGroupFileUrl / ocrImage / getQunAlbumList / getRecord / getVersionInfo /
 *    getStatus …），收窄为 6 个 action 的白名单，白名单外一律拒发。
 * 5. 删除 dry-run 调试机制（setDryRun / #inDryRunScope / takeDryRunCalls /
 *    dryRun / dryRunScope / dryRunCalls）：本插件不需要离线回放。
 * 6. 删除 parseMessage / stripCq 里 record（语音）、file（文件）、forward
 *    （合并转发卡片）、mface 的专门分支，以及配套的 ats / records / images /
 *    files / forwards 归一化字段；这些段类型现在只作为「其它段」保留原始结构。
 * 7. 删除 #call 里直写 console.error 的那一处（本文件一律走注入的 log，
 *    绝不直接 console.log / console.error）。
 * 8. 删除 #call 失败时 reject(抛异常) 的行为（见【修改】第 6 条）。
 *
 * 【新增】
 * 1. 新增 createOneBot() 工厂导出与新的导出形状（start / stop / status /
 *    call / sendPrivateMsg / sendPrivateMsgSegments / getLoginInfo）。
 * 2. 新增心跳/存活检测：start() 后每 heartbeatMs（默认 30000）发一次
 *    get_status action，连续 maxMisses（默认 3）次失败/超时后把 stale
 *    标为 true 并通过 onState 通知；心跳失败只累计计数与标记，绝不销毁
 *    任何状态（连接、待回包、计数器一律保留）。恢复成功后 stale 归位。
 *    心跳**用短超时**：call(action, params, { timeoutMs }) 的第三参为心跳服务，
 *    取值 max(300, min(heartbeatMs, 2000))，所以 stale 的判定时间 = heartbeatMs
 *    × maxMisses 量级（由配置决定），而不是被 action 默认超时拖着走。
 * 3. 新增状态机与 status() 字段：state（'listening' | 'client-connected' |
 *    'closed'）、clients、listening、lastEventAt、received、sent、
 *    rejectedAuth、rejected、stale、lastError。rejected 为本插件新增的
 *    「入站信封校验不通过」计数，stale 为心跳新增字段。
 * 4. 新增入站信封校验：非法 JSON / 非对象 / 缺 post_type / 缺 message_id /
 *    缺 user_id / 缺 message 字段 / 内容与段全空，一律丢弃并计入
 *    rejected，同时写一条带原因的日志（不做静默丢弃）。
 * 5. 新增恒定时间鉴权比较：node:crypto 的 timingSafeEqual，长度不等时先返回
 *    false（避免 timingSafeEqual 抛异常）；失败累计到 rejectedAuth。
 * 6. 新增 parseSegments() + normalizeSegment()：把 string（CQ 码）与 array
 *    （消息段数组）两种 message 统一归一化为 { text, segments }。支持的段：
 *    text / image / face / at / reply；其余段类型原样保留 { type, data }，
 *    不抛错、不丢帧。
 * 7. 新增 errorMessage() / writeLog() / safeInvoke() 三个小工具：日志函数或
 *    回调自身抛异常时不打断主流程。
 *
 * 【修改】
 * 1. 导出形状：由 `export class OneBotServer` 改为
 *    `export function createOneBot({...})`，返回普通对象（含上述 7 个方法）。
 * 2. 鉴权：保留 Authorization: Bearer <accessToken> 校验；比较方式由 `!==`
 *    改为恒定时间比较。accessToken 为空字符串时不校验（同原实现）。
 * 3. 断线语义：客户端断开只标记 offline —— state 回到 'listening'、clients
 *    计数归零，绝不 close/清空/重建 wss，也不清空 pending 之外的东西；
 *    原实现里销毁会话之类的行为一律不要。
 * 4. action 调用：由 `#call(socket, action, params)` 改为内部自动选取当前
 *    活跃连接（不再由调用方传 socket）；非白名单 action 直接拒绝。
 * 5. 连接与回包管理：`#connections` / `#pending` 私有字段改为闭包内的
 *    Map，连接 id 里保留原来的 remoteAddress:时间戳:序号 形状。
 * 6. 返回形状：超时、发送失败、远端 retcode !== 0 等一律 resolve 为
 *    `{ ok: false, error }`，不再 reject 抛异常。
 * 7. 日志：所有日志走注入的 log(level, message, extra?)，日志函数可为空。
 * 8. onEvent 只在「合法私聊消息」时被调用，负载为
 *    { userId, messageId, text, segments, raw, at, userName, ts }：前 6 个键
 *    按约定（语义：at 是我们收到的本地时间戳 ms，text 只含 text 段），后 2 个
 *    是**额外附加**的 —— 本仓库 lib/index.js 的 onEvent 会读 evt.userName /
 *    evt.ts 去造主包信封（形状对齐 lib/envelope.js 的 readPrivateEvent），
 *    不带上这两个键，入站名字为空、时间戳恒为 0。若契约要求严格 6 键，
 *    删掉 onFrame 里 userName / ts 两行与 bus.emit 的两个键即可，其余不受影响。
 * 9. onState 在状态或 stale 变化时被调用，负载为
 *    { state, clients, lastError, stale }：前 3 个按约定，stale 是为了满足
 *    「stale 变更也要通知」而多加的一个键。
 * 10. id 一律字符串：userId / messageId 由原来的 Number(...) 改为
 *    String(... ?? '').trim()，空串即拒（rejected +1，纪律不变）；出网的
 *    user_id 参数仍转数字（normalizeUserId 只管这件事），回执 messageId
 *    也 String() 化。新增 self_id 自回声判定（user_id === self_id 只忽略、
 *    不计 rejected），比较同样是字符串比较。
 *
 * 代码风格：ESM、2 空格缩进、分号、LF 行尾、UTF-8 无 BOM；注释简体中文，
 * 标识符英文；无 TypeScript、无类型注解。
 * =================================================================
 */
import { EventEmitter } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { fileNoticeEvent } from './file-content.js';
import { createFileUploadTransport } from './file-send.js';

/** 单条 action 的等待上限（毫秒），超时算失败。 */
const ACTION_TIMEOUT_MS = 10_000;
/** 心跳间隔默认值（毫秒）。 */
const DEFAULT_HEARTBEAT_MS = 30_000;
/** 连续失败多少次算 stale。 */
const DEFAULT_MAX_MISSES = 3;

/**
 * action 白名单：只有这 8 个能发出去，其余一律拒绝。
 * 原实现有 60+ 个封装方法，本插件只要私聊/群聊收发 + 少量只读查询。
 *
 * 2026-10-15 加 `get_cookies`（6 → 7）：给 **QQ 空间通道**（`lib/qzone.js`）续 Cookie 用。
 * 它**只读**（取当前登录态的 cookie），不改任何状态；空间那边真正会写库的
 * 动作（发/删说说）走的是**另一条 HTTP**（onebot-qzone 桥 :5700），
 * **不进这个白名单** —— 白名单继续保持"窄"。
 *
 * 2026-10-15 再加 `send_group_msg`（7 → 8）：群聊（他定：@唤醒 ⇒ 群里所有消息都回）。
 * ⚠️ **只加"发消息"这一个** —— 群管理那 60+ 个动作（禁言/踢人/改名片/退群…）
 * **一个都不加**。白名单仍然是"窄"的：**她能在群里说话，但管不了群。**
 */
const ALLOWED_ACTIONS = new Set([
  'send_private_msg',
  'send_group_msg',
  'get_login_info',
  'get_status',
  'get_version_info',
  'get_friend_list',
  'get_msg',
  // ★ 2026-10-18：群聊**唤醒时补拉休眠期间的历史**。
  //
  // 他只同意"醒来补档"，休眠时仍然一条都不碰（见 `lib/group-history.js` 顶部）。
  // 形状抄自容器内 NapCat 真机实现（`/app/napcat/napcat.mjs:76152-76188`）：
  //   params : { group_id: String, message_seq?: String, count: Number,
  //              reverse_order?: Boolean, reverseOrder?: Boolean, ... }
  //            `message_seq` 空/0 ⇒ 取**最新** count 条；默认排序 = 旧→新
  //   return : { messages: Array }  标准 OneBot message 对象
  //
  // ⚠️ 它是**只读**的（Go-CQHTTP 扩展 API），和那 60+ 个群管理动作不是一类 ——
  //   「她能在群里说话、但管不了群」那条纪律没有被破坏。
  'get_group_msg_history',
  // 033：仅新增已准入转发引用的只读展开，不开放任意OneBot动作。
  'get_forward_msg',
  // 034：仅当前准入文件的两种只读取链接口；get_file并非通用文件下载。
  'get_group_file_url',
  'get_private_file_url',
  'get_cookies',
]);

/** 把异常/任意值压成一句可读的错误文本。 */
function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/** 解开 CQ 码参数里的字符实体。 */
function decodeCqValue(value) {
  return String(value)
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** 把 `,key=value,key2=value2` 解析成对象。 */
function parseCqParams(rawParams) {
  const params = {};
  const text = String(rawParams ?? '').replace(/^,/, '');
  if (text === '') return params;
  for (const pair of text.split(',')) {
    if (pair === '') continue;
    const index = pair.indexOf('=');
    if (index === -1) {
      params[pair] = '';
      continue;
    }
    const key = pair.slice(0, index);
    if (key === '') continue;
    params[key] = decodeCqValue(pair.slice(index + 1));
  }
  return params;
}

/**
 * 归一化一个消息段。
 * 认识 text / image / mface / face / at / reply；其余类型保留原始结构（{ type, data }），
 * 不抛错、不丢段 —— 这就是「保留原始结构不要炸」。
 *
 * ★ 2026-10-20：**表情包要认得出来**（他提的「表情包不要描述一通」）。
 *
 *   · OneBot v11 的 image 段带 `sub_type`（0=普通图，1=表情包）与 `summary`
 *     （通常是 `[动画表情]` 这种）。原来这里只取 `url`/`file`，**两个字段被丢掉**，
 *     下游三层全都没得判 ⇒ 连表情包也当普通图正经描述一遍。
 *   · `mface`（QQ 大表情 / 商城表情）**原来走兜底 `{ type, data }`，下游没人认
 *     ⇒ 整段等于消失**：她既看不到图，也不知道他发过东西。
 *     现在把它**归一成 image 段并标成表情包**（`sub_type: 1`），
 *     于是"看图"这条路照旧走得通，只是按表情包对待。
 *
 * ⚠️ `export` 只是**给单测用**（`test/image-sticker.test.mjs`）—— 它不出现在
 *    插件对外接口里，也不该被 `index.js` 之外的代码当契约调用。
 */
export function normalizeSegment(type, data) {
  const params = data && typeof data === 'object' ? data : {};
  if (type === 'text') return { type: 'text', text: String(params.text ?? '') };
  if (type === 'image') {
    const seg = { type: 'image', url: String(params.url ?? ''), file: String(params.file ?? '') };
    // ★ 表情包标记：原样带过去（0/1 是 OneBot 的约定，不在这里发明新语义）
    //   非法值**丢掉** —— 宁可当普通图，也不许把 NaN 混进信封
    if (params.sub_type !== undefined && params.sub_type !== null && params.sub_type !== '') {
      const n = Number(params.sub_type)
      if (Number.isFinite(n)) seg.sub_type = n
    }
    const summary = String(params.summary ?? '').trim();
    if (summary !== '') seg.summary = summary;
    return seg;
  }
  if (type === 'mface') {
    // ★ mface = QQ 大表情。**当表情包**处理：归一成 image 段 + 标记 sub_type=1。
    //   不这么做它就掉进兜底分支、下游一个字段都不认，等于没收到。
    const summary = String(params.summary ?? '').trim();
    return {
      type: 'image',
      url: String(params.url ?? ''),
      file: String(params.file ?? ''),
      sub_type: 1,
      summary: summary !== '' ? summary : '[表情]',
    };
  }
  if (type === 'face') return { type: 'face', id: String(params.id ?? '') };
  if (type === 'at') {
    // all不能数值化成NaN；缺失/未知目标也不能数值化成0而冒充全体。
    const target = String(params.qq ?? '').trim();
    const seg = { type: 'at', qq: target === 'all' ? 'all' : (/^\d+$/.test(target) ? Number(target) : NaN) };
    // ★ 2026-10-21：**带上 name**（他拍的「乙方案」）。
    //
    //   OneBot v11 的 at 段标准只有 `qq`，但**有的实现（go-cqhttp / 某些 NapCat 版本）
    //   会多给一个 `name`**（被 @ 的人在这个群里的名片/昵称）。
    //   有就带着、没有就不带 —— 下游 `atHintsOfSegments` 按"有就用、没有降级 QQ 号"处理。
    //   **这是纯加法**：没 name 时段的形状与从前逐位一致。
    const atName = String(params.name ?? '').trim();
    if (atName !== '') seg.name = atName.slice(0, 40);

    // ★ 默认**关闭**的诊断开关：把 at 段的原始 params 打出来，
    //   用来回答"NapCat 到底发不发 name"（`ONEBOT_AT_PROBE=1` 才打）。
    //   留着而不是用完就删 —— 换个 NapCat 版本/换个人问同样的问题时还要用。
    if (process.env['ONEBOT_AT_PROBE'] === '1') {
      try {
        console.error('[at-probe] ' + JSON.stringify(params));
      } catch { /* 打不出来就算了，绝不影响收消息 */ }
    }
    return seg;
  }
  if (type === 'reply') return { type: 'reply', messageId: String(params.id ?? '') };
  if (type === 'record') {
    const duration = params.durationSeconds;
    return { type: 'record', received: true,
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { durationSeconds: duration } : {}) };
  }
  return { type, data: { ...params } };
}

/** 数组形式的一段 → 归一化段；结构不成立时返回 null。 */
function segmentFromRaw(segment) {
  if (!segment || typeof segment !== 'object') return null;
  const type = typeof segment.type === 'string' ? segment.type : '';
  if (type === '') return null;
  return normalizeSegment(type, segment.data);
}

/**
 * 把 OneBot 的 message 字段（CQ 码字符串或消息段数组）统一解析成
 * { text, segments }。text 只由 text 段拼成并压缩空白；at / reply 等不计入 text。
 */
function parseSegments(rawMessage) {
  const segments = [];
  if (typeof rawMessage === 'string') {
    const cqRe = /\[CQ:([A-Za-z_][A-Za-z0-9_]*)((?:,[^\]]*)?)\]/g;
    let cursor = 0;
    let match;
    while ((match = cqRe.exec(rawMessage)) !== null) {
      if (match.index > cursor) {
        const chunk = rawMessage.slice(cursor, match.index);
        if (chunk !== '') segments.push({ type: 'text', text: decodeCqValue(chunk) });
      }
      segments.push(normalizeSegment(match[1].toLowerCase(), parseCqParams(match[2])));
      cursor = match.index + match[0].length;
    }
    if (cursor < rawMessage.length) {
      const chunk = rawMessage.slice(cursor);
      if (chunk !== '') segments.push({ type: 'text', text: decodeCqValue(chunk) });
    }
  } else if (Array.isArray(rawMessage)) {
    for (const item of rawMessage) {
      const segment = segmentFromRaw(item);
      if (segment) segments.push(segment);
    }
  }
  const text = segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, segments };
}

/** 恒定时间比较两个字符串。两边先各自 sha256 再比：长度不等提前返回虽然不影响
 *  比较本身的恒定时间性，但会泄漏 token 长度上界 —— 两行能堵就堵。*/
function constantTimeEqual(expected, provided) {
  const left = createHash('sha256').update(String(expected ?? ''), 'utf8').digest();
  const right = createHash('sha256').update(String(provided ?? ''), 'utf8').digest();
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 从握手请求里取 Bearer token。 */
function extractBearer(request) {
  const header = request && request.headers ? request.headers.authorization : undefined; // pin-allow: NapCat→插件握手鉴权(凭证是本插件自己的 accessToken,方向与旧桥相反)
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim(); // pin-allow: 同上(OneBot 11 反向 WS 的 Authorization: Bearer 写法)
  return '';
}

/**
 * 发给 NapCat 的 user_id 参数转成数字（OneBot 惯例），转不成有限数就原样带回。
 * 注意：这只管「出网的参数」，我们对内/对外暴露的 id 一律是字符串。
 */
function normalizeUserId(userId) {
  const value = Number(userId);
  return Number.isFinite(value) ? value : userId;
}

/**
 * 创建一个 OneBot v11 反向 WS 客户端。
 *
 * @param {object} [options]
 * @param {string} [options.host] 监听地址，默认 127.0.0.1
 * @param {number} [options.port] 监听端口，默认 6700
 * @param {string} [options.accessToken] 非空时校验 Authorization: Bearer
 * @param {number} [options.heartbeatMs] 心跳间隔，默认 30000
 * @param {number} [options.maxMisses] 连续失败几次算 stale，默认 3
 * @param {Function} [options.log] 日志函数 log(level, message, extra?)
 * @param {Function} [options.onEvent] 私聊消息回调
 * @param {Function} [options.onState] 状态变化回调
 * @returns {{ start: Function, stop: Function, status: Function, call: Function,
 *             sendPrivateMsg: Function, sendPrivateMsgSegments: Function, getLoginInfo: Function }}
 */
export function createOneBot({
  host = '127.0.0.1',
  port = 6700,
  accessToken = '',
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  maxMisses = DEFAULT_MAX_MISSES,
  fileUploadTimeoutMs = 60000,
  log,
  onEvent,
  onState,
} = {}) {
  // 内部事件总线：借来 EventEmitter 的用法，把内部事件桥到注入的回调上。
  const bus = new EventEmitter();
  bus.on('error', () => {}); // 兜底，避免无监听者时 EventEmitter 直接抛
  bus.on('message', (event) => safeInvoke(onEvent, event));
  bus.on('state', (payload) => safeInvoke(onState, payload));

  const heartbeatPeriod = Number.isFinite(Number(heartbeatMs)) && Number(heartbeatMs) > 0
    ? Number(heartbeatMs)
    : DEFAULT_HEARTBEAT_MS;
  const missLimit = Number.isFinite(Number(maxMisses)) && Number(maxMisses) > 0
    ? Number(maxMisses)
    : DEFAULT_MAX_MISSES;

  let wss = null;
  let listening = false;
  let lastState = 'closed';
  let heartbeatTimer = null;
  let heartbeatBusy = false;

  let echoSeq = 0;
  let connectionSeq = 0;
  const connections = new Map();
  const pending = new Map();
  let fileGeneration = 0;
  // 037-A只处理已验证字节的上传；真实QQ来源/会话额度由后续核心层组合。
  // 文件请求有独立pending，不能进入普通call的错误JSON或文本重试路径。
  const fileUploads = createFileUploadTransport({
    timeoutMs: fileUploadTimeoutMs,
    connectionOf: () => {
      if (!listening) return null;
      let found = null;
      for (const entry of connections.values()) if (entry.socket.readyState === 1) found = entry;
      return found;
    },
    isConnectionCurrent: binding => listening && binding?.generation === fileGeneration
      && binding.socket?.readyState === 1
      && [...connections.values()].some(entry => entry === binding),
  });

  let stale = false;
  let missCount = 0;
  let received = 0;
  let sent = 0;
  let rejected = 0;
  let rejectedAuth = 0;
  let lastEventAt = null;
  let lastError = null;

  /** 写日志；log 可以没注入，日志函数自己抛错也不影响主流程。 */
  function writeLog(level, message, extra) {
    if (typeof log !== 'function') return;
    try {
      log(level, message, extra);
    } catch {
      // 日志函数自身出错，忽略
    }
  }

  /** 调用外部回调；回调抛错只记一条日志。 */
  function safeInvoke(fn, payload) {
    if (typeof fn !== 'function') return;
    try {
      fn(payload);
    } catch (error) {
      writeLog('warn', `OneBot 回调抛出异常: ${errorMessage(error)}`);
    }
  }

  /** 由 listening + 连接数推导 state（断开只回 listening，绝不销毁任何东西）。 */
  function refreshState() {
    const next = !listening ? 'closed' : (connections.size > 0 ? 'client-connected' : 'listening');
    if (next !== lastState) {
      lastState = next;
      writeLog('info', `OneBot 状态: ${next}（连接数 ${connections.size}）`);
    }
    return lastState;
  }

  /** 广播状态（含 stale 变更时的手动调用）。 */
  function publishState() {
    refreshState();
    bus.emit('state', { state: lastState, clients: connections.size, lastError, stale });
  }

  /** 当前第一个处于 OPEN 的客户端连接（取最新连上的那个）。 */
  function currentSocket() {
    let found = null;
    for (const entry of connections.values()) {
      if (entry.socket.readyState === 1) found = entry.socket; // 1 = OPEN
    }
    return found;
  }

  /** 收下一帧 action 回包。 */
  function settle(response) {
    const key = String(response.echo);
    const item = pending.get(key);
    if (!item) return;
    pending.delete(key);
    clearTimeout(item.timer);
    if (response.status === 'ok' && response.retcode === 0) {
      item.resolve({ ok: true, data: response.data });
      return;
    }
    item.resolve({ ok: false, error: `OneBot action ${item.action} 失败: ${JSON.stringify(response)}` });
  }

  /** 入站帧处理：回包 → 私聊消息，其余忽略。 */
  function onFrame(socket, data) {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      rejected += 1;
      writeLog('warn', 'OneBot 入站帧不是合法 JSON，已丢弃', { rejected });
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      rejected += 1;
      writeLog('warn', 'OneBot 入站帧不是对象，已丢弃', { rejected });
      return;
    }
    if (frame.echo !== undefined) {
      if (fileUploads.handleResponse(socket, frame)) return;
      settle(frame);
      return;
    }
    if (typeof frame.post_type !== 'string' || frame.post_type === '') {
      rejected += 1;
      writeLog('warn', 'OneBot 入站帧缺少 post_type，已丢弃', { rejected });
      return;
    }
    if (frame.post_type === 'notice') {
      const notice = fileNoticeEvent(frame);
      if (notice.ok) {
        const at = Date.now();
        received += 1;
        lastEventAt = at;
        // 精确的两类文件通知复用原准入/群醒/队列，不开放其它notice。
        bus.emit('message', { ...notice.event, raw: frame, at });
      }
      return;
    }
    if (frame.post_type !== 'message') return; // request / meta_event等仍忽略
    // 2026-10-15 加群聊：私聊与群聊两条都收；其余（guild / 频道等）照旧忽略。
    // ⚠️ **这里只做"事件形状"的判据**（这一帧长什么样），
    //    "这个群允不允许收"是 `allowsInbound` 的事，"现在该不该收"是
    //    `lib/group-awake.js` 的事 —— 三层分开，谁也别抢谁的活。
    const chatType = frame.message_type === 'group' ? 'group'
      : (frame.message_type === 'private' ? 'private' : '');
    if (chatType === '') return; // guild / 频道 / 其它一概忽略
    const kindLabel = chatType === 'group' ? '群' : '私聊';
    // 对内/对外暴露的 id 一律是字符串（对齐本仓库 lib/envelope.js 的
    // readPrivateEvent / buildPrivateEnvelope，它们都 String() 化）：
    // userId / messageId 都 String().trim()，空串即拒（与「缺字段就 rejected」同一条纪律）。
    const messageId = String(frame.message_id ?? '').trim();
    if (messageId === '') {
      rejected += 1;
      writeLog('warn', 'OneBot ' + kindLabel + '消息缺少 message_id，已丢弃', { rejected });
      return;
    }
    // 群消息的会话 id 是 group_id；私聊是 user_id。
    // 两个都按字符串外露（`groupId` 单独给一份，主包按它当 chat.id）。
    const groupId = chatType === 'group' ? String(frame.group_id ?? '').trim() : '';
    if (chatType === 'group' && groupId === '') {
      rejected += 1;
      writeLog('warn', 'OneBot 群消息缺少 group_id，已丢弃', { rejected });
      return;
    }
    const userId = String(frame.user_id ?? '').trim();
    if (userId === '') {
      rejected += 1;
      writeLog('warn', 'OneBot ' + kindLabel + '消息缺少 user_id，已丢弃', { rejected });
      return;
    }
    // 自己的回声（user_id === self_id）不是「他说的」：只忽略并记一条日志，
    // 不计入 rejected —— rejected 的语义是「信封/字段校验不通过」。字符串比较。
    const selfId = String(frame.self_id ?? '').trim();
    if (selfId !== '' && selfId === userId) {
      writeLog('info', 'OneBot ' + kindLabel + '消息是自己的回声，已忽略', { userId, groupId, messageId });
      return;
    }
    if (frame.message === undefined || frame.message === null) {
      rejected += 1;
      writeLog('warn', 'OneBot ' + kindLabel + '消息缺少 message 字段，已丢弃', { rejected });
      return;
    }
    const parsed = parseSegments(frame.message);
    if (parsed.text === '' && parsed.segments.length === 0) {
      rejected += 1;
      writeLog('warn', 'OneBot ' + kindLabel + '消息既无文本也无消息段，已丢弃', { rejected });
      return;
    }
    const at = Date.now();
    received += 1;
    lastEventAt = at;
    // userName / ts 是**额外附加**的两个字段（约定的 6 个键一个不少、语义不变）：
    // 本仓库 lib/index.js 的 onEvent 会读 evt.userName 与 evt.ts 造信封，
    // 形状对齐 lib/envelope.js 的 readPrivateEvent（time 是秒，这里 ×1000）。
    const sender = frame.sender && typeof frame.sender === 'object' ? frame.sender : {};
    const userName = String(sender.card || sender.nickname || '').slice(0, 40);
    const rawTime = Number(frame.time);
    const ts = Number.isFinite(rawTime) && rawTime > 0 ? rawTime * 1000 : at;
    bus.emit('message', {
      userId,
      messageId,
      text: parsed.text,
      segments: parsed.segments,
      // 2026-10-15 加群聊：这两项让下游能分辨"这是群还是私聊、是哪个群"。
      // `selfId` 一并带出去 —— 群里判"她被 @了没"要用它（`at` 段的 qq 与之比对），
      // 而它只有在这一帧里才拿得到（`frame.self_id`）。
      chatType,
      groupId,
      selfId,
      raw: frame,
      at,
      userName,
      ts,
    });
  }

  /** 握手：鉴权 + 挂连接（鉴权失败只计数并关这一条连接）。 */
  function accept(socket, request) {
    const token = extractBearer(request);
    if (accessToken !== '' && !constantTimeEqual(accessToken, token)) {
      rejectedAuth += 1;
      const remote = request && request.socket ? request.socket.remoteAddress : 'unknown';
      writeLog('warn', `OneBot 连接被拒绝（access token 不匹配）来自 ${remote}`, { rejectedAuth });
      try {
        socket.close(4001, 'invalid access token');
      } catch {
        // 关不掉就算了，反正是被拒的连接
      }
      return;
    }
    const remote = request && request.socket ? request.socket.remoteAddress : 'unknown';
    const id = `${remote}:${Date.now()}:${++connectionSeq}`;
    connections.set(id, { socket, at: Date.now(), generation: fileGeneration });
    // 新连接是活的：清掉上一轮的 stale / 失败计数。
    stale = false;
    missCount = 0;
    writeLog('info', `OneBot 客户端已连接（当前 ${connections.size} 个）`);
    socket.on('message', (data) => onFrame(socket, data));
    socket.on('close', () => {
      connections.delete(id);
      fileUploads.disconnect(socket);
      writeLog('info', `OneBot 客户端已断开（当前 ${connections.size} 个）`);
      // 只标记 offline：不清空、不重建、不销毁任何东西；重连 = 等它再连回来。
      publishState();
    });
    socket.on('error', (error) => {
      fileUploads.disconnect(socket);
      lastError = errorMessage(error);
      writeLog('warn', `OneBot 连接出错: ${lastError}`);
    });
    publishState();
  }

  /**
   * 发一条 action（白名单 + 需要活跃连接），统一返回 { ok, data?, error? }。
   * opts.timeoutMs 覆盖本条 action 的等待上限（默认 ACTION_TIMEOUT_MS）：
   * 心跳走短超时，见 runHeartbeat。
   */
  function call(action, params, opts) {
    if (!ALLOWED_ACTIONS.has(action)) {
      writeLog('warn', `OneBot action 不在白名单，已拒绝: ${action}`);
      return Promise.resolve({ ok: false, error: `action not allowed: ${action}` });
    }
    const socket = currentSocket();
    if (!socket) {
      writeLog('warn', `OneBot action ${action} 未发送：当前没有已连接的客户端`);
      return Promise.resolve({ ok: false, error: 'no client connected' });
    }
    const echo = `echo-${++echoSeq}`;
    let frame;
    try {
      frame = JSON.stringify({ action, params: params ?? {}, echo });
    } catch (error) {
      const message = `OneBot action ${action} 参数无法序列化: ${errorMessage(error)}`;
      lastError = message;
      writeLog('error', message);
      return Promise.resolve({ ok: false, error: message });
    }
    const timeoutMs = Number.isFinite(Number(opts && opts.timeoutMs)) && Number(opts.timeoutMs) > 0
      ? Number(opts.timeoutMs)
      : ACTION_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(echo);
        const message = `OneBot action ${action} 超时（${timeoutMs}ms）`;
        lastError = message;
        writeLog('warn', message);
        resolve({ ok: false, error: message });
      }, timeoutMs);
      pending.set(echo, { action, timer, resolve });
      try {
        socket.send(frame);
        sent += 1;
      } catch (error) {
        pending.delete(echo);
        clearTimeout(timer);
        const message = `OneBot action ${action} 发送失败: ${errorMessage(error)}`;
        lastError = message;
        writeLog('error', message);
        resolve({ ok: false, error: message });
      }
    });
  }

  /** 心跳：只做存活检测，失败只计数与标记 stale。 */
  async function runHeartbeat() {
    if (heartbeatBusy) return;
    if (connections.size === 0) {
      // 没人在，谈不上「不活」：清空失败计数，stale 归位。
      missCount = 0;
      if (stale) {
        stale = false;
        publishState();
      }
      return;
    }
    heartbeatBusy = true;
    // 心跳用短超时：stale 的判定时间要由**配置**决定（heartbeatMs × maxMisses 量级），
    // 而不是被 action 的默认超时拖着走 —— 否则 heartbeatMs 配得再小也形同虚设。
    // 下限 300ms（留给真机一个来回），上限 2000ms、且不超过心跳周期本身。
    const heartbeatTimeoutMs = Math.max(300, Math.min(heartbeatPeriod, 2000));
    const result = await call('get_status', {}, { timeoutMs: heartbeatTimeoutMs });
    heartbeatBusy = false;
    if (result.ok) {
      missCount = 0;
      if (stale) {
        stale = false;
        writeLog('info', 'OneBot 心跳恢复，stale 已清除');
        publishState();
      }
      return;
    }
    missCount += 1;
    writeLog('warn', `OneBot 心跳失败（连续 ${missCount}/${missLimit} 次）: ${result.error}`, { missCount, missLimit });
    // 关键：心跳失败绝不销毁任何状态 —— 连接、待回包、计数器全部保留。
    if (missCount >= missLimit && !stale) {
      stale = true;
      publishState();
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (heartbeatPeriod <= 0) return;
    heartbeatTimer = setInterval(() => {
      void runHeartbeat();
    }, heartbeatPeriod);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatBusy = false;
  }

  /** 起 WebSocketServer，监听 host:port。 */
  function start() {
    if (listening) return Promise.resolve();
    fileGeneration += 1;
    fileUploads.invalidateAll();
    return new Promise((resolve, reject) => {
      let settled = false;
      let server;
      try {
        server = new WebSocketServer({ host, port });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
        return;
      }
      wss = server;
      server.on('connection', (socket, request) => accept(socket, request));
      server.on('listening', () => {
        listening = true;
        stale = false;
        missCount = 0;
        writeLog('info', `OneBot 反向 WS 正在监听 ws://${host}:${port}`);
        publishState();
        startHeartbeat();
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      server.on('error', (error) => {
        fileGeneration += 1;
        fileUploads.invalidateAll();
        lastError = errorMessage(error);
        listening = false;
        writeLog('error', `OneBot 服务出错: ${lastError}`);
        publishState();
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error(lastError));
        }
      });
    });
  }

  /** 关服务并断开所有连接。 */
  async function stop() {
    fileGeneration += 1;
    fileUploads.invalidateAll();
    stopHeartbeat();
    for (const entry of connections.values()) {
      try {
        entry.socket.close(1000, 'bridge shutdown');
      } catch {
        // 关不掉的连接不阻断关闭流程
      }
    }
    connections.clear();
    for (const [key, item] of pending) {
      pending.delete(key);
      clearTimeout(item.timer);
      item.resolve({ ok: false, error: `OneBot 已停止，action ${item.action} 未完成` });
    }
    listening = false;
    const server = wss;
    wss = null;
    if (server) {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    stale = false;
    missCount = 0;
    publishState();
  }

  /** 当前状态快照。 */
  function status() {
    refreshState();
    return {
      state: lastState,
      clients: connections.size,
      listening,
      lastEventAt,
      received,
      sent,
      rejectedAuth,
      lastError,
      rejected,
      stale,
    };
  }

  /**
   * 发一条纯文本私聊消息。
   * userId 收字符串（数字也认）；对外给回的 messageId 统一 String() 化。
   */
  async function sendPrivateMsg(userId, text) {
    const result = await call('send_private_msg', { user_id: normalizeUserId(userId), message: String(text ?? '') });
    if (!result.ok) return { ok: false, error: result.error };
    const messageId = result.data && result.data.message_id !== undefined
      ? String(result.data.message_id)
      : undefined;
    return { ok: true, messageId };
  }

  /**
   * 发一条带消息段数组的私聊消息（同一个 action）。
   * userId / messageId 的处理同 sendPrivateMsg。
   */
  async function sendPrivateMsgSegments(userId, segments) {
    const message = Array.isArray(segments) ? segments : [];
    const result = await call('send_private_msg', { user_id: normalizeUserId(userId), message });
    if (!result.ok) return { ok: false, error: result.error };
    const messageId = result.data && result.data.message_id !== undefined
      ? String(result.data.message_id)
      : undefined;
    return { ok: true, messageId };
  }

  /**
   * 发一条纯文本**群**消息（2026-10-15 加群聊）。
   * groupId 收字符串（数字也认）；对外给回的 messageId 统一 String() 化。
   * 与 `sendPrivateMsg` 逐字对称 —— 只有 action 与参数名不同。
   */
  async function sendGroupMsg(groupId, text) {
    const result = await call('send_group_msg', { group_id: normalizeUserId(groupId), message: String(text ?? '') });
    if (!result.ok) return { ok: false, error: result.error };
    const messageId = result.data && result.data.message_id !== undefined
      ? String(result.data.message_id)
      : undefined;
    return { ok: true, messageId };
  }

  /**
   * 发一条带消息段数组的**群**消息（同一个 action）。
   * groupId / messageId 的处理同 sendGroupMsg。
   */
  async function sendGroupMsgSegments(groupId, segments) {
    const message = Array.isArray(segments) ? segments : [];
    const result = await call('send_group_msg', { group_id: normalizeUserId(groupId), message });
    if (!result.ok) return { ok: false, error: result.error };
    const messageId = result.data && result.data.message_id !== undefined
      ? String(result.data.message_id)
      : undefined;
    return { ok: true, messageId };
  }

  /** 取登录号信息。 */
  function getLoginInfo() {
    return call('get_login_info', {});
  }

  return {
    start,
    stop,
    status,
    call,
    beginFileUpload: input => fileUploads.beginFileUpload(input),
    sendPrivateMsg,
    sendPrivateMsgSegments,
    sendGroupMsg,
    sendGroupMsgSegments,
    getLoginInfo,
  };
}
