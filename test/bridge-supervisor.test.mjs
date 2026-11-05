/**
 * 空间桥进程管家 —— 2026-10-18
 * ==================================================================
 * 他拍的话：「我觉得 dsh 重启的时候她也重启比较好，我的意思是，
 * 整个插件起码要跟着 dsh 走」。
 *
 * 之前桥是**开机自启**（启动文件夹 + 计划任务），于是开机就占资源、
 * `dsh web` 重启后桥还是旧进程、插件卸载了桥还在跑（孤儿）。
 *
 * 这一组钉住管家的**三条纪律**（都写在 `lib/bridge-supervisor.js` 顶部）：
 *
 *   ① **不配就不管**：`qzoneBridgeDir` 为空 ⇒ 一次 spawn 都不发生
 *      （向后兼容：别人装这插件、没有本地桥，行为与从前逐位一致）。
 *   ② **只杀自己起的那个**：靠 spawn 拿到的 child 句柄 + pid，
 *      **绝不按进程名/命令行模糊匹配**。
 *      （2026-10-18 我在仓库外用 `-match 'qzone-bridge'` 过滤时，
 *        把我自己那条命令的 node 进程也匹配进去、杀掉了自己。）
 *   ③ **崩了带退避重启**，但**别无限快重试**（2s 起、指数退避、上限 60s）。
 *
 * 行为测的是**原语**（注入 fake spawn/kill/timer），不是真起进程 ——
 * 真起进程会把测试机搞脏，而且没法断言"到底 spawn 了几次"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// 这个模块依赖 node:child_process / node:fs，但 start() 里那些调用
// 都只在**配置齐全**时才走。为了能测"不配就不管"，这里直接 import 真模块
// （不碰文件系统），并用一个不存在的目录测"目录不存在"分支。
const { createBridgeSupervisor } = await import('../lib/bridge-supervisor.js')

function mkSettings (over = {}) {
  return {
    qzoneEnabled: true,
    qzoneBridgeDir: '',
    qzoneBridgeAutoStart: true,
    qzoneBridgeScript: '',
    qzoneBridgeArgs: '',
    ...over
  }
}

test('① 不配 qzoneBridgeDir ⇒ 一次 spawn 都不发生（向后兼容）', async () => {
  const logs = []
  const sup = createBridgeSupervisor({
    settings: mkSettings({ qzoneBridgeDir: '' }),
    log: (lvl, msg) => logs.push(lvl + ':' + msg)
  })
  // ★ 2026-10-20：`start()` 变成 async（启动前要探端口）
  assert.equal(await sup.start(), false, '没配目录就不该起')
  const st = sup.status()
  assert.equal(st.configured, false)
  assert.equal(st.running, false)
  assert.equal(st.pid, 0)
  assert.equal(st.totalStarts, 0, '★ 一次都没起过')
  // 也不该有任何 warn（"没配"是正常状态，不是错误）
  assert.deepEqual(logs, [], '没配目录时不该刷日志')
  sup.stop()   // 不该抛
})

test('② qzoneEnabled=false ⇒ 也不起（总闸优先）', async () => {
  const sup = createBridgeSupervisor({
    settings: mkSettings({ qzoneEnabled: false, qzoneBridgeDir: 'C:\\nonexistent-bridge-dir' }),
    log: () => {}
  })
  assert.equal(await sup.start(), false)
  assert.equal(sup.status().totalStarts, 0)
})

test('③ qzoneBridgeAutoStart=false ⇒ 只记录、不启动', async () => {
  const sup = createBridgeSupervisor({
    settings: mkSettings({ qzoneBridgeAutoStart: false, qzoneBridgeDir: 'C:\\nonexistent-bridge-dir' }),
    log: () => {}
  })
  assert.equal(await sup.start(), false)
  const st = sup.status()
  assert.equal(st.autoStart, false)
  assert.equal(st.totalStarts, 0)
})

test('④ 目录不存在 ⇒ 记一条人话错误，不崩', async () => {
  const logs = []
  const sup = createBridgeSupervisor({
    settings: mkSettings({ qzoneBridgeDir: 'C:\\definitely-not-a-real-dir-xyz' }),
    log: (lvl, msg) => logs.push(lvl + ':' + msg)
  })
  assert.equal(await sup.start(), false)
  const st = sup.status()
  assert.match(st.lastError, /目录不存在/, '要能看出"目录不对"，而不是静默失败')
  assert.equal(st.totalStarts, 0)
  assert.ok(logs.some((l) => l.startsWith('warn:')), '要 warn 一次（不静默）')
})

test('⑤ stop() 幂等：没起过也能安全调，调两次也不炸', () => {
  const sup = createBridgeSupervisor({ settings: mkSettings(), log: () => {} })
  sup.stop()
  sup.stop()
  assert.equal(sup.status().running, false)
})

test('⑥ status() 形状稳定（面板/诊断要能一直读）', () => {
  const sup = createBridgeSupervisor({ settings: mkSettings(), log: () => {} })
  const st = sup.status()
  for (const k of ['configured', 'dir', 'enabled', 'autoStart', 'running', 'pid',
    'uptimeMs', 'retries', 'totalStarts', 'lastExit', 'lastError']) {
    assert.ok(k in st, 'status() 缺字段: ' + k)
  }
  // ⚠️ 不含任何凭据（token 在别处，这里只报进程事实）
  assert.equal('token' in st, false)
  assert.equal('accessToken' in st, false)
})

test('⑦ 只杀自己起的那个：kill 拿到的是 spawn 的 pid，不是按名字找的', () => {
  // 这条是**静态闸**：源码里不许出现按进程名/命令行匹配的杀法。
  // 现场（2026-10-18）：我在仓库外用 `-match 'qzone-bridge'` 过滤 node 进程，
  // 结果把自己那条命令的 node 也匹配进去了（命令行里就含这个词），杀掉了自己。
  // 进程管理必须靠**句柄**，不能靠字符串。
  const src = readSrc('../lib/bridge-supervisor.js')
  assert.ok(src.includes('c.pid'), '杀进程要用 child 句柄上的 pid')
  assert.ok(src.includes("'taskkill'"), 'Windows 上要 taskkill /T 杀整棵树')
  // 不许出现"按名字找进程"的写法
  for (const bad of ['wmic', 'Get-Process', 'pgrep', 'pkill', 'tasklist']) {
    assert.equal(src.includes(bad), false, '不许按进程名/命令行匹配杀进程，发现: ' + bad)
  }
})

test('⑧ 进程管家必须有退避上限（不许无限快重试）', () => {
  const src = readSrc('../lib/bridge-supervisor.js')
  assert.ok(src.includes('RETRY_BASE_MS'), '要有退避基数')
  assert.ok(src.includes('RETRY_MAX_MS'), '要有退避上限')
  assert.match(src, /Math\.min\(RETRY_MAX_MS/, '退避要封顶')
})

/**
 * ★ 2026-10-18 现场：**桥起不来**（改完配置、重启 dsh web、桥却没起）。
 *
 * 两个坑叠在一起：
 *
 *   ① **`settings` 是异步的**：`apply` 顶部 `let settings = null`，
 *      而 `reload()` 是 `async`。第一版把 `bridge.start()` 放在 `apply`
 *      的 `ctx.effect` 里**同步**跑 ⇒ 那时 `settings` 还是 `null`
 *      ⇒ 读到 `qzoneBridgeDir = undefined` ⇒ 目录为空 ⇒ `start()` 直接 `return false`。
 *   ② **TDZ**：第一版 `const bridge = ...` 定义在 `apply` 后半段，
 *      而 `reload().then()` 在前半段就引用它 —— 异步时机上"通常"已初始化，
 *      但那是**巧合**不是保证。
 *
 * 现在：定义挪到 `reload()` 之前、`start()` 挪进 `reload().then()`。
 * 这两条只能靠**静态闸**钉（行为测需要真起宿主）。
 */
test('⑨ 桥必须在 reload() 之后起，且定义在其之前（防 settings 未就绪 + TDZ）', () => {
  const src = readSrc('../lib/index.js')
  const defAt = src.indexOf('const bridge = createBridgeSupervisor(')
  const startAt = src.indexOf('bridge.start()')
  const reloadAt = src.indexOf('reload().then(async () => {')

  assert.ok(defAt > 0, '要有 createBridgeSupervisor 的定义')
  assert.ok(startAt > 0, '要有 bridge.start()')
  assert.ok(reloadAt > 0, '要有 reload().then(...) 那段')

  // ① 定义必须在 reload 之前（防 TDZ）
  assert.ok(defAt < reloadAt,
    '★ `const bridge = ...` 必须在 `reload()` **之前**定义 —— 否则 .then() 里引用会撞 TDZ')

  // ② start() 必须在 reload 之后（防 settings 还是 null）
  assert.ok(startAt > reloadAt,
    '★ `bridge.start()` 必须在 `reload().then()` **里面/之后** —— '
    + '否则 settings 还是 null，读到空目录，桥永远起不来')

  // ③ 而且不许在 apply 顶层再同步调一次 start()（那是第一版的错）
  assert.equal(src.slice(0, reloadAt).includes('bridge.start()'), false,
    '★ 不许在 `reload()` 之前同步调 bridge.start() —— 那时 settings 一定是 null')

  // ④ stop() 要在清理钩子里（dispose 时杀桥，否则孤儿进程）
  assert.ok(src.includes('bridge.stop()'), 'dispose 时要 bridge.stop()')
  assert.match(src, /ctx\.effect\(\(\) => \(\) => \{[^}]*bridge\.stop\(\)/s,
    '★ 桥的 stop() 要挂在 `ctx.effect(() => () => {...})` 的清理函数里')
})

// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function readSrc (rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}


// ---- ★ 2026-10-20：**启动前探端口自愈**（孤儿桥占端口）------------------------
//
// 现场（2026-10-20，连撞三次）：`dsh web` 被非优雅杀掉 ⇒ `ctx.effect` 的
// `bridge.stop()` 跑不到 ⇒ 桥成孤儿、一直占着 5700 ⇒ 新管家起桥就撞
// EADDRINUSE 秒退 ⇒ 退避重试无限循环，**永远起不来**。
//
// 现在 `start()` 先探：端口通 ⇒ 问它 `get_login_info`（带 Bearer）⇒
// 能应答 = 同类 ⇒ 杀了接管；不能应答 = 别人的东西 ⇒ 不敢杀、拒绝启动。

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'

/** 造一个**看起来完整**的桥目录（有启动脚本），好在 start() 里过前置检查。 */
function mkFakeBridgeDir () {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'qqbridge-'))
  mkdirSync(pathJoin(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(pathJoin(dir, 'node_modules', '.bin', 'tsx.cmd'), '@echo off\r\n', 'utf8')
  return dir
}

/** 造一个管家，四个探活件全部注入（完全离线）。 */
function mkProbeSup ({ portState, same, pid = 4242 }) {
  const killed = []
  const calls = { probe: 0, ask: 0, find: 0 }
  const sup = createBridgeSupervisor({
    settings: mkSettings({ qzoneBridgeDir: mkFakeBridgeDir() }),
    log: () => {},
    readEnv: () => ({ host: '127.0.0.1', port: 5999, token: 'tok' }),
    probePort: async () => {
      calls.probe += 1
      // portState 可以是数组（按调用次序）或固定值
      return Array.isArray(portState)
        ? (portState[Math.min(calls.probe - 1, portState.length - 1)])
        : portState
    },
    askBridge: async () => { calls.ask += 1; return same },
    findPidOnPort: async () => { calls.find += 1; return pid },
    killTree: (p) => { killed.push(p) }
  })
  return { sup, killed, calls }
}

test('⑩ ★ 端口空闲 ⇒ 正常启动，一次都不杀', async () => {
  const { sup, killed, calls } = mkProbeSup({ portState: 'free', same: false })
  const started = await sup.start()
  assert.equal(started, true, '端口空着就该正常起')
  assert.deepEqual(killed, [], '★ 没占着就别杀任何东西')
  assert.equal(calls.ask, 0, '端口空着就不该去问')
  assert.equal(sup.status().running, true)
  sup.stop()
})

test('⑪ ★ 端口被**同类**旧桥占着 ⇒ 杀掉它、接管、照常启动', async () => {
  // busy（第一次探）→ 杀掉后 free
  const { sup, killed } = mkProbeSup({ portState: ['busy', 'free'], same: true, pid: 4242 })
  const started = await sup.start()
  assert.equal(started, true, '★ 同类旧桥要让路，新桥要起来')
  assert.deepEqual(killed, [4242], '★ 必须杀掉那个 pid')
  assert.equal(sup.status().running, true)
  sup.stop()
})

test('⑫ ★ 端口被**非同类**占着 ⇒ 拒绝启动，一个都不杀', async () => {
  const { sup, killed } = mkProbeSup({ portState: 'busy', same: false })
  const started = await sup.start()
  assert.equal(started, false, '★ 别人的端口不敢碰')
  assert.deepEqual(killed, [], '★ 绝不许杀不是自己的进程')
  assert.equal(sup.status().running, false)
  assert.match(String(sup.status().lastError), /别的程序/, '要说清为什么不起')
})

test('⑬ ★ 同类但查不到 PID ⇒ 也不盲杀，拒绝启动', async () => {
  const { sup, killed } = mkProbeSup({ portState: 'busy', same: true, pid: 0 })
  const started = await sup.start()
  assert.equal(started, false, '★ 没有 PID 就不杀')
  assert.deepEqual(killed, [])
  assert.match(String(sup.status().lastError), /查不到/)
})

test('⑭ 没有端口信息（.env 读不到）⇒ 退回老行为，照常起', async () => {
  const killed = []
  const sup = createBridgeSupervisor({
    settings: mkSettings({ qzoneBridgeDir: mkFakeBridgeDir() }),
    log: () => {},
    readEnv: () => ({ host: '127.0.0.1', port: 0, token: '' }),
    probePort: async () => { throw new Error('不该被调用') },
    killTree: (p) => { killed.push(p) }
  })
  const started = await sup.start()
  assert.equal(started, true, '★ 读不到端口就别探，直接起（向后兼容）')
  assert.deepEqual(killed, [])
  sup.stop()
})
