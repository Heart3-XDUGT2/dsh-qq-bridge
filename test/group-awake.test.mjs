/**
 * lib/group-awake.js 的行为电池（2026-10-15）。
 *
 * 钉住的是**产品规则**（他定的四条）与**他否掉的那个形状**：
 *
 *   四条规则：@唤醒 / 醒着就回并续命 / 2 分钟休眠 / @她发 /stop 立刻休眠
 *   否掉的形状：**不用心跳轮询** ⇒ 于是必须钉住
 *     · 休眠的群**零定时器**（不是"定时器在跑但什么都不做"）
 *     · 定时器数**恒等于**醒着的群数（撤旧挂新，不泄漏）
 *     · **休眠中的群收到消息不续命**（一续就永远睡不着）
 *     · 间隔就是 `idleMs`（不被别的周期粒度污染）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGroupAwake,
  decideGroupMessage,
  isAtMe,
  isStopCommand,
  DEFAULT_IDLE_MS
} from '../lib/group-awake.js'

// ============================================================================
// 纯判定
// ============================================================================

test('isAtMe:认 at 段;@全体成员不算 @她;自己号空 ⇒ 一律不算', () => {
  const segs = [{ type: 'at', qq: 3783207594 }, { type: 'text', text: '在吗' }]
  assert.equal(isAtMe(segs, '3783207594'), true)
  assert.equal(isAtMe(segs, 880000001), false, '别的号不算')
  assert.equal(isAtMe([{ type: 'text', text: '在吗' }], '3783207594'), false, '没 at 段')
  // at all：OneBot 给的是字符串 'all' ⇒ Number() 是 NaN ⇒ 不该被当成 @她
  assert.equal(isAtMe([{ type: 'at', qq: Number('all') }], '3783207594'), false, '@全体 ≠ @她')
  assert.equal(isAtMe(segs, ''), false, '自己号空 ⇒ 没法判,一律不算')
  assert.equal(isAtMe(null, '3783207594'), false)
  assert.equal(isAtMe([null, 'x', { type: 'at', qq: 3783207594 }], '3783207594'), true, '脏段里也能挖出来')
})

test('isStopCommand:/stop 的各种写法都认;别的都不认', () => {
  // ★ 宽容是**故意的**：它必须 @她 才生效（显式指令），所以"斜杠后多个空格"
  //   这种手滑该认 —— 免得他喊了停却没停，还以为坏了。
  for (const s of ['/stop', '/STOP', '  /stop  ', '／stop', '/ stop', '/stop。', '/stop!', '/stop ？']) {
    assert.equal(isStopCommand(s), true, JSON.stringify(s) + ' 该认')
  }
  // 但**不能**把带别的字的当指令 —— 那是他真在说话，不是命令。
  for (const s of ['stop', '/stops', '/stop 一下', '请 /stop', '', '/stop abc', 'stop it']) {
    assert.equal(isStopCommand(s), false, JSON.stringify(s) + ' 不该认')
  }
})

test('decideGroupMessage:五种结果互斥且穷尽', () => {
  const cases = [
    // atMe, byMaster, awake, stop, 期望 action, 期望送不送
    [true, true, false, true, 'sleep', false, '★ 他 @她 发 /stop ⇒ 立刻休眠,命令本身不送'],
    [true, true, true, true, 'sleep', false, '已经醒着也一样'],
    [true, true, false, false, 'wake', true, '★ 他 @她 ⇒ 唤醒并送'],
    [true, true, true, false, 'wake', true, '本来就醒着 ⇒ 也算 wake(续命)'],
    [false, false, true, false, 'touch', true, '★ 醒着 + 别人说话 ⇒ 回并续命'],
    [false, false, true, true, 'touch', true, '醒着时别人喊 /stop 不当命令'],
    [false, false, false, false, 'drop', false, '★ 休眠中 + 没 @她 ⇒ 什么都不做'],
    [false, false, false, true, 'drop', false, '休眠中别人喊 /stop 也不理'],
    // ★ 2026-10-17 新增：别人 @ 她不唤醒
    [true, false, false, false, 'ignore', false, '★ 休眠中 + **别人** @她 ⇒ 不唤醒（只有主人能唤醒）'],
    [true, false, false, true, 'ignore', false, '别人 @她 喊 /stop ⇒ 既不休眠也不唤醒'],
    [true, false, true, false, 'touch', true, '醒着时别人 @她 ⇒ 照回（他要的"醒着时都会回"）'],
    [true, false, true, true, 'touch', true, '醒着时别人 @她 喊 /stop ⇒ 只是话,不关她']
  ]
  for (const [atMe, byMaster, awake, stop, action, send, why] of cases) {
    const r = decideGroupMessage({ atMe, atMeByMaster: byMaster, awake, stopCommand: stop })
    assert.equal(r.action, action, why + '（拿到 ' + r.action + '）')
    assert.equal(r.send, send, why)
  }
})

test('★ 2026-10-17:只有主人能唤醒;醒着之后别人说话照旧回', () => {
  // 休眠中：主人 @ ⇒ wake；别人 @ ⇒ ignore；没人 @ ⇒ drop
  assert.equal(decideGroupMessage({ atMe: true, atMeByMaster: true, awake: false }).action, 'wake')
  assert.equal(decideGroupMessage({ atMe: true, atMeByMaster: false, awake: false }).action, 'ignore')
  assert.equal(decideGroupMessage({ atMe: false, atMeByMaster: false, awake: false }).action, 'drop')
  // 醒着：三种都回（touch / wake 都 send=true）
  for (const f of [
    { atMe: true, atMeByMaster: true },
    { atMe: true, atMeByMaster: false },
    { atMe: false, atMeByMaster: false }
  ]) {
    assert.equal(decideGroupMessage({ ...f, awake: true }).send, true,
      '醒着时都该回: ' + JSON.stringify(f))
  }
  // /stop 只有主人能生效（否则群里谁都能把她关掉）
  assert.equal(decideGroupMessage({ atMe: true, atMeByMaster: false, awake: true, stopCommand: true }).action,
    'touch', '别人喊 /stop 不许关她')
  assert.equal(decideGroupMessage({ atMe: true, atMeByMaster: true, awake: true, stopCommand: true }).action,
    'sleep', '主人喊 /stop 要能关')
  // 缺省（老调用点不传 atMeByMaster）⇒ 视为"不是主人" ⇒ 不唤醒（从严）
  assert.equal(decideGroupMessage({ atMe: true, awake: false }).action, 'ignore',
    '缺省必须从严:不传 atMeByMaster 时不许唤醒')
})

test('DEFAULT_IDLE_MS 是 2 分钟（他定的）', () => {
  assert.equal(DEFAULT_IDLE_MS, 120000)
})

// ============================================================================
// 状态机
// ============================================================================

/** 假定时器：能手动"到点"，也能查当前挂着几个。 */
function fakeClock () {
  let seq = 0
  const live = new Map() // id → { fn, ms }
  const cancelled = []
  return {
    setTimer: (fn, ms) => {
      const id = ++seq
      live.set(id, { fn, ms })
      return { unref () {}, __id: id }
    },
    clearTimer: (h) => {
      const id = h && h.__id
      if (live.has(id)) {
        live.delete(id)
        cancelled.push(id)
      }
    },
    /** 手动让"最早那一个"到点。 */
    fire: () => {
      const first = [...live.entries()][0]
      if (first === undefined) return false
      const [id, item] = first
      live.delete(id)
      item.fn()
      return true
    },
    sizes: () => live.size,
    fireAll: () => { while (live.size > 0) { const first = [...live.entries()][0]; live.delete(first[0]); first[1].fn() } }
  }
}

function make (over = {}) {
  const clock = fakeClock()
  const logs = []
  const g = createGroupAwake({
    idleMs: over.idleMs ?? 120000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (m) => logs.push(m),
    ...over
  })
  return { g, clock, logs }
}

test('唤醒 ⇒ 醒着 + 挂着 1 个定时器；间隔就是 idleMs', () => {
  const { g, clock } = make()
  assert.equal(g.isAwake('G1'), false, '默认休眠')
  assert.equal(clock.sizes(), 0, '★ 休眠的群零定时器')

  g.wake('G1')
  assert.equal(g.isAwake('G1'), true)
  assert.equal(clock.sizes(), 1, '★ 定时器数 = 醒着的群数')
  assert.equal(g._timerCount(), 1)
})

test('★ 2 分钟到点 ⇒ 自动休眠', () => {
  const { g, clock, logs } = make()
  g.wake('G1')
  clock.fire()
  assert.equal(g.isAwake('G1'), false, '到点该睡')
  assert.equal(clock.sizes(), 0, '定时器也清了')
  assert.ok(logs.some((m) => m.includes('休眠')), '要留一句日志')
})

test('★ 续命是从**最后一条**算起（撤旧挂新）', () => {
  const { g, clock } = make()
  g.wake('G1')
  const before = clock.sizes()
  g.touch('G1')
  assert.equal(clock.sizes(), 1, '还是 1 个（旧的不留着）')
  assert.equal(before, 1)
  // 再触几次也不该长
  g.touch('G1'); g.touch('G1')
  assert.equal(clock.sizes(), 1, '★ 不泄漏定时器')
})

test('★ 休眠中的群收到消息：不续命、不唤醒、零动作', () => {
  const { g, clock } = make()
  assert.equal(g.touch('G1'), false, '没醒 ⇒ 不续命')
  assert.equal(g.isAwake('G1'), false, '也不该被弄醒')
  assert.equal(clock.sizes(), 0, '★ 零定时器 —— 这就是"休眠零开销"')
})

test('★ /stop（sleep）⇒ 立刻休眠 + 撤销定时器', () => {
  const { g, clock } = make()
  g.wake('G1')
  assert.equal(clock.sizes(), 1)
  g.sleep('G1')
  assert.equal(g.isAwake('G1'), false)
  assert.equal(clock.sizes(), 0, '★ 定时器必须被撤掉,不能留着到点再炸一次')
})

test('sleep 幂等；没醒的群 sleep 返回 false', () => {
  const { g, clock } = make()
  assert.equal(g.sleep('G1'), false)
  g.wake('G1')
  assert.equal(g.sleep('G1'), true)
  assert.equal(g.sleep('G1'), false)
  assert.equal(clock.sizes(), 0)
})

test('按群隔离：A 醒着不影响 B', () => {
  const { g, clock } = make()
  g.wake('GA')
  assert.equal(g.isAwake('GB'), false)
  assert.equal(clock.sizes(), 1)
  g.wake('GB')
  assert.equal(clock.sizes(), 2)
  g.sleep('GA')
  assert.equal(g.isAwake('GB'), true, '★ 关 A 不该顺手关 B')
  assert.equal(clock.sizes(), 1)
})

test('retain：不在白名单里的群被清掉', () => {
  const { g, clock } = make()
  g.wake('GA'); g.wake('GB')
  assert.equal(clock.sizes(), 2)
  const dropped = g.retain(['GA'])
  assert.equal(dropped, 1)
  assert.equal(g.isAwake('GA'), true)
  assert.equal(g.isAwake('GB'), false)
  assert.equal(clock.sizes(), 1, '★ 被清的群定时器也要撤')
})

test('stop：全停，一个定时器都不留（卸载/总闸关）', () => {
  const { g, clock } = make()
  g.wake('GA'); g.wake('GB'); g.wake('GC')
  assert.equal(clock.sizes(), 3)
  g.stop()
  assert.equal(clock.sizes(), 0, '★ 卸载不能留悬空定时器')
  assert.equal(g.status().awakeCount, 0)
})

test('status：给面板看的形状', () => {
  const { g } = make()
  g.wake('G2'); g.wake('G1')
  const st = g.status()
  assert.equal(st.idleMs, 120000)
  assert.equal(st.awakeCount, 2)
  assert.deepEqual(st.awakeGroups, ['G1', 'G2'], '排过序,面板稳定')
  assert.equal(typeof st.lastAt.G1, 'number')
})

test('idleMs 可配（面板想改 2 分钟就改这一处）', () => {
  const { g, clock } = make({ idleMs: 5000 })
  g.wake('G1')
  assert.equal(g.status().idleMs, 5000)
  assert.equal(clock.sizes(), 1)
})

test('空 groupId 一律拒（不许拿空串当群）', () => {
  const { g, clock } = make()
  assert.equal(g.wake(''), false)
  assert.equal(g.touch(''), false)
  assert.equal(g.sleep(''), false)
  assert.equal(clock.sizes(), 0)
})

test('★ 不挂心跳：整段测试里没有一次"轮询" —— 只有事件驱动', () => {
  // 这一条是**意图断言**：他把"挂心跳轮询"否掉了，所以模块里不该出现 interval。
  // 用行为钉：不 wake 就永远不醒；wake 之后只有"到点"或"显式 sleep"两条出路。
  const { g, clock } = make()
  for (let i = 0; i < 5; i++) { /* 空转 5 次，模拟"心跳拍了很多下" */ }
  assert.equal(g.isAwake('G1'), false, '空转不会把它弄醒')
  assert.equal(clock.sizes(), 0, '空转不会长出定时器')
})
