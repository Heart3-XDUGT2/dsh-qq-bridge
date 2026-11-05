/**
 * `listFeeds` —— 读好友动态，**按 qzoneWatchList 过滤**（2026-10-20 第二件）
 * ==================================================================
 * 桥那边用的是 **`get_friend_feeds`**（`actions.ts:896`），不是 `get_feeds_html_act_all` ——
 * 权威用法在桥自己的 `poller.ts:883`：它轮好友流用的就是 `getFriendFeeds('', 20)`。
 *
 * 三条纪律（都验）：
 *   ① 白名单为空 ⇒ **直接拒**（`watchlist-empty`），不许退化成"全看"
 *   ② 名单外的人 **一条都不返回**
 *   ③ 多拉再筛（`count*3`），筛完截到 `count`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createQzoneChannel, QZONE_ACTIONS } from '../lib/qzone.js'

/** 造通道；`msglist` 决定桥回什么。 */
function makeChannel ({ msglist = [], watchList = '', settings } = {}) {
  const calls = []
  const ch = createQzoneChannel({
    settings: {
      qzoneEnabled: true,
      qzoneHost: '127.0.0.1',
      qzonePort: 5700,
      qzoneAccessToken: '',
      qzoneDefaultUgcRight: 1,
      qzoneCookieRefreshMin: 0,
      qzoneSelfUin: '3783207594',
      qzoneWatchList: watchList,
      ...settings
    },
    log: () => {},
    getCookies: null,
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : {} })
      return {
        ok: true,
        text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { msglist, has_more: false } })
      }
    }
  })
  return { ch, calls }
}

const feed = (uin, tid, content) => ({ tid, uin, nickname: 'n' + uin.slice(-4), content, created_time: 1792000000, cmtnum: 1, likenum: 2 })

test('① get_friend_feeds 必须在白名单里', () => {
  assert.ok(QZONE_ACTIONS.includes('get_friend_feeds'),
    '★ 不在白名单 ⇒ 读好友动态永远发不出去')
})

test('② ★ 名单外的人**一条都不返回**（不是标记，是不给）', async () => {
  const { ch } = makeChannel({
    watchList: '880000002,880000003',
    msglist: [feed('880000002', 't1', '名单内A'), feed('999999', 't2', '名单外'), feed('880000003', 't3', '名单内B')]
  })
  const r = await ch.listFeeds({ count: 10 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.count, 2)
  assert.deepEqual(r.items.map((i) => i.uin), ['880000002', '880000003'], '★ 999999 必须被筛掉')
  assert.equal(r.scanned, 3, '要报"共扫了几条"，好解释为什么少了')
})

test('③ ★ 白名单为空 ⇒ 直接拒（不许退化成全看）', async () => {
  const { ch, calls } = makeChannel({ watchList: '', msglist: [feed('880000002', 't1', 'x')] })
  const r = await ch.listFeeds({ count: 10 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'watchlist-empty')
  assert.equal(calls.length, 0, '★ 空名单不该白打一次桥')
})

test('④ 多拉再筛：请求的 num 是 count*3（上限 200）', async () => {
  const { ch, calls } = makeChannel({ watchList: '880000002', msglist: [] })
  await ch.listFeeds({ count: 10 })
  assert.equal(calls[0].body.num, 30, 'count=10 ⇒ 拉 30')
  const { ch: c2, calls: k2 } = makeChannel({ watchList: '880000002', msglist: [] })
  await c2.listFeeds({ count: 50 })
  assert.equal(k2[0].body.num, 150, 'count=50 ⇒ 拉 150')
})

test('⑤ 筛完截到 count（多的不要）', async () => {
  const many = Array.from({ length: 20 }, (_, i) => feed('880000002', 't' + i, 'c' + i))
  const { ch } = makeChannel({ watchList: '880000002', msglist: many })
  const r = await ch.listFeeds({ count: 5 })
  assert.equal(r.count, 5, '要 5 条就只给 5 条')
  assert.equal(r.scanned, 20, '但 scanned 报真实的 20')
})

test('⑥ 通道没开 ⇒ disabled（不发请求）', async () => {
  const { ch, calls } = makeChannel({ settings: { qzoneEnabled: false } })
  const r = await ch.listFeeds({ count: 5 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(calls.length, 0)
})

test('⑦ 桥回失败 ⇒ 原样上报（不吞）', async () => {
  const ch = createQzoneChannel({
    settings: {
      qzoneEnabled: true, qzoneHost: '127.0.0.1', qzonePort: 5700, qzoneAccessToken: '',
      qzoneDefaultUgcRight: 1, qzoneCookieRefreshMin: 0, qzoneSelfUin: '3783207594', qzoneWatchList: '880000002'
    },
    log: () => {},
    getCookies: null,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ status: 'failed', retcode: 1401, message: 'need login', data: null }) })
  })
  const r = await ch.listFeeds({ count: 5 })
  assert.equal(r.ok, false)
  assert.ok(String(r.reason ?? '') !== '', '要有 reason')
})

test('⑧ 条目字段归一（tid/uin/nickname/content/created_time/cmtnum/likenum）', async () => {
  const { ch } = makeChannel({
    watchList: '880000002',
    msglist: [{ tid: 'T1', uin: '880000002', nickname: '阿岚', content: '你好', created_time: 1792000123, cmtnum: 4, likenum: 9 }]
  })
  const r = await ch.listFeeds({ count: 5 })
  assert.deepEqual(r.items[0], {
    tid: 'T1', uin: '880000002', name: '阿岚', content: '你好', at: 1792000123, comments: 4, likes: 9
  })
})
