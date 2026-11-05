/**
 * 空间**评论事件**接收 —— 2026-10-19（他拍的「方案 A」）
 * ==================================================================
 * 不碰桥的 `src/`，只开桥的评论事件，我们**连出去**收。
 *
 * 为什么是"连出去"：桥的反向 WS 会连到 `6199`，而
 * `lib/onebot.js:375-381` 的 `currentSocket()` 取**最后连上**的那个 OPEN 连接
 * ⇒ 桥若在 NapCat 之后连进来，`send_msg` 会发给桥而不是 NapCat ⇒ **QQ 消息全断**。
 * 所以走桥的正向 `/event`（`server.ts:181`，纯事件，不接受 API 帧）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  QZONE_COMMENT_NOTICE,
  parseQzoneCommentFrame,
  parseWatchList,
  classifyComment,
  createQzoneEventClient,
  bridgeEventUrl
} from '../lib/qzone-events.js'

/** 造一帧桥真实会推的评论事件（形状见 poller.ts:414-434）。 */
const frameOf = (over = {}) => JSON.stringify({
  time: 1_792_000_000,
  post_type: 'notice',
  notice_type: QZONE_COMMENT_NOTICE,
  user_id: 123456,
  sender_name: '阿岚',
  comment_id: 'cid-1',
  comment_content: '不错啊',
  post_uin: 999,
  post_tid: 'tid-1',
  ...over
})

test('① 只认 qzone_comment；其他帧一律 null', () => {
  const ok = parseQzoneCommentFrame(frameOf())
  assert.equal(ok.commentId, 'cid-1')
  assert.equal(ok.userId, '123456')
  assert.equal(ok.userName, '阿岚')
  assert.equal(ok.content, '不错啊')
  assert.equal(ok.postTid, 'tid-1')

  // meta_event（心跳）
  assert.equal(parseQzoneCommentFrame(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' })), null)
  // 别的 notice（新说说 / 点赞）
  assert.equal(parseQzoneCommentFrame(JSON.stringify({ post_type: 'notice', notice_type: 'qzone_like' })), null)
  // 坏 JSON
  assert.equal(parseQzoneCommentFrame('{坏'), null)
  assert.equal(parseQzoneCommentFrame(''), null)
  assert.equal(parseQzoneCommentFrame(null), null)
  // 不是字符串也认（测试/内部直接喂对象）；但没有 comment_id ⇒ 仍返回 null
  assert.equal(parseQzoneCommentFrame({ post_type: 'notice', notice_type: QZONE_COMMENT_NOTICE, user_id: 1 }), null)
})

test('② ★ 没有 comment_id 的评论直接丢（没法增量，宁可丢）', () => {
  assert.equal(parseQzoneCommentFrame(frameOf({ comment_id: '' })), null)
  assert.equal(parseQzoneCommentFrame(frameOf({ comment_id: '  ' })), null)
})

test('③ 白名单解析：只认像 QQ 号的，乱七八糟的丢掉', () => {
  assert.deepEqual([...parseWatchList('123456, 789012;345678，12345')].sort(),
    ['12345', '123456', '345678', '789012'].sort())
  // 太短的（999 / 4 位以下）不像 QQ 号，丢掉
  assert.equal(parseWatchList('999, 123').size, 0)
  assert.equal(parseWatchList('abc, 12, xyz').size, 0)
  assert.equal(parseWatchList('').size, 0)
  assert.equal(parseWatchList(undefined).size, 0)
})

test('④ ★ 三类人三条路：主人 / 白名单 / 其他人', () => {
  const who = { masterId: '111', watchList: new Set(['222', '333']) }
  assert.equal(classifyComment({ userId: '111' }, who), 'master', '主人走用户通道')
  assert.equal(classifyComment({ userId: '222' }, who), 'space', '白名单记成空间事件')
  assert.equal(classifyComment({ userId: '444' }, who), 'ignore', '其他人不回复不进记忆')
  // 主人同时也在白名单里 ⇒ 仍是 master（用户通道优先）
  assert.equal(classifyComment({ userId: '333' }, { masterId: '333', watchList: new Set(['333']) }), 'master')
  // 没有 userId ⇒ 丢
  assert.equal(classifyComment({ userId: '' }, who), 'ignore')
})

test('⑤ ★ 客户端把帧分派对：主人 / 白名单 / 被忽略', () => {
  const got = []
  const c = createQzoneEventClient({
    wsFactory: () => { throw new Error('不该连网') },
    url: () => '',
    who: () => ({ masterId: '111', watchList: new Set(['222']) }),
    onMaster: (ev) => got.push(['master', ev.commentId]),
    onSpace: (ev) => got.push(['space', ev.commentId])
  })
  c.feed(frameOf({ comment_id: 'c-master', user_id: 111 }))
  c.feed(frameOf({ comment_id: 'c-space', user_id: 222 }))
  c.feed(frameOf({ comment_id: 'c-stranger', user_id: 444 }))
  assert.deepEqual(got, [['master', 'c-master'], ['space', 'c-space']])

  const st = c.status()
  assert.equal(st.comments, 3, '三条都解析成了评论')
  assert.equal(st.master, 1)
  assert.equal(st.space, 1)
  assert.equal(st.ignored, 1, '★ 陌生人被忽略（不算任何行为）')
})

test('⑥ ★ 同一个 comment_id 只算一次（重连后桥可能重推）', () => {
  let hits = 0
  const c = createQzoneEventClient({
    wsFactory: () => { throw new Error('不该连网') },
    url: () => '',
    who: () => ({ masterId: '', watchList: new Set(['222']) }),
    onSpace: () => { hits += 1 }
  })
  const f = frameOf({ comment_id: 'same', user_id: 222 })
  c.feed(f); c.feed(f); c.feed(f)
  assert.equal(hits, 1, '★ 去重生效')
  assert.equal(c.status().dup, 2)
})

test('⑦ 别的帧不计入评论（心跳 / 点赞不污染统计）', () => {
  const c = createQzoneEventClient({
    wsFactory: () => { throw new Error('不该连网') },
    url: () => '',
    who: () => ({ masterId: '', watchList: new Set() })
  })
  c.feed(JSON.stringify({ post_type: 'meta_event' }))
  c.feed(JSON.stringify({ post_type: 'notice', notice_type: 'qzone_like' }))
  const st = c.status()
  assert.equal(st.frames, 2)
  assert.equal(st.comments, 0)
  assert.equal(st.bad, 2)
})

test('⑧ 连桥的 URL：/event 路径 + token 走查询参数（桥 server.ts:25-32 认这个）', () => {
  assert.equal(bridgeEventUrl({ host: '127.0.0.1', port: 5700, token: '' }),
    'ws://127.0.0.1:5700/event')
  assert.equal(bridgeEventUrl({ host: '127.0.0.1', port: 5700, token: 'abc' }),
    'ws://127.0.0.1:5700/event?access_token=abc')
  // ★ 缺 host / port ⇒ **空串**（地址一律来自配置，函数里不留默认值 —— nohardcode 闸的要求）
  assert.equal(bridgeEventUrl({}), '', '缺 host/port 必须返回空串，不许回落到写死的地址')
  assert.equal(bridgeEventUrl({ host: '127.0.0.1' }), '', '缺 port 也是空串')
  assert.equal(bridgeEventUrl({ port: 5700 }), '', '缺 host 也是空串')
  // token 要编码
  assert.ok(bridgeEventUrl({ host: 'h', port: 1, token: 'a b&c' }).includes('access_token=a%20b%26c'))
})

test('⑨ 用假 WebSocket 走一遍：连上 → 收帧 → 断开 → 重连', () => {
  const made = []
  const timers = []
  class FakeWs {
    constructor (url) {
      this.url = url
      this.handlers = {}
      this.readyState = 1
      made.push(this)
    }

    on (ev, fn) { (this.handlers[ev] ||= []).push(fn); return this }

    emit (ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg) }

    close () { this.readyState = 3; this.emit('close') }
  }
  const got = []
  const c = createQzoneEventClient({
    wsFactory: (u) => new FakeWs(u),
    url: () => 'ws://127.0.0.1:5700/event',
    who: () => ({ masterId: '', watchList: new Set(['222']) }),
    onSpace: (ev) => got.push(ev.commentId),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref () {} } },
    clearTimer: () => {},
    reconnectMs: 1000
  })
  c.start()
  assert.equal(made.length, 1, '启动即连一次')
  made[0].emit('open')
  made[0].emit('message', frameOf({ comment_id: 'c1', user_id: 222 }))
  assert.deepEqual(got, ['c1'])
  assert.equal(c.status().connected, true)

  // 断开 ⇒ 排一个重连定时器
  made[0].emit('close')
  assert.equal(c.status().connected, false)
  assert.equal(timers.length, 1, '断开后应排重连')
  // 触发重连 ⇒ 又连了一次
  timers[0].fn()
  assert.equal(made.length, 2, '★ 重连真的发了新连接')

  c.stop()
  assert.equal(c.status().running, false)
})

test('⑪ 配置往返：qzoneWatchList 默认空、原样保留、能被 parseWatchList 解析', async () => {
  const { DEFAULT_SETTINGS, parseSettings } = await import('../lib/config.js')
  assert.equal(DEFAULT_SETTINGS.qzoneWatchList, '', '默认必须空 = 谁都不感知（安全默认）')
  assert.equal(parseSettings({}).settings.qzoneWatchList, '')
  assert.equal(parseSettings({ qzoneWatchList: ' 123456,789012 ' }).settings.qzoneWatchList, '123456,789012')
  // 与 parseWatchList 串起来是通的
  assert.deepEqual([...parseWatchList(parseSettings({ qzoneWatchList: '123456,789012' }).settings.qzoneWatchList)].sort(),
    ['123456', '789012'])
})

test('⑩ 没 URL 时不崩，只排重连（桥没起也不炸宿主）', () => {
  const timers = []
  const c = createQzoneEventClient({
    wsFactory: () => { throw new Error('不该连') },
    url: () => '',
    setTimer: (fn) => { timers.push(fn); return { unref () {} } },
    clearTimer: () => {}
  })
  c.start()
  assert.equal(c.status().lastError, 'no-url')
  assert.equal(timers.length, 1, '应排一次重连而不是抛')
  c.stop()
})
