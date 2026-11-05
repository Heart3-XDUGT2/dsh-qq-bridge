/**
 * `listMoods` 的 `uin` 参数 —— 看白名单内某人的空间（2026-10-20 第三件）
 * ==================================================================
 * 桥的 `get_emotion_list` 本来就接任意 `user_id`（`actions.ts:486`）——
 * 是我们自己把 `user_id` 写死成 `selfUin`，所以原来只能看自己。
 *
 * **白名单闸**（他拍的：看别人也要卡）：
 *   · `uin` 空 或 = 自己的号 ⇒ 看自己，**不拦**
 *   · 别的号 ⇒ **必须在 `qzoneWatchList` 里**，否则 `not-in-watchlist`（不发请求）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createQzoneChannel } from '../lib/qzone.js'

const SELF = '3783207594'

function makeChannel ({ watchList = '', msglist = [] } = {}) {
  const calls = []
  const ch = createQzoneChannel({
    settings: {
      qzoneEnabled: true,
      qzoneHost: '127.0.0.1',
      qzonePort: 5700,
      qzoneAccessToken: '',
      qzoneDefaultUgcRight: 1,
      qzoneCookieRefreshMin: 0,
      qzoneSelfUin: SELF,
      qzoneWatchList: watchList
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

const mood = (tid, content) => ({ tid, content, created_time: 1792000000, createTime: '2026-10-20', cmtnum: 1, likenum: 2, fwdnum: 0, pic: [] })

test('① ★ 名单内的人 ⇒ 能看，且 user_id 是**他**的号', async () => {
  const { ch, calls } = makeChannel({ watchList: '880000002', msglist: [mood('t1', '他的说说')] })
  const r = await ch.listMoods({ uin: '880000002', num: 3 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(calls[0].body.user_id, '880000002', '★ 要看的是他，不是自己')
  assert.equal(r.uin, '880000002')
  assert.equal(r.isOthers, true)
  assert.equal(r.items.length, 1)
})

test('② ★ 名单外的人 ⇒ 拒，且**一个请求都不发**', async () => {
  const { ch, calls } = makeChannel({ watchList: '880000002' })
  const r = await ch.listMoods({ uin: '999999' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-in-watchlist')
  assert.equal(calls.length, 0, '★ 拒的时候不许白打一次桥')
})

test('③ 白名单**空**时看别人也拒（同一条纪律）', async () => {
  const { ch, calls } = makeChannel({ watchList: '' })
  const r = await ch.listMoods({ uin: '880000002' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-in-watchlist')
  assert.equal(calls.length, 0)
})

test('④ ★ 看自己**不受限**（不传 uin）', async () => {
  const { ch, calls } = makeChannel({ watchList: '', msglist: [mood('t1', '我的说说')] })
  const r = await ch.listMoods({ num: 3 })
  assert.equal(r.ok, true)
  assert.equal(calls[0].body.user_id, SELF)
  assert.equal(r.isOthers, false)
})

test('⑤ ★ 传自己的号也算"看自己"（不拦）', async () => {
  const { ch, calls } = makeChannel({ watchList: '' })
  const r = await ch.listMoods({ uin: SELF, num: 3 })
  assert.equal(r.ok, true, '自己的号不该被白名单闸挡')
  assert.equal(r.isOthers, false)
  assert.equal(calls[0].body.user_id, SELF)
})

test('⑥ 回归：老调用（num/pos/withImages）行为不变', async () => {
  const { ch, calls } = makeChannel({ msglist: [mood('t1', 'x')] })
  const r = await ch.listMoods({ num: 7, pos: 2, withImages: true })
  assert.equal(r.ok, true)
  assert.equal(calls[0].body.num, 7)
  assert.equal(calls[0].body.pos, 2)
  assert.equal(calls[0].body.include_image_data, true)
})

test('⑦ 条目字段仍与 echo_qzone_read 同款（工具侧好复用）', async () => {
  const { ch } = makeChannel({ watchList: '880000002', msglist: [mood('T1', '内容')] })
  const r = await ch.listMoods({ uin: '880000002' })
  assert.deepEqual(r.items[0], {
    tid: 'T1', content: '内容', createdAt: 1792000000, createdAtText: '2026-10-20',
    comments: 1, likes: 2, forwards: 0, imageCount: 0
  })
})
