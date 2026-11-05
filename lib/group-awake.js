/**
 * group-awake.js —— 群聊的「唤醒 / 休眠」状态机（2026-10-15）。
 *
 * ## 产品规则（他 2026-10-15 定的）
 *
 *     休眠 ──[ 他 @她 ]──────────────► 唤醒
 *     唤醒 ──[ 群里任何人的消息 ]──────► 回（并把 2 分钟往后推）
 *     唤醒 ──[ 2 分钟没人说话 ]───────► 休眠
 *     唤醒 ──[ 他 @她 发 /stop ]─────► 立刻休眠
 *
 * **休眠中的群收到消息：什么都不做** —— 不续命、不进管道、不碰定时器。
 * （一碰就等于"有人说话就续命"，那它永远不会休眠。）
 *
 * ## 为什么不用心跳轮询（他 2026-10-15 明确否掉）
 *
 * 借 `heartbeatMs` 那种"每 30s 查一次 lastAt > 120s 吗"有三个毛病：
 *   ① **精度被心跳粒度绑死** —— 想 2 分钟，实际落在 120~150s 之间，行为不可预测；
 *   ② **空转** —— 群休眠着的时候，心跳照样每拍去问一遍"该不该醒"，绝大多数拍子无事发生；
 *   ③ **借来的时钟** —— `heartbeatMs` 是给 NapCat 连接保活用的（`maxMisses` 判 stale），
 *      把群聊状态搭上去，以后调连接保活会**顺手改掉群聊行为**。
 *
 * ⇒ 改成**按需挂 `setTimeout`、状态一变就撤旧挂新**：
 *   精度就是 `idleMs`；休眠的群**零开销**；时钟是自己的。
 *   这个形状在本仓有先例：`lib/sidecar-client.js` 的 `_revivalTimer` / `_restartTimer`。
 *
 * ## 分层（为什么这个状态住在渠道，不住主包）
 *
 * 「这一条要不要送进门」是**闸**的事，而闸在渠道（`allowsInbound` 就在这）。
 * 判断它需要三件**只有渠道才知道**的事实：群里刚才有没有人说话、她被没被 @、`/stop` 是不是冲她说的。
 * 放进主包就得把这三样塞进**跨仓信封契约**（`contract.js` 顶部写明字段以主包 `relay.js:107-148` 为准）
 * —— 渠道的本地运行态会长进契约里。⇒ 住渠道，信封一个字不动。
 *
 * 判据全在**纯函数**里（`decideGroupMessage` / `isAtMe` / `isStopCommand`），本模块零宿主依赖、离线可测。
 */

/** 默认空闲多久算休眠（他定的 2 分钟）。 */
export const DEFAULT_IDLE_MS = 120000;

/** `/stop` 的识别（半角/全角斜杠都认，大小写不敏感，尾随标点忽略）。 */
const STOP_RE = /^[/／]\s*stop\s*[。.!！?？]*$/i;

/**
 * 这一条是不是"@她"？—— 在已归一化的消息段里找 `at`。
 *
 * `at` 段**本来就被保留下来了**（`onebot.js` 的 `normalizeSegment`：
 * `if (type === 'at') return { type: 'at', qq: Number(params.qq ?? 0) }`），
 * 只是不计入 `text`。所以这里不用重建当年被删掉的那套 `atMe` 判定。
 *
 * ⚠️ `at all`（全体成员）在 OneBot 里是 `qq = 'all'`，`Number('all')` 是 NaN ⇒
 * 不会被误判成"@她"。这正是我们要的：@全体 ≠ @她。
 *
 * @param {Array<{type:string, qq?:number}>} segments 已归一化的段
 * @param {string|number} selfId 她自己的 QQ 号
 */
export function isAtMe (segments, selfId) {
  const me = String(selfId ?? '').trim();
  if (me === '') return false;
  if (!Array.isArray(segments)) return false;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    if (String(seg.type ?? '') !== 'at') continue;
    if (String(seg.qq ?? '') === me) return true;
  }
  return false;
}

/** 去掉所有 `at` 段之后剩下的正文（用来判 `/stop`，也用来给她看"他到底说了什么"）。 */
export function textWithoutAt (segments, text = '') {
  // 段里 at 不进 text（`parseSegments` 已经这样做了）⇒ 直接用 text 就够；
  // 这个函数留着是为了**把口径写下来**：判 `/stop` 用的是"@她之后那句话"，不是整条原始消息。
  return String(text ?? '').trim();
}

/** 这一句是不是 `/stop`？（用 `textWithoutAt` 的口径：@ 之后那句话） */
export function isStopCommand (text) {
  return STOP_RE.test(String(text ?? '').trim());
}

/**
 * ★ 纯判定：这一条群消息该怎么处理？
 *
 * 五种结果，**互斥且穷尽**：
 *   `sleep`  —— **他** @她 发 `/stop` ⇒ 立刻休眠，**这条不送**（它是命令，不是话）
 *   `wake`   —— **他** @她          ⇒ 唤醒，**送**
 *   `touch`  —— 已唤醒 + 有人说话    ⇒ 回，并把 2 分钟往后推
 *   `drop`   —— 休眠中 + 没被 @      ⇒ 什么都不做
 *   `ignore` —— 休眠中 + **别人** @她 ⇒ **不唤醒**（只有主人能唤醒）
 *
 * ★ 2026-10-17 加「主人闸」（他拍：「唤醒必须要我来把关」）：
 *
 *   原来 `atMe` 只判"有没有 @ 她" ⇒ **群里任何人 @ 她都能唤醒**。
 *   现在唤醒必须 `atMeByMaster`；醒着之后别人说话照旧能参与（`touch`）——
 *   这正是他要的：「只有我 @ 才醒，醒着的时候别人说话不 @ 她也会回」。
 *
 *   `/stop` 也收紧成**只有主人**能生效 —— 否则群里谁喊一句 `/stop` 就能把她关掉。
 *
 * @param {object} f
 * @param {boolean} f.atMe 这一条 @她了没
 * @param {boolean} f.atMeByMaster 这一条是**主人** @她 的吗（唤醒的唯一凭据）
 * @param {boolean} f.awake 这个群现在是醒着的吗
 * @param {boolean} f.stopCommand 这一条是不是 `/stop`
 * @returns {{action: 'sleep'|'wake'|'touch'|'drop'|'ignore', send: boolean, reason: string}}
 */
export function decideGroupMessage ({
  atMe = false, atMeByMaster = false, awake = false, stopCommand = false
} = {}) {
  // `/stop`：只有主人喊才作数（别人喊一句就能把她关掉，那是漏洞）
  if (atMe && atMeByMaster && stopCommand) {
    return { action: 'sleep', send: false, reason: '他让她停 —— 命令本身不是话,不送' };
  }
  // 唤醒：**必须主人 @**（他拍的口径）
  if (atMe && atMeByMaster) {
    return {
      action: 'wake',
      send: true,
      reason: awake ? '他 @她了(本来就醒着,续命)' : '他 @她了 ⇒ 唤醒'
    };
  }
  // 醒着：谁说话都回（别人 @ 或不 @ 都行），并把空闲计时往后推
  if (awake) {
    return { action: 'touch', send: true, reason: '群醒着 ⇒ 回,并把空闲计时往后推' };
  }
  // 休眠中 + 别人 @ 她 ⇒ **不唤醒**（区别于"没 @ 她"的 drop，便于日志分辨）
  if (atMe) {
    return { action: 'ignore', send: false, reason: '群休眠中且 @她的不是主人 ⇒ 不唤醒' };
  }
  return { action: 'drop', send: false, reason: '群休眠中且没 @她 ⇒ 不送(也不续命)' };
}

/**
 * 唤醒状态机。**只存内存**（他 2026-10-15 定）：
 * 重启后一律从"休眠"开始 —— 不会出现"重启完她还在群里叨叨"。
 *
 * @param {object} [deps]
 * @param {number} [deps.idleMs] 空闲多久休眠（默认 2 分钟）
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setTimer] / @param {Function} [deps.clearTimer] 注入 ⇒ 离线可测
 * @param {(msg:string)=>void} [deps.log]
 */
export function createGroupAwake ({
  idleMs = DEFAULT_IDLE_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {}
} = {}) {
  /** 醒着的群 id（字符串）。 */
  const awake = new Set();
  /** 每个醒着的群一个定时器：`groupId → timer`。休眠的群**不在表里** ⇒ 零开销。 */
  const timers = new Map();
  /** 每个群最后一次有人说话的时刻（只给 status 看，不参与判定）。 */
  const lastAt = new Map();

  /** 撤掉某个群的定时器（幂等）。 */
  function disarm (gid) {
    const old = timers.get(gid);
    if (old !== undefined) {
      try {
        clearTimer(old);
      } catch {
        /* 已经响了 */
      }
      timers.delete(gid);
    }
  }

  /** 挂/重挂某个群的休眠定时器 —— **状态一变就撤旧挂新**，这就是"从最后一条算起"。 */
  function arm (gid) {
    disarm(gid);
    const t = setTimer(() => {
      timers.delete(gid);
      awake.delete(gid);
      lastAt.delete(gid);
      log('群 ' + gid + ' 静了 ' + Math.round(idleMs / 1000) + ' 秒 —— 休眠');
    }, idleMs);
    // 不给进程拴住（同 sidecar-client 的既有做法）
    if (t !== null && typeof t === 'object' && typeof t.unref === 'function') t.unref();
    timers.set(gid, t);
  }

  return {
    /** 这个群醒着吗。 */
    isAwake: (groupId) => awake.has(String(groupId ?? '')),

    /** 唤醒（他 @她）。已经在醒着 ⇒ 等价于续命。 */
    wake (groupId) {
      const gid = String(groupId ?? '');
      if (gid === '') return false;
      awake.add(gid);
      lastAt.set(gid, now());
      arm(gid);
      log('群 ' + gid + ' 被 @醒了（静默 ' + Math.round(idleMs / 1000) + ' 秒后自动休眠）');
      return true;
    },

    /** 续命（醒着的群里有人说话）。**没醒的群返回 false 且什么都不做** —— 这是"休眠中不续命"的落点。 */
    touch (groupId) {
      const gid = String(groupId ?? '');
      if (gid === '' || !awake.has(gid)) return false;
      lastAt.set(gid, now());
      arm(gid);
      return true;
    },

    /** 立刻休眠（`/stop`、关机、群被移出白名单）。 */
    sleep (groupId) {
      const gid = String(groupId ?? '');
      if (gid === '') return false;
      const was = awake.has(gid);
      disarm(gid);
      awake.delete(gid);
      lastAt.delete(gid);
      if (was) log('群 ' + gid + ' 立刻休眠');
      return was;
    },

    /** 把不在白名单里的群清掉（配置改了之后调一次）。 */
    retain (keepIds) {
      const keep = new Set((Array.isArray(keepIds) ? keepIds : []).map((x) => String(x ?? '')));
      let dropped = 0;
      for (const gid of [...awake]) {
        if (!keep.has(gid)) {
          this.sleep(gid);
          dropped += 1;
        }
      }
      return dropped;
    },

    /** 全停（卸载 / 总闸关）。 */
    stop () {
      for (const gid of [...timers.keys()]) disarm(gid);
      awake.clear();
      lastAt.clear();
    },

    /** 给面板/状态面看的形状。 */
    status () {
      return {
        idleMs,
        awakeCount: awake.size,
        awakeGroups: [...awake].sort(),
        lastAt: Object.fromEntries([...lastAt].map(([g, t]) => [g, t]))
      };
    },

    /** 测试用：有几个定时器挂着（应当恒等于 `awake.size`）。 */
    _timerCount: () => timers.size
  };
}
