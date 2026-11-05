/**
 * dsh-echo-qq — QQ 空间桥的**进程管家**（2026-10-18）
 * ============================================================
 * 他拍的原话：「我觉得 dsh 重启的时候她也重启比较好，我的意思是，
 * 整个插件起码要跟着 dsh 走」。
 *
 * 之前桥是**开机自启**（启动文件夹 + 计划任务），于是：
 *   · 开机就占资源，哪怕你根本没开 DSH；
 *   · `dsh web` 重启后，桥还是那个**旧进程**（可能已经半死）；
 *   · 插件卸载了，桥还在跑 —— **孤儿进程**，谁都不知道它归谁管。
 *
 * 现在：**桥的生命周期 = 插件的生命周期**。
 *   · 插件 `apply` ⇒ 起桥（若配置了目录）
 *   · 插件 dispose ⇒ 杀桥
 *   · 桥崩了 ⇒ 带退避重启（长驻服务，不能一崩就死）
 *
 * ⚠️ 三条纪律：
 *
 *   ① **不配就不管**（`qzoneBridgeDir` 为空 ⇒ 一行都不做）。
 *      这是向后兼容：别人装这个插件、没有本地桥，行为与从前逐位一致。
 *
 *   ② **只杀自己起的那个**。用 spawn 拿到的 child 引用 + `taskkill /T /PID`，
 *      **绝不按进程名/命令行模糊匹配** —— 2026-10-18 我在这个仓库外面
 *      用 `-match 'qzone-bridge'` 过滤时，把我自己那条命令的 node 进程也
 *      匹配进去了（命令行里就含这个词），**杀掉了自己**。
 *      进程管理必须靠**句柄**，不能靠字符串。
 *
 *   ③ **Windows 上必须用 `shell: true` + `taskkill /T`**：
 *      `tsx.cmd` 是个批处理壳，它会再起一个真正的 node 子进程；
 *      `child.kill()` 只杀壳、留下孤儿 ⇒ 必须 `taskkill /T` 杀整棵树。
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import { request as httpRequest } from 'node:http'

/** 重启退避：第 n 次失败等 `BASE * 2^(n-1)`，上限 `MAX`。 */
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60000
/** 起桥后多久算"起来了"（超过这个时间没退出就不算失败）。 */
const STABLE_AFTER_MS = 30000

/**
 * 建一个桥管家。
 *
 * @param {object} deps
 * @param {() => object} deps.settings 活视图（每次现读，面板改完即生效）
 * @param {(level: string, msg: string) => void} deps.log
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setTimer] / @param {Function} [deps.clearTimer] 注入 ⇒ 离线可测
 * @param {(cmd: string, args: string[]) => void} [deps.killTree] 注入 ⇒ 离线可测
 * @returns {{ start: () => boolean, stop: () => void, status: () => object }}
 */
export function createBridgeSupervisor ({
  settings,
  log,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  killTree = defaultKillTree,
  // ★ 2026-10-20：**启动前探端口**（自愈孤儿桥）。四个都可注入 ⇒ 离线可测。
  probePort = defaultProbePort,
  askBridge = defaultAskBridge,
  findPidOnPort = defaultFindPidOnPort,
  readEnv = readBridgeEnv
} = {}) {
  /** 当前子进程（null = 没在跑）。**这是唯一的真源** —— 不按名字找进程。 */
  let child = null
  let retries = 0
  let retryTimer = null
  let startedAt = 0
  let disposed = false
  let lastExit = null
  let lastError = ''
  let totalStarts = 0

  const cfg = () => {
    const s = settings ?? {}
    return {
      dir: String(s.qzoneBridgeDir ?? '').trim(),
      enabled: s.qzoneEnabled === true,
      autoStart: s.qzoneBridgeAutoStart !== false,
      // 桥的入口：默认 `node_modules\.bin\tsx.cmd src/main.ts`
      script: String(s.qzoneBridgeScript ?? '').trim() || join('node_modules', '.bin', 'tsx.cmd'),
      args: String(s.qzoneBridgeArgs ?? '').trim() || 'src/main.ts'
    }
  }

  /**
   * 杀整棵进程树。
   *
   * ⚠️ 参数名**必须**和外层的 `killTree` 注入项区分开 —— 第一版这里写成
   * `function killTree (c) { ... killTree(c.pid) ... }`，参数遮蔽了闭包变量
   * ⇒ **自递归**，一调就爆栈。改成 `killProc` 之后才通。
   */
  function killProc (c) {
    if (c === null || c === undefined) return
    try {
      if (typeof c.pid === 'number' && c.pid > 0) killTree(c.pid)
    } catch { /* 杀不掉就算了，别影响卸载 */ }
  }

  function clearRetry () {
    if (retryTimer !== null) {
      try { clearTimer(retryTimer) } catch { /* 已经响了 */ }
      retryTimer = null
    }
  }

  /**
   * 起一次。**幂等**：已经在跑就直接返回 true。
   * @returns {boolean} 是否真的起了
   */
  /**
   * 启动前探活。**永不抛**。
   *
   * @returns {Promise<{action:'go'|'takeover'|'refuse', reason?:string}>}
   */
  async function preflight (c) {
    let env
    try {
      env = readEnv(c.dir)
    } catch {
      return { action: 'go' }
    }
    const port = Number(env?.port ?? 0)
    if (!Number.isFinite(port) || port <= 0) return { action: 'go' }

    let state = 'free'
    try {
      state = await probePort(String(env?.host ?? ''), port)
    } catch {
      state = 'free'
    }
    if (state !== 'busy') return { action: 'go' }

    // 端口有人 ⇒ 问一句"是不是我们的桥"
    let same = false
    try {
      same = await askBridge(String(env?.host ?? ''), port, String(env?.token ?? ''))
    } catch {
      same = false
    }

    if (!same) {
      return {
        action: 'refuse',
        reason: '端口 ' + port + ' 被**别的程序**占着（不是我们的桥）—— 不敢杀，空间桥不启动。'
      }
    }

    // 同类 ⇒ 杀掉接管
    let pid = 0
    try {
      pid = await findPidOnPort(port)
    } catch {
      pid = 0
    }
    if (!Number.isFinite(pid) || pid <= 0) {
      return {
        action: 'refuse',
        reason: '端口 ' + port + ' 上是个同类旧桥，但查不到它的 PID —— 不盲杀，空间桥不启动。'
      }
    }

    try {
      killTree(pid)
    } catch { /* 尽力而为 */ }
    log?.('warn', 'echo-qq: 端口 ' + port + ' 被同类的旧桥占着（pid ' + pid + '）—— 杀掉接管')

    // 等它真的退（最多 5 秒），否则新桥照样撞端口
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500))
      let now = 'free'
      try {
        now = await probePort(String(env?.host ?? ''), port)
      } catch {
        now = 'free'
      }
      if (now !== 'busy') return { action: 'takeover' }
    }
    return {
      action: 'refuse',
      reason: '旧桥（pid ' + pid + '）杀了但端口 ' + port + ' 还没释放 —— 空间桥这轮不启动。'
    }
  }

  async function start () {
    if (disposed) return false
    if (child !== null) return false
    const c = cfg()
    if (!c.enabled || !c.autoStart) return false
    if (c.dir === '') return false
    if (!existsSync(c.dir)) {
      lastError = '桥目录不存在: ' + c.dir
      log?.('warn', 'echo-qq: ' + lastError)
      return false
    }

    const cmd = join(c.dir, c.script)
    if (!existsSync(cmd)) {
      lastError = '找不到桥的启动脚本: ' + cmd
      log?.('warn', 'echo-qq: ' + lastError)
      return false
    }

    // ★★ 2026-10-20：**起之前先探端口**（自愈孤儿桥）。
    //
    //   背景：`dsh web` 被非优雅杀掉时，`ctx.effect` 的 `bridge.stop()` 跑不到 ⇒
    //   桥成孤儿、一直占着 5700；新的管家再起桥就撞 EADDRINUSE 秒退 ⇒
    //   退避重试无限循环，**永远起不来**（2026-10-20 连撞三次）。
    //
    //   四步：① 端口通不通 ② 通的话问它 `get_login_info`（带 Bearer）
    //        ③ 能应答(有 retcode) ⇒ **同类** ⇒ 杀了它接管
    //        ④ 不能应答 ⇒ **别人的东西** ⇒ 不敢杀，拒绝启动并告警
    const pre = await preflight(c)
    if (pre.action === 'refuse') {
      lastError = pre.reason
      log?.('warn', 'echo-qq: ' + pre.reason)
      return false
    }

    try {
      // shell:true ⇒ 能跑 .cmd；windowsHide ⇒ 不弹窗
      child = spawn(cmd, c.args.split(/\s+/).filter(Boolean), {
        cwd: c.dir,
        shell: true,
        windowsHide: true,
        stdio: 'ignore',          // 桥自己写 bridge-out.log，这里不接
        detached: false           // 跟父进程同组 ⇒ DSH 死了它也走
      })
      startedAt = now()
      totalStarts += 1
      lastError = ''
      log?.('info', 'echo-qq: 已启动 QQ 空间桥 (pid ' + child.pid + ') — ' + cmd)

      child.on('exit', (code, signal) => {
        const lived = now() - startedAt
        lastExit = { code, signal, lived, at: now() }
        child = null
        if (disposed) return
        // 活过 STABLE_AFTER_MS ⇒ 是"正常运行后崩了"，重置退避
        if (lived >= STABLE_AFTER_MS) retries = 0
        scheduleRetry('桥退出了 (code=' + code + ' signal=' + signal + ' 活了 ' + Math.round(lived / 1000) + 's)')
      })

      child.on('error', (err) => {
        lastError = '启动失败: ' + String(err?.message ?? err)
        log?.('warn', 'echo-qq: QQ 空间桥' + lastError)
      })

      return true
    } catch (err) {
      lastError = 'spawn 失败: ' + String(err?.message ?? err)
      log?.('warn', 'echo-qq: ' + lastError)
      child = null
      scheduleRetry(lastError)
      return false
    }
  }

  function scheduleRetry (why) {
    if (disposed) return
    const c = cfg()
    if (!c.enabled || !c.autoStart || c.dir === '') return
    retries += 1
    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.min(retries - 1, 5)))
    log?.('warn', 'echo-qq: ' + why + ' — ' + Math.round(wait / 1000) + 's 后重试(第 ' + retries + ' 次)')
    clearRetry()
    retryTimer = setTimer(() => {
      retryTimer = null
      start().catch(() => { /* 下一轮退避再说 */ })
    }, wait)
    if (retryTimer !== null && typeof retryTimer === 'object' && typeof retryTimer.unref === 'function') {
      retryTimer.unref()
    }
  }

  /** 停：杀整棵树 + 关掉退避。**幂等**。 */
  function stop () {
    disposed = true
    clearRetry()
    if (child !== null) {
      killProc(child)
      child = null
      log?.('info', 'echo-qq: 已停止 QQ 空间桥')
    }
  }

  /** 面板/诊断用。**不含 token**。 */
  function status () {
    const c = cfg()
    return {
      configured: c.dir !== '',
      dir: c.dir,
      enabled: c.enabled,
      autoStart: c.autoStart,
      running: child !== null,
      pid: child === null ? 0 : (child.pid ?? 0),
      uptimeMs: child === null ? 0 : Math.max(0, now() - startedAt),
      retries,
      totalStarts,
      lastExit,
      lastError
    }
  }

  return { start, stop, status }
}

/**
 * 从桥目录的 `.env` 里读端口与令牌。
 * 读不到就返回空 —— 那样就不做探活（退回老行为）。
 */
function readBridgeEnv (dir) {
  try {
    const text = readFileSync(join(dir, '.env'), 'utf8')
    const grab = (key) => {
      const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'))
      return m === null ? null : m[1]
    }
    const port = Number(String(grab('ONEBOT_PORT') ?? '').trim())
    return {
      // 桥默认只绑回环；它自己的 .env 里若写了 ONEBOT_HOST 就听它的
      host: String(grab('ONEBOT_HOST') ?? '').trim() || '127.0.0.1', // pin-allow: 默认值，与桥的 .env.example 一致
      port: Number.isFinite(port) && port > 0 ? port : 0,
      token: String(grab('ONEBOT_ACCESS_TOKEN') ?? '').trim()
    }
  } catch {
    return { port: 0, token: '' }
  }
}


/** `net.connect` 一下：通的 = 有人在听。 */
function defaultProbePort (host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let sock = null
    try {
      sock = connect({ host, port })
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => { try { sock.destroy() } catch { /* 已关 */ } finish('busy') })
      sock.once('timeout', () => { try { sock.destroy() } catch { /* 已关 */ } finish('free') })
      sock.once('error', () => finish('free'))
    } catch {
      finish('free')
    }
  })
}

/**
 * 那个端口上的东西**是不是我们的桥**：带 Bearer 打 `get_login_info`。
 * 能应答（不管 retcode 0 还是 1401 未登录）⇒ 同一个程序。
 */
function defaultAskBridge (host, port, token, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const body = '{}'
    const req = httpRequest({
      host,
      port,
      path: '/get_login_info',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(token !== '' ? { Authorization: 'Bearer ' + token } : {}) // pin-allow: 桥自己的 HTTP 鉴权就是 Bearer(server.ts:25-32)
      },
      timeout: timeoutMs
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(data)
          // 有 retcode 且能解析 ⇒ 是 OneBot 形状 ⇒ 我们的桥
          resolve(typeof j?.retcode === 'number')
        } catch { resolve(false) }
      })
    })
    req.on('timeout', () => { try { req.destroy() } catch { /* 已关 */ } resolve(false) })
    req.on('error', () => resolve(false))
    req.end(body)
  })
}

/** Windows: 从 `netstat -ano` 里捞占着这个端口的 PID。 */
function defaultFindPidOnPort (port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(0)
    execFile('netstat', ['-ano'], { windowsHide: true }, (err, stdout) => {
      if (err || typeof stdout !== 'string') return resolve(0)
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes(':' + port)) continue
        if (!/LISTENING/i.test(line)) continue
        const cols = line.trim().split(/\s+/)
        const pid = Number(cols[cols.length - 1])
        if (Number.isFinite(pid) && pid > 0) return resolve(pid)
      }
      resolve(0)
    })
  })
}

/** Windows: `taskkill /T /F /PID`（杀整棵树）。非 Windows: `process.kill(-pid)`。 */
function defaultKillTree (pid) {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => { /* 尽力而为 */ })
  } else {
    try { process.kill(-pid, 'SIGTERM') } catch {
      try { process.kill(pid, 'SIGTERM') } catch { /* 已经没了 */ }
    }
  }
}
