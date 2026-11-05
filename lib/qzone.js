/**
 * qzone.js —— QQ 空间通道（第一期）。
 *
 * Echo 的"空间手"：发说说 / 读说说 / 删说说，外加 **Cookie 自动续期**。
 *
 * ## 为什么住在这里（而不是主包）
 *
 * 空间属于 **QQ 平台**，而本插件已经是"QQ 平台的桥"（OneBot 通道就在隔壁
 * `lib/onebot.js`）。空间走的是**另一个上游**（onebot-qzone 桥，默认
 * `127.0.0.1:5700`），所以是**第二条通道**，与聊天解耦：
 * 桥挂了 ⇒ 空间工具诚实拒绝，**聊天一个字都不受影响**。
 *
 * ## 三条硬纪律（照 `onebot.js` 的既有风格）
 *
 *   ① **白名单**：`QZONE_ACTIONS` 之外一律拒发（与 `onebot.js:129` 同款）。
 *   ② **权限必填**：发说说**必须**显式给 `whoCanSee`（或走面板默认值）——
 *      桥侧不传时 `src/qzone/client.ts:4018` 硬编码 `ugc_right: 1` = **所有人可见**。
 *      这条最容易出事，所以**校验放在发请求之前**，非法值直接拒、不发。
 *   ③ **失败不静默**：每个结果都带 `ok`；出错带 `reason`。
 *      "空结果"与"出错"必须长得不一样（照主包 `memory-read-tools.js` 的纪律）。
 *
 * ## Cookie 自动续期（本模块最有价值的一环）
 *
 * 桥需要 QZone Cookie（`uin`/`p_uin`/`skey`/`p_skey`），会过期。
 * 官方文档教人从浏览器 F12 手工复制 —— 这里改成**经现有 OneBot 通道**
 * 向 NapCat 要（`get_cookies`），再灌进桥（`POST /login_cookie`）。
 *
 * ⚠️ **诚实交代**：`get_cookies` 的**返回结构没有实测过**（NapCat 只有反向 WS、
 * 没有入站端点，只能经本插件发）。所以 `buildCookieString()` 写得**尽量宽容**
 * （字符串 / {cookies} / {data:{cookies}} / [{name,value}] / {k:v} 都认），
 * 并且**一律校验必需字段**：缺一个就**不灌**（宁可不更新，也不灌半截 Cookie
 * 把原本好的登录态弄坏）。
 *
 * 灌完还要**复核**（`get_login_info`）：灌进去 ≠ 能用。
 * 复核不过 ⇒ 明确报 `cookie-rejected`，由调用方决定告警还是回退手工。
 *
 * 依赖全部注入（`fetchImpl` / `now` / `setTimer` / `getCookies`）⇒ 零宿主依赖、离线可测。
 *
 * ⚠️ 默认值（host/port/权限/保活间隔）**不在这里写死** —— 一律取自 `config.js` 的
 * `DEFAULT_SETTINGS`（那份是唯一真源，`nohardcode` 的 loopback 白名单也只放行它）。
 * 这里只做"读不到就用默认"的兜底。
 */
import { DEFAULT_SETTINGS } from './config.js'
// ★ 2026-10-19：白名单解析复用（与评论事件那侧同一套口径）
import { parseWatchList } from './qzone-events.js'

/** Qzone action 白名单 —— 白名单外一律拒发。 */
export const QZONE_ACTIONS = Object.freeze([
  // 只读
  'get_login_info',      // 探活 + 取昵称（也是 Cookie 复核用的那一条）
  'get_emotion_list',    // 读说说列表
  // ★ 2026-10-20：**读评论**（桥 actions.ts:632 get_comment_list）。
  //   补的是「有手没眼」那个缺口 —— echo_qzone_reply 要 tid+targetUin，
  //   但原来没有任何工具能把这俩读出来。
  'get_comment_list',
  // ★ 2026-10-20：**好友动态**（桥 actions.ts:896 get_friend_feeds）。
  //   权威用法见桥的 poller.ts:883 —— 它就是用 getFriendFeeds 轮好友流的，
  //   **不是** get_feeds_html_act_all（那个是"某人空间页的全部动态"）。
  'get_friend_feeds',
  // 写
  'send_private_msg',    // ★ 桥的约定：这个 action = **发布说说**
  'delete_msg',          // 删说说
  // ★ 2026-10-19：**回复评论**（桥 actions.ts:398 send_comment）。
  //   只有白名单里的人（和他本人）的评论才允许回 —— 闸在 replyComment 里。
  'send_comment',
  // Cookie
  'login_cookie',        // 灌 Cookie（由 refreshCookie 调用）
]);

/** 查看权限取值（`src/qzone/client.ts:4575` 注释：1=公开，64=私密）。 */
export const UGC_RIGHT = Object.freeze({
  PUBLIC: 1,       // 所有人可见
  FRIENDS: 4,      // 好友可见
  PARTIAL: 16,     // 部分好友可见
  SELF: 64,        // 仅自己可见
  EXCEPT: 128,     // 部分好友不可见
});

/** 合法权限值集合（校验用；非法值**不发请求**）。 */
export const VALID_UGC_RIGHTS = Object.freeze(new Set(Object.values(UGC_RIGHT)));

/**
 * ★ 向 NapCat 要 Cookie 时**必须带**的那个域。
 *
 * 2026-10-15 真机抓到的 bug：`get_cookies` 的 `domain` 是**必填**，
 * 传 `{}` ⇒ NapCat 回 `1400 Schema compilation error: Expected required property`。
 *
 * 为什么是 `qzone.qq.com`：那正是 QZone Web API 要的域 —— NapCat 内部有一张
 * `domainPskeyMap`，里面明确列着它（bundle 里 `domainPskeyMap.get("qzone.qq.com")`）。
 */
export const QZONE_COOKIE_DOMAIN = 'qzone.qq.com';

/**
 * 造那根"向 NapCat 要 Cookie"的接线。
 *
 * ★ **单独导出就是为了能测**：`domain` 漏了真机会回 1400，而这段原本**内联**在
 * `lib/index.js` 的 `apply()` 里 —— 内联就只能靠"源码文本正则"断言，
 * 那测不出"**真的传了什么**"。抽出来之后，测试可以塞一个假的 `onebot.call` 桩，
 * 直接断言第一个参数是 `get_cookies`、第二个参数里有 `domain`。
 *
 * （教训：那一版单测全部注入假 `getCookies`，**这根真实接线没人测** ⇒ 三绿过了真机挂。）
 *
 * @param {(() => ({call: Function}|null))|({call: Function}|null)} onebotOf 惰性取 OneBot 客户端
 * @returns {() => Promise<object>} 给 `createQzoneChannel` 用的 `getCookies`
 */
export function makeGetCookies (onebotOf) {
  return () => {
    let onebot = null;
    try {
      onebot = typeof onebotOf === 'function' ? onebotOf() : onebotOf;
    } catch {
      onebot = null;
    }
    if (onebot === null || onebot === undefined || typeof onebot.call !== 'function') {
      return Promise.resolve({ ok: false, error: 'onebot 客户端还没起来' });
    }
    return onebot.call('get_cookies', { domain: QZONE_COOKIE_DOMAIN });
  };
}

/** 拼 Cookie 串时**必需**的字段。缺任何一个 ⇒ 不灌。 */
export const COOKIE_REQUIRED_FIELDS = Object.freeze(['uin', 'p_uin', 'skey', 'p_skey']);

/** 单条 action 的等待上限（毫秒）。读说说可能慢，给足。 */
export const QZONE_ACTION_TIMEOUT_MS = 20000;

/** 发说说的正文上限（QZone 侧限 ~2000 字，这里留余量）。 */
export const MAX_CONTENT_CHARS = 1500;

/** 一次最多带几张图。 */
export const MAX_IMAGES = 9;

// ============================================================================
// 纯函数（可离线测）
// ============================================================================

/** 把一个值压成 `k=v; k=v` 形状的 Cookie 串；认不出来返回 `''`。 */
function normalizeCookieShape(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw.trim();
  // 数组：[{name,value}] / [{Name,Value}] / ["k=v"]
  if (Array.isArray(raw)) {
    const parts = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        if (item.includes('=')) parts.push(item.trim());
        continue;
      }
      if (item !== null && typeof item === 'object') {
        const k = item.name ?? item.Name ?? item.key ?? item.Key;
        const v = item.value ?? item.Value;
        if (k !== undefined && v !== undefined) parts.push(`${String(k)}=${String(v)}`);
      }
    }
    return parts.join('; ');
  }
  if (typeof raw === 'object') {
    // 已知的包装层：{cookies} / {cookie} / {cookie_string} / {data:{...}} / {result:{...}}
    for (const key of ['cookies', 'cookie', 'cookie_string', 'cookieString']) {
      if (typeof raw[key] === 'string') return raw[key].trim();
    }
    for (const key of ['data', 'result']) {
      const inner = normalizeCookieShape(raw[key]);
      if (inner !== '') return inner;
    }
    // 退化成"对象映射"：{uin:'o123', skey:'...'} —— 只认短且像 cookie 的键
    const parts = [];
    for (const [k, v] of Object.entries(raw)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue;
      if (!/^[A-Za-z0-9_]+$/.test(k)) continue;
      parts.push(`${k}=${String(v)}`);
    }
    if (parts.length > 0) return parts.join('; ');
  }
  return '';
}

/** 从 `k=v; k=v` 串里取某个字段的值（没有返回 `''`）。 */
export function cookieFieldOf(cookieStr, name) {
  const text = String(cookieStr ?? '');
  const want = String(name ?? '');
  if (text === '' || want === '') return '';
  for (const piece of text.split(';')) {
    const at = piece.indexOf('=');
    if (at <= 0) continue;
    if (piece.slice(0, at).trim() === want) return piece.slice(at + 1).trim();
  }
  return '';
}

/** 缺哪些必需字段（全有 ⇒ 返回 `[]`）。 */
export function missingCookieFields(cookieStr) {
  return COOKIE_REQUIRED_FIELDS.filter((name) => cookieFieldOf(cookieStr, name) === '');
}

/**
 * 把 NapCat `get_cookies` 的返回整理成可用的 Cookie 串。
 * 形状认不出 / 必需字段缺任何一个 ⇒ **返回 `null`**（调用方据此放弃本轮）。
 */
export function buildCookieString(raw) {
  const shaped = normalizeCookieShape(raw);
  if (shaped === '') return null;
  if (missingCookieFields(shaped).length > 0) return null;
  return shaped;
}

/** 把 `{type:'text'|'image'}` 数组拼成桥要的 OneBot 消息段。 */
export function buildMoodSegments(content, images = []) {
  const segs = [{ type: 'text', data: { text: String(content ?? '') } }];
  for (const url of Array.isArray(images) ? images : []) {
    const file = String(url ?? '').trim();
    if (file !== '') segs.push({ type: 'image', data: { file } });
  }
  return segs;
}

// ============================================================================
// 通道
// ============================================================================

/**
 * @param {object} deps
 * @param {object} deps.settings 读配置的**函数**或对象（见 `lib/config.js` 的 qzone* 项）
 * @param {(level:string,msg:string)=>void} [deps.log]
 * @param {()=>number} [deps.now]
 * @param {typeof fetch} [deps.fetchImpl] 注入 ⇒ 离线可测
 * @param {Function|null} [deps.getCookies] 由壳注入 `() => onebot.call('get_cookies', {})`
 * @param {Function} [deps.setTimer] / @param {Function} [deps.clearTimer]
 */
export function createQzoneChannel({
  settings = {},
  log = () => {},
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  getCookies = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const readSettings = typeof settings === 'function' ? settings : () => settings;

  /** 保活定时器句柄；`null` = 没在跑。 */
  let keeper = null;
  /** 连续失败次数（只用于把日志压住，不改变行为）。 */
  let failStreak = 0;
  /** 最近一次续期的结果（给面板看）。 */
  let lastRefresh = null;
  /** 累计续期成功/失败（给面板看）。 */
  let okCount = 0;
  let failCount = 0;

  function cfg() {
    let s = {};
    try {
      s = readSettings() ?? {};
    } catch {
      s = {};
    }
    return {
      enabled: s.qzoneEnabled === true,
      host: String(s.qzoneHost ?? DEFAULT_SETTINGS.qzoneHost).trim() || DEFAULT_SETTINGS.qzoneHost,
      port: Number(s.qzonePort) || DEFAULT_SETTINGS.qzonePort,
      token: String(s.qzoneAccessToken ?? '').trim(),
      defaultUgcRight: Number(s.qzoneDefaultUgcRight),
      refreshMin: Number(s.qzoneCookieRefreshMin),
      selfUin: String(s.qzoneSelfUin ?? '').trim(),
      // ★ 2026-10-19：回复评论的**白名单闸**要这两样（闸放在配置所在地，
      //   免得主包那边的工具自己再抄一份名单、两边漂移）。
      watchList: parseWatchList(s.qzoneWatchList),
      masterId: String(s.masterId ?? '').trim(),
    };
  }

  function baseUrl() {
    const c = cfg();
    return `http://${c.host}:${c.port}`;
  }

  /**
   * 发一条 Qzone action。白名单 + token + 超时。
   * 统一返回 `{ ok, data?, error?, reason? }` —— **永不抛**。
   */
  async function call(action, params = {}, opts = {}) {
    const name = String(action ?? '');
    if (!QZONE_ACTIONS.includes(name)) {
      log('warn', `Qzone action 不在白名单，已拒绝: ${name}`);
      return { ok: false, reason: 'action-not-allowed', error: `action not allowed: ${name}` };
    }
    const c = cfg();
    if (!c.enabled) {
      return { ok: false, reason: 'disabled', error: 'qzone 通道没开' };
    }
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : QZONE_ACTION_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimer(() => {
      try {
        ac.abort();
      } catch {
        /* 已经结束了 */
      }
    }, timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (c.token !== '') headers.Authorization = `Bearer ${c.token}`; // pin-allow: 插件→onebot-qzone 桥 的鉴权,凭证是桥自己的 ONEBOT_ACCESS_TOKEN —— 与退役的旧桥(插件→主包 / mainToken / /api/echo/relay/*)方向与凭证都不同
      const resp = await fetchImpl(`${baseUrl()}/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params ?? {}),
        signal: ac.signal,
      });
      const text = await resp.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        return {
          ok: false,
          reason: 'bad-json',
          error: `桥返回的不是 JSON（HTTP ${resp.status}）: ${text.slice(0, 120)}`,
        };
      }
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, reason: 'unauthorized', error: '桥拒绝鉴权（accessToken 对不上？）' };
      }
      if (body && body.status === 'ok' && Number(body.retcode) === 0) {
        return { ok: true, data: body.data ?? null };
      }
      const retcode = body ? Number(body.retcode) : NaN;
      const message = String((body && (body.message || body.wording)) || '').trim();
      // 1401 = 未登录 / Cookie 失效 —— 单列出来，调用方好据此触发续期
      return {
        ok: false,
        reason: retcode === 1401 ? 'not-logged-in' : 'bridge-failed',
        retcode: Number.isFinite(retcode) ? retcode : undefined,
        error: message || `桥返回失败（HTTP ${resp.status}）`,
      };
    } catch (error) {
      const msg = String((error && error.message) || error);
      const aborted = msg.includes('abort');
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'network',
        error: aborted ? `桥 ${action} 超时（${timeoutMs}ms）` : `桥 ${action} 请求失败: ${msg}`,
      };
    } finally {
      clearTimer(timer);
    }
  }

  /** 探活 + 取昵称。 */
  async function loginInfo() {
    const r = await call('get_login_info', {});
    if (!r.ok) return r;
    return { ok: true, data: { userId: r.data?.user_id, nickname: r.data?.nickname } };
  }

  /**
   * 读说说列表。
   * @param {object} [opts]
   * @param {number} [opts.num] 条数（1~20）
   * @param {number} [opts.pos] 起始位置
   * @param {boolean} [opts.withImages] 是否要图片 base64（默认不要，省流量）
   */
  /**
   * 读说说列表。
   *
   * ★ 2026-10-20：多了 `uin` —— **看别人**的空间（工具 `echo_qzone_space`）。
   *
   * 桥的 `get_emotion_list` 本来就接任意 `user_id`（`actions.ts:486`：
   * `const uin = p['user_id'] ? String(p['user_id']) : this.client.qqNumber!`），
   * 是我们自己原来把 `user_id` 写死成 `selfUin`，所以只能看自己。
   *
   * **白名单闸**（★ 他拍的：看别人也要卡）：
   *   · `uin` 空 或 = 自己的号 ⇒ 看自己，**不拦**
   *   · 别的号 ⇒ **必须在 `qzoneWatchList` 里**，否则拒（`not-in-watchlist`）
   *
   * @param {{num?:number, pos?:number, withImages?:boolean, uin?:string}} [opts]
   */
  async function listMoods({ num = 5, pos = 0, withImages = false, uin = '' } = {}) {
    const c = cfg();
    const who = String(uin ?? '').trim();
    const isOthers = who !== '' && who !== (c.selfUin || '');
    // ★ 白名单闸：只有"看别人"才拦
    if (isOthers && !c.watchList.has(who)) {
      return {
        ok: false,
        reason: 'not-in-watchlist',
        note: '这个人不在空间白名单里（qzoneWatchList）—— 看别人的空间也受同一条纪律约束'
      };
    }
    const n = Math.min(20, Math.max(1, Number(num) || 5));
    const p = Math.max(0, Number(pos) || 0);
    const r = await call('get_emotion_list', {
      user_id: isOthers ? who : (c.selfUin || undefined),
      pos: p,
      num: n,
      include_image_data: withImages === true,
    });
    if (!r.ok) return r;
    const list = Array.isArray(r.data?.msglist) ? r.data.msglist : [];
    return {
      ok: true,
      // 看的是谁（空 = 自己）；工具侧会把它透出去
      uin: isOthers ? who : (c.selfUin || ''),
      isOthers,
      items: list.map((m) => ({
        tid: String(m?.tid ?? ''),
        content: String(m?.content ?? ''),
        createdAt: Number(m?.created_time) || 0,
        createdAtText: String(m?.createTime ?? ''),
        comments: Number(m?.cmtnum) || 0,
        likes: Number(m?.likenum) || 0,
        forwards: Number(m?.fwdnum) || 0,
        imageCount: Array.isArray(m?.pic) ? m.pic.length : 0,
      })),
      hasMore: r.data?.has_more === true,
    };
  }

  /**
   * ★ 发说说。
   *
   * `whoCanSee` **必填**（或由面板 `qzoneDefaultUgcRight` 兜底）；
   * 非法值 / 两者都没有 ⇒ **直接拒，不发请求**。
   *
   * @param {object} opts
   * @param {string} opts.content 正文
   * @param {string[]} [opts.images] 图片（URL / base64）
   * @param {number} [opts.whoCanSee] 权限（见 `UGC_RIGHT`）
   */
  async function postMood({ content = '', images = [], whoCanSee = null } = {}) {
    const text = String(content ?? '').trim();
    if (text === '') return { ok: false, reason: 'content-required', error: '正文不能为空' };
    if (text.length > MAX_CONTENT_CHARS) {
      return { ok: false, reason: 'content-too-long', error: `正文超过 ${MAX_CONTENT_CHARS} 字` };
    }
    const c = cfg();
    // 权限：显式给的优先，否则面板默认；**两个都没有 ⇒ 拒**
    const raw = whoCanSee === null || whoCanSee === undefined ? c.defaultUgcRight : Number(whoCanSee);
    if (!Number.isFinite(raw) || !VALID_UGC_RIGHTS.has(raw)) {
      return {
        ok: false,
        reason: 'ugc-right-required',
        error: '必须显式指定查看权限（1公开/4好友/16部分/64仅自己/128排除），或配好面板默认值',
      };
    }
    const pics = (Array.isArray(images) ? images : []).map((x) => String(x ?? '').trim()).filter((x) => x !== '');
    if (pics.length > MAX_IMAGES) {
      return { ok: false, reason: 'too-many-images', error: `一次最多 ${MAX_IMAGES} 张图` };
    }
    const r = await call('send_private_msg', {
      message: buildMoodSegments(text, pics),
      who_can_see: raw,
    });
    if (!r.ok) return r;
    return {
      ok: true,
      tid: String(r.data?.tid ?? r.data?.message_id ?? ''),
      whoCanSee: raw,
    };
  }

  /** 删一条说说。 */
  async function deleteMood(tid) {
    const id = String(tid ?? '').trim();
    if (id === '') return { ok: false, reason: 'tid-required', error: '要删哪一条？给 tid' };
    const r = await call('delete_msg', { message_id: id });
    if (!r.ok) return r;
    return { ok: true, tid: id };
  }
  /**
   * ★ 2026-10-20：**读好友动态**（只读），**用 qzoneWatchList 过滤**。
   *
   * 桥的 `get_friend_feeds`（`actions.ts:896`）返回 `msglist`，
   * 每条含 `tid / uin(发的人) / nickname / content / created_time / cmtnum / likenum`。
   *
   * 三条纪律：
   *   ① **白名单为空 ⇒ 直接拒**（`watchlist-empty`）—— 空集下"看谁"没有定义，
   *      不能退化成"全看"（那正是他定的「别人在空间说的话不该由她出面」的反面）
   *   ② **多拉再筛**：好友流里混着名单外的人，按 `count*3` 拉、筛完截到 `count`
   *   ③ 名单外的人**一条都不返回**（不是"标记一下"，是不给）
   *
   * @param {{count?:number}} [opts]
   */
  async function listFeeds ({ count = 10 } = {}) {
    const c = cfg();
    if (!c.enabled) return { ok: false, reason: 'disabled', note: 'qzone 通道没开' };
    if (c.watchList.size === 0) {
      return {
        ok: false,
        reason: 'watchlist-empty',
        note: '空间评论白名单是空的 —— 我不知道该看谁。先填 qzoneWatchList（面板或 config.json）'
      };
    }
    const want = Math.min(50, Math.max(1, Number(count) || 10));
    // 多拉一些再筛：好友流里混着名单外的人与自己的动态
    const fetchNum = Math.min(200, want * 3);
    const r = await call('get_friend_feeds', { num: fetchNum, fast_mode: '1' });
    if (!r.ok) return { ok: false, reason: r.reason ?? 'bridge-failed', note: r.error ?? '桥拒了' };
    const d = (r.data !== null && typeof r.data === 'object') ? r.data : {};
    const raw = Array.isArray(d.msglist) ? d.msglist : [];
    const items = [];
    for (const it of raw) {
      if (it === null || typeof it !== 'object') continue;
      const uin = String(it.uin ?? it.opuin ?? '').trim();
      // ★ 白名单闸：名单外的人一条都不给
      if (uin === '' || !c.watchList.has(uin)) continue;
      items.push({
        tid: String(it.tid ?? ''),
        uin,
        name: String(it.nickname ?? it.name ?? ''),
        content: String(it.content ?? ''),
        at: Number(it.created_time ?? it.createdTime ?? 0) || 0,
        comments: Number(it.cmtnum ?? 0) || 0,
        likes: Number(it.likenum ?? 0) || 0
      });
      if (items.length >= want) break;
    }
    return {
      ok: true,
      count: items.length,
      scanned: raw.length,
      watchlistSize: c.watchList.size,
      items
    };
  }

  /**
   * ★ 2026-10-20：**读某条说说下的评论**。
   *
   * 补的是闭环缺口：`replyComment` 要 `tid` + `targetUin`，而原来**没有任何东西**
   * 能把这俩读出来（`listMoods` 只回 `comments: 3` 这种**计数**）⇒ 有手没眼。
   *
   * 字段名以**桥的解析器实测**为准（`src/qzone/feeds3/comments.ts:580-589`）：
   *   `commentid` / `uin` / `name` / `content` / `createtime`（**全小写**）
   * 这里做一层归一，同时兼容 camelCase（PC 那条路可能给另一种）。
   *
   * @param {{tid?:string, num?:number, pos?:number}} [opts]
   * @returns {Promise<{ok:boolean, reason?:string, note?:string, tid?:string,
   *                    total?:number, items?:Array<{commentId:string, uin:string,
   *                    name:string, content:string, at:number, isReply:boolean,
   *                    replyToUin?:string}>}>} 永不抛
   */
  async function listComments ({ tid = '', num = 20, pos = 0, postUin = '' } = {}) {
    const c = cfg();
    if (!c.enabled) return { ok: false, reason: 'disabled', note: 'qzone 通道没开' };
    const id = String(tid ?? '').trim();
    if (id === '') return { ok: false, reason: 'tid-required', note: '要读哪条说说的评论？给 tid（先用 listMoods 拿）' };
    const n = Math.min(50, Math.max(1, Number(num) || 20));
    const p = Math.max(0, Number(pos) || 0);
    // ★ 2026-10-20：**帖主**（这说法属于谁）。原来写死 `selfUin` ⇒ 读别人的说说时语义就是错的。
    //   给了就用；没给就用自己的（桥那边也有兜底：`actions.ts:637-642`
    //   `user_id → postMetaCache → self`）。
    //   回包会把 `postUin` 带出去 —— 她拿到 tid 的同时得知道"这说法属于谁"，
    //   否则没法拿去 reply（那需要帖主）。
    const owner = String(postUin ?? '').trim();
    const r = await call('get_comment_list', {
      user_id: owner || c.selfUin || undefined,
      tid: id,
      num: n,
      pos: p
    });
    if (!r.ok) return { ok: false, reason: r.reason ?? 'bridge-failed', note: r.error ?? '桥拒了' };
    const d = (r.data !== null && typeof r.data === 'object') ? r.data : {};
    const arr = Array.isArray(d.commentlist) ? d.commentlist
      : Array.isArray(d.comment_list) ? d.comment_list
        : Array.isArray(d.comments) ? d.comments
          : [];
    const pick = (o, ...keys) => {
      for (const k of keys) {
        const v = o[k];
        if (v !== undefined && v !== null && String(v) !== '') return v;
      }
      return '';
    };
    const items = arr.map((o) => {
      const row = (o !== null && typeof o === 'object') ? o : {};
      const out = {
        commentId: String(pick(row, 'commentid', 'commentId', 'id') || ''),
        uin: String(pick(row, 'uin', 'userid', 'userId') || ''),
        name: String(pick(row, 'name', 'nickname', 'nick') || ''),
        content: String(pick(row, 'content', 'text') || ''),
        at: Number(pick(row, 'createtime', 'createdTime', 'created_time') || 0),
        isReply: row.is_reply === true || row.isReply === true
      };
      const rTo = String(pick(row, 'reply_to_uin', 'replyToUin') || '');
      if (rTo !== '') out.replyToUin = rTo;
      return out;
    });
    const total = Number(d.feeds3_comment_total);
    return {
      ok: true,
      tid: id,
      // ★ 这条说说属于谁 —— 调用方拿去 reply 时要用它当 `postUin`
      //
      //   ⚠️ 2026-10-20 修：**没给 `postUin` 时不要填 `selfUin`**。
      //   原来填了 ⇒ 读别人帖子下的评论时，回包说"帖主是她自己" ⇒
      //   她拿这个错值去 reply ⇒ 桥拼出 `topicId: "她自己_<tid>"` ⇒
      //   QZone 回「该条内容已被删除」。**诚实留空比编一个更安全。**
      postUin: owner,
      total: Number.isFinite(total) && total >= 0 ? total : items.length,
      items
    };
  }

  /**
   * ★ 2026-10-19：**回复一条空间评论**。
   *
   * 桥的 `send_comment`（`actions.ts:398`）参数：
   *   `tid` / `target_tid`（必填）· `content`（必填）
   *   `user_id` / `target_uin`（说说主人，可选；缺了桥自己从缓存补）
   *   `reply_comment_id` / `reply_uin`（二级回复用，可选）
   *
   * **白名单闸放在这里**（配置所在地），不放到主包 ——
   * 只有 `targetUin` 在白名单里、或就是他本人，才允许回；
   * 名单外的人一律拒（与「不回复、不进记忆」同一条纪律，别在两处各抄一份名单）。
   *
   * @returns {Promise<{ok:boolean, reason?:string, error?:string}>} 永不抛
   */
  async function replyComment ({ tid = '', content = '', targetUin = '', postUin = '', replyCommentId = '', replyUin = '' } = {}) {
    const c = cfg();
    // ⚠️ 返回形状与 deleteMood 一致（{ok:true,tid} / 原样错误）——
    //    这样主包那只工具可以直接复用 delSchema/delRender，不必再造一套。
    if (!c.enabled) return { ok: false, reason: 'disabled', note: 'qzone 通道没开' };
    const id = String(tid ?? '').trim();
    const text = String(content ?? '').trim();
    if (id === '') return { ok: false, reason: 'tid-required', note: '缺 tid（先用 qzone 的读说说拿一条真的）' };
    if (text === '') return { ok: false, reason: 'content-required', note: '回复不能为空' };
    if (text.length > MAX_CONTENT_CHARS) {
      return { ok: false, reason: 'content-too-long', note: '回复超过 ' + MAX_CONTENT_CHARS + ' 字' };
    }
    // ★★ 2026-10-20：**两把闸分开**（他拍的「甲」）
    //
    //   ① **去哪说**（postUin = 帖主）：自己的空间，或名单里的某个人的空间
    //   ② **回谁**（targetUin = 评论人）：他本人（masterId），或名单里的人
    //
    //   两把都过才允许。这样既不会跑到名单外的人空间里说话，
    //   也不会给名单外的陌生人搭腔 —— 与「别人在空间里说的话不该由她出面」同一条。
    const uin = String(targetUin ?? '').trim();
    const ownerRaw = String(postUin ?? '').trim();

    // 守卫：两个都空 ⇒ 不知道回哪条
    if (ownerRaw === '' && uin === '') {
      return {
        ok: false,
        reason: 'owner-required',
        note: '不知道回哪条 —— postUin（这说法属于谁）和 targetUin（回谁）至少给一个'
      };
    }

    // 闸① 去哪说
    const postOk = ownerRaw === '' || ownerRaw === c.selfUin || c.watchList.has(ownerRaw);
    if (!postOk) {
      return {
        ok: false,
        reason: 'post-not-in-watchlist',
        note: '这条说说属于 ' + ownerRaw + '，他不在空间白名单里（qzoneWatchList）—— 不去别人的地盘说话。'
      };
    }

    // 闸② 回谁
    const allowed = uin !== '' && (uin === c.masterId || c.watchList.has(uin));
    if (!allowed) {
      return {
        ok: false,
        reason: 'not-in-watchlist',
        note: '这个人不在空间白名单里（qzoneWatchList），不回复 —— 别人在空间里说的话不该由她出面。'
      };
    }
    // ★★ 2026-10-20 修：`target_uin` 是**帖主**，不是评论人（帖主可由 `postUin` 指定）。
    //
    //   桥的 `commentEmotion(ouin, tid, ...)` 拿 `ouin` 拼这两样
    //   （`client.ts:4237-4238`）：
    //     hostUin: ouin
    //     topicId: `${ouin}_${tid}`
    //   ⇒ `ouin` = **说说主人**。原来我们传的是**评论人** ⇒ topicId 指向
    //   "评论人的空间里的这条 tid" ⇒ 不存在 ⇒ 评论**必然失败**。
    //
    //   而且 `client.ts:4210` 只在 `!ouin` 时才用缓存里的真帖主补
    //   ⇒ 传了错的进去，**桥自己纠正不了**。
    //
    //   评论人只该用于两件事：
    //     ① 白名单闸（上面已经用过）
    //     ② `reply_uin` —— 桥拿它拼 `@{uin:xxx,nick:yyy,auto:1}` 的 @ 提及
    //        （`client.ts:4218-4228`，**必须同时有 `reply_comment_id` 才会加**）
    // ★★ 2026-10-20 再修：**`postUin` 没给时不要硬塞 `selfUin`**。
    //
    //   桥的帖主兜底链是三级的（`actions.ts:405` + `client.ts:4208-4213`）：
    //       ① `target_uin` / `user_id`
    //       ② `postMetaCache.get(tid).uin`   ← 桥读说说时缓存的**真帖主**
    //       ③ `this.client.qqNumber`（自己）
    //
    //   我们原来直接把 ① 填成 `selfUin` ⇒ **链子第一级就被填死**，桥永远走不到 ②。
    //   于是在**别人的说说**下评论时拼出 `topicId: "${自己}_${tid}"` ⇒
    //   QZone 回「该条内容已被删除」。
    //
    //   ⇒ 不给就不传，让桥从缓存解析；缓存也没有时它自己会落到 ③（自己的号），
    //     对"自己的说说"这个默认场景仍然是**对的**。
    const postOwner = ownerRaw; // 空 = 交给桥解析
    // reply_uin = **评论人**（桥拿它拼 @{uin:xxx} 提及；空则只是普通评论）
    const params = { target_tid: id, content: text };
    if (postOwner !== '') params.target_uin = postOwner;
    if (uin !== '') params.reply_uin = uin;
    const rc = String(replyCommentId ?? '').trim();
    if (rc !== '') params.reply_comment_id = rc;
    // 显式给了 replyUin 就用它覆盖（将来"在别人空间回复"要走这条）
    const ru = String(replyUin ?? '').trim();
    if (ru !== '') params.reply_uin = ru;
    const r = await call('send_comment', params);
    if (!r.ok) return { ok: false, reason: r.reason ?? 'bridge-failed', note: r.error ?? '桥拒了' };
    return { ok: true, tid: id, postUin: postOwner };
  }

  /**
   * ★ Cookie 自动续期：向 NapCat 要 → 灌进桥 → **复核**。
   *
   * 四种失败分开报，别混成一句"失败了"：
   *   `no-get-cookies`      壳没接上（离线 / 旧装机位）
   *   `get-cookies-failed`  NapCat 那边没给（掉线 / 未登录）
   *   `cookie-incomplete`   给的形状里缺必需字段（**不灌**，免得弄坏好状态）
   *   `login-cookie-failed` 桥拒收
   *   `cookie-rejected`     灌进去了但**用不了**（复核没过）—— 这条最该被人看见
   */
  async function refreshCookie({ reason = '' } = {}) {
    if (typeof getCookies !== 'function') {
      return { ok: false, reason: 'no-get-cookies', error: '壳没注入 getCookies' };
    }
    let raw;
    try {
      raw = await getCookies();
    } catch (error) {
      return { ok: false, reason: 'get-cookies-failed', error: String((error && error.message) || error) };
    }
    if (!raw || raw.ok !== true) {
      return {
        ok: false,
        reason: 'get-cookies-failed',
        error: String((raw && raw.error) || 'NapCat 没返回 get_cookies'),
      };
    }
    const cookie = buildCookieString(raw.data);
    if (cookie === null) {
      const shaped = normalizeCookieShape(raw.data);
      return {
        ok: false,
        reason: 'cookie-incomplete',
        error: shaped === ''
          ? 'get_cookies 的返回形状认不出来（没灌，免得弄坏现有登录态）'
          : `缺必需字段: ${missingCookieFields(shaped).join(', ')}`,
      };
    }
    const posted = await call('login_cookie', { cookie });
    if (!posted.ok) {
      return { ok: false, reason: 'login-cookie-failed', error: posted.error };
    }
    // 复核：灌进去 ≠ 能用
    const check = await call('get_login_info', {});
    if (!check.ok) {
      return {
        ok: false,
        reason: 'cookie-rejected',
        error: `Cookie 灌进去了但复核没过（${check.error}）—— 可能得手工更新一次`,
      };
    }
    return { ok: true, at: now(), nickname: String(check.data?.nickname ?? ''), reason };
  }

  /** 跑一轮续期 + 记账（失败只告警，绝不抛）。 */
  async function refreshOnce(reason = '') {
    const r = await refreshCookie({ reason });
    lastRefresh = { ...r, at: now() };
    if (r.ok) {
      okCount += 1;
      // 从失败里恢复过来时，明确说一句（别让它悄悄好了没人知道）
      if (failStreak > 0) log('info', `qzone: Cookie 续期恢复正常（之前连续失败 ${failStreak} 次）`);
      failStreak = 0;
      log('info', `qzone: Cookie 已续期（${r.nickname || '已登录'}）`);
    } else {
      failCount += 1;
      failStreak += 1;
      // 只报前三次 + 每 10 次一次，别刷屏
      if (failStreak <= 3 || failStreak % 10 === 0) {
        log('warn', `qzone: Cookie 续期失败（${r.reason}, 第 ${failStreak} 次）— ${r.error}`);
      }
    }
    return r;
  }

  /** 起保活定时器。关着 / 已经在跑 ⇒ 什么都不做（幂等）。 */
  function start() {
    const c = cfg();
    if (!c.enabled) return { ok: false, reason: 'disabled' };
    if (keeper !== null) return { ok: true, reason: 'already-running' };
    if (typeof getCookies !== 'function') {
      log('warn', 'qzone: 没接上 getCookies ⇒ 不启 Cookie 保活（空间工具仍可用，但要手工灌 Cookie）');
      return { ok: false, reason: 'no-get-cookies' };
    }
    const min = Number.isFinite(c.refreshMin) && c.refreshMin > 0 ? c.refreshMin : 10;
    const everyMs = min * 60 * 1000;
    // 立刻来一次：启动那一刻正好是"该确认 Cookie 还好不好"的时刻
    refreshOnce('startup').catch(() => {});
    keeper = setTimer(function tick() {
      refreshOnce('timer').catch(() => {});
      // 重新排下一次（不用 setInterval：避免上一轮没跑完就叠加）
      keeper = setTimer(tick, everyMs);
    }, everyMs);
    // 允许 Node 退出（不给定时器拴住进程）
    if (keeper && typeof keeper.unref === 'function') keeper.unref();
    log('info', `qzone: Cookie 保活已启（每 ${min} 分钟）`);
    return { ok: true, intervalMs: everyMs };
  }

  /** 停保活（幂等）。 */
  function stop() {
    if (keeper !== null) {
      try {
        clearTimer(keeper);
      } catch {
        /* 已经没了 */
      }
      keeper = null;
    }
    return { ok: true };
  }

  /** 给面板/状态面看的形状。 */
  function status() {
    const c = cfg();
    return {
      enabled: c.enabled,
      baseUrl: baseUrl(),
      hasToken: c.token !== '',
      defaultUgcRight: Number.isFinite(c.defaultUgcRight) ? c.defaultUgcRight : null,
      refreshMin: Number.isFinite(c.refreshMin) && c.refreshMin > 0 ? c.refreshMin : 10,
      keeperRunning: keeper !== null,
      canAutoRefresh: typeof getCookies === 'function',
      refreshOk: okCount,
      refreshFail: failCount,
      lastRefresh: lastRefresh === null
        ? null
        : { ok: lastRefresh.ok, reason: lastRefresh.reason, error: lastRefresh.error ?? '', at: lastRefresh.at },
    };
  }

  return {
    call,
    loginInfo,
    listMoods,
    postMood,
    deleteMood,
    replyComment,
    listComments,
    listFeeds,
    refreshCookie,
    refreshOnce,
    start,
    stop,
    status,
  };
}
