/**
 * 群聊「醒来补档」—— 2026-10-18
 * ==================================================================
 * 他拍的口径：「休眠时不处理，唤醒时一次性补拉历史，条数有限制」。
 *
 * 为什么要它（现场）：群休眠时 `decideGroupMessage` 返回 `drop` ⇒ 消息在适配器
 * 就被扔了。journal 实测 **123 条** `drop:群休眠中且没 @她`，而她醒来对
 * 刚才群里说过什么**一无所知**。
 *
 * 这组用例钉住四条纪律：
 *   ① **休眠时一条都不拉**（模块没有定时器；只有 wake / 启动两处调 `pull`）；
 *   ② **醒来只补有限窗口**（默认 20，夹在 5~50）；
 *   ③ **去重靠 messageId**（启动那批 + 醒来那批要合并，不能重复灌）；
 *   ④ **当前那条 @ 她的消息要从补档里剔掉**（它马上会被正常处理）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createGroupHistory,
  normalizeHistory,
  mergeHistory,
  renderHistoryDigest,
  clampHistoryCount,
  DEFAULT_HISTORY_COUNT,
  HISTORY_COUNT_MIN,
  HISTORY_COUNT_MAX
} from '../lib/group-history.js'

/** 造一条 NapCat `get_group_msg_history` 返回里的消息（OneBot v11 形状）。 */
let seq = 0
function msg (over = {}) {
  seq += 1
  return {
    message_id: 'm' + seq,
    time: 1_800_000_000 + seq,
    group_id: 822309315,
    sender: { user_id: '1234567890', nickname: '张三', card: '' },
    message: [{ type: 'text', data: { text: '第' + seq + '句' } }],
    ...over
  }
}

test('① clampHistoryCount：默认 20，越界夹回 5~50', () => {
  assert.equal(DEFAULT_HISTORY_COUNT, 20)
  assert.equal(HISTORY_COUNT_MIN, 5)
  assert.equal(HISTORY_COUNT_MAX, 50)

  assert.equal(clampHistoryCount(undefined), 20, '没配 ⇒ 默认 20')
  assert.equal(clampHistoryCount(0), 5, '0 ⇒ 下限 5（不是"一条都不补"）')
  assert.equal(clampHistoryCount(3), 5, '低于下限 ⇒ 5')
  assert.equal(clampHistoryCount(20), 20)
  assert.equal(clampHistoryCount(999), 50, '高于上限 ⇒ 50（不许把上下文灌爆）')
  assert.equal(clampHistoryCount('abc'), 20, '非数 ⇒ 默认')
  assert.equal(clampHistoryCount(7.9), 7, '取整')
})

test('② normalizeHistory：从 NapCat 返回里认出是谁说的、说了什么、@没@她', () => {
  const data = {
    messages: [
      msg({
        message_id: 'a1',
        time: 1000,
        sender: { user_id: '880000001', nickname: '阿岚', card: '' },
        message: [{ type: 'text', data: { text: '在吗' } }]
      }),
      msg({
        message_id: 'a2',
        time: 1001,
        sender: { user_id: '880000004', nickname: '小明', card: '群名片小明' },
        message: [
          { type: 'at', data: { qq: '3783207594' } },
          { type: 'text', data: { text: ' 你看这个' } }
        ]
      })
    ]
  }
  const out = normalizeHistory(data, { selfId: '3783207594', masterId: '880000001' })
  assert.equal(out.length, 2)
  assert.equal(out[0].messageId, 'a1')
  assert.equal(out[0].isMaster, true, '他的号 ⇒ 主人')
  assert.equal(out[0].atMe, false)
  assert.equal(out[0].text, '在吗')
  assert.equal(out[0].at, 1000 * 1000, 'time 是秒 ⇒ 转毫秒')

  assert.equal(out[1].isMaster, false, '别人的号 ⇒ 非主人')
  assert.equal(out[1].atMe, true, '@ 了她的号 ⇒ atMe')
  assert.equal(out[1].userName, '群名片小明', '群名片优先于昵称（与入站同口径）')
})

test('③ normalizeHistory：没有 messageId 的直接丢（没法去重就不留）', () => {
  const out = normalizeHistory({
    messages: [
      msg({ message_id: '' }),
      msg({ message_id: 'ok1' }),
      msg({ message_id: undefined })
    ]
  }, { selfId: 'x' })
  assert.equal(out.length, 1, '只有带 id 的留下')
  assert.equal(out[0].messageId, 'ok1')
})

test('④ mergeHistory：按 messageId 去重，只留最新 limit 条（升序）', () => {
  const older = [
    { messageId: 'x1', at: 100 },
    { messageId: 'x2', at: 200 }
  ]
  const newer = [
    { messageId: 'x2', at: 200 },   // 重复
    { messageId: 'x3', at: 300 },
    { messageId: 'x4', at: 400 }
  ]
  const merged = mergeHistory(older, newer, 10)
  assert.deepEqual(merged.map((e) => e.messageId), ['x1', 'x2', 'x3', 'x4'], '去重且升序')

  const capped = mergeHistory(older, newer, 2)
  assert.deepEqual(capped.map((e) => e.messageId), ['x3', 'x4'], '★ 只留最新 2 条')
})

test('⑤ renderHistoryDigest：空 ⇒ 空串（不注入任何东西）', () => {
  assert.equal(renderHistoryDigest([]), '')
  assert.equal(renderHistoryDigest(null), '')
  assert.equal(renderHistoryDigest(undefined), '')
})

test('⑥ renderHistoryDigest：主人在补档里要标出来，群友带 #后四位', () => {
  const entries = [
    { messageId: 'a', at: 1_800_000_000_000, userId: '1234567890', userName: '张三', isMaster: false, text: '我也觉得' },
    { messageId: 'b', at: 1_800_000_100_000, userId: '880000001', userName: '阿岚', isMaster: true, text: '等下我找她' },
    { messageId: 'c', at: 1_800_000_200_000, userId: '5556667777', userName: '', isMaster: false, text: '' }
  ]
  const t = renderHistoryDigest(entries, { now: 1_800_000_200_000 })
  assert.match(t, /共 3 条，旧→新/, '要写清条数')
  assert.match(t, /张三#7890：我也觉得/, '群友带后四位')
  assert.match(t, /阿岚（主人）：等下我找她/, '★ 主人在补档里要标出来')
  assert.match(t, /QQ5556667777：\[发了图片\/表情，没写字\]/, '空昵称用 QQ 号；空正文也要有交代')
  assert.match(t, /不是对你说的/, '要说明这不是对她说的')
  assert.match(t, /补档结束。以下这条才是刚刚在等你的/, '★ 必须收口，否则模型会把历史当新指令')
})

test('⑦ createGroupHistory.pull：拉一次就进缓冲；失败静默降级', async () => {
  const calls = []
  const h = createGroupHistory({
    fetch: async (gid, n) => {
      calls.push([gid, n])
      return { messages: [msg({ message_id: 'p1', time: 5000 }), msg({ message_id: 'p2', time: 5001 })] }
    }
  })
  const got = await h.pull('822309315', 20, { selfId: 's', masterId: 'm' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['822309315', 20])
  assert.equal(got.length, 2)
  assert.equal(h.list('822309315').length, 2)

  // 失败（fetch 抛）
  const bad = createGroupHistory({ fetch: async () => { throw new Error('boom') } })
  const got2 = await bad.pull('g', 20)
  assert.deepEqual(got2, [], '★ 拉失败 ⇒ 空，绝不抛（补档是增益，不许拖累唤醒）')
  assert.equal(bad.status().failed, 1)
})

test('⑧ createGroupHistory.digest：★ 当前那条 @ 她的消息要被剔掉（防重复）', async () => {
  const h = createGroupHistory({
    fetch: async () => ({
      messages: [
        msg({ message_id: 'old1', time: 100, sender: { user_id: '1', nickname: '甲' }, message: [{ type: 'text', data: { text: '早说' } }] }),
        msg({ message_id: 'now', time: 200, sender: { user_id: '880000001', nickname: '阿岚' }, message: [{ type: 'text', data: { text: '在吗' } }] })
      ]
    })
  })
  await h.pull('g', 20, { selfId: 's', masterId: '880000001' })
  const d = h.digest('g', { limit: 20, excludeMessageId: 'now', now: 200 * 1000 })
  assert.ok(d.includes('早说'), '历史要留')
  assert.equal(d.includes('：在吗'), false, '★ 当前这条必须剔掉（它马上会被正常处理）')
})

test('⑨ createGroupHistory.pull：条数真的被 limit 截断', async () => {
  let asked = null
  const h = createGroupHistory({
    fetch: async (gid, n) => {
      asked = n
      const list = []
      for (let i = 0; i < 60; i++) list.push(msg({ message_id: 'q' + i, time: 1000 + i }))
      return { messages: list }
    }
  })
  await h.pull('g', 999, { selfId: 's' })     // 越界 ⇒ 夹到 50
  assert.equal(asked, 50, '★ 传 999 要夹成 50 再去拉')
  assert.ok(h.list('g').length <= 50, '缓冲也不许超过上限，实际 ' + h.list('g').length)
})

test('⑩ createGroupHistory：两批合并且不重复（启动一批 + 醒来一批）', async () => {
  let round = 0
  const h = createGroupHistory({
    fetch: async () => {
      round += 1
      if (round === 1) {
        // 启动那批：3 条
        return { messages: [msg({ message_id: 'b1', time: 100 }), msg({ message_id: 'b2', time: 200 }), msg({ message_id: 'b3', time: 300 })] }
      }
      // 醒来那批：后 2 条重叠 + 1 条新
      return { messages: [msg({ message_id: 'b3', time: 300 }), msg({ message_id: 'b4', time: 400 }), msg({ message_id: 'b5', time: 500 })] }
    }
  })
  await h.pull('g', 20)
  await h.pull('g', 20)
  const ids = h.list('g').map((e) => e.messageId)
  assert.deepEqual(ids, ['b1', 'b2', 'b3', 'b4', 'b5'], '★ 5 条去重后合并（不是 6 条）')
})

test('⑪ 静态闸：休眠时不许有任何定时器/轮询去拉历史', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('../lib/group-history.js', import.meta.url)), 'utf8')
  for (const bad of ['setInterval', 'setTimeout']) {
    assert.equal(src.includes(bad), false,
      '★ group-history.js 里不许有 ' + bad + ' —— 他拍的是"休眠时不处理"，'
      + '一旦有定时器就变成一直在偷听')
  }
  // index.js 里 pull 只能出现在 wake 分支和启动补拉两处
  const idx = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const pulls = (idx.match(/groupHistory\.pull\(/g) || []).length
  assert.equal(pulls, 2, '★ groupHistory.pull 只该有两处：唤醒补档 + 启动补拉，实际 ' + pulls)
})

test('⑫ 静态闸：补档字段名叫 historyDigest，且私聊不许带', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const envSrc = readFileSync(fileURLToPath(new URL('../lib/envelope.js', import.meta.url)), 'utf8')
  assert.ok(envSrc.includes('historyDigest'), '信封要有这个字段')
  assert.match(envSrc, /isGroup && String\(historyDigest/, '★ 只有群聊才带（私聊没有"群休眠"这回事）')
  // 主包侧要认得它
  const relaySrc = readFileSync(fileURLToPath(new URL('../../dsh-memory-agent/lib/relay.js', import.meta.url)), 'utf8')
  assert.ok(relaySrc.includes('historyDigest'), '主包 parseEnvelope 要透传它')
  assert.ok(relaySrc.includes('const archive'), '主包 renderInboundText 要渲染它')
})
