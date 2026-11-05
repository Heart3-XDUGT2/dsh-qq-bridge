/**
 * `echo_qzone_comments` —— 读某条说说下的评论（2026-10-20 第一件）
 * ==================================================================
 * 补的是**闭环缺口**：`echo_qzone_reply` 要 `tid` + `targetUin`，
 * 而原来 `echo_qzone_read` 只回 `comments: 3` 这种**计数** —— 她永远拿不到这两个值，
 * 等于「有手没眼」。
 *
 * 字段名以**桥的解析器实测**为准（`qzone-bridge/src/qzone/feeds3/comments.ts:580-589`）：
 *   `commentid` / `uin` / `name` / `content` / `createtime`（**全小写**）
 * 这里验两层：服务侧（`qzone.js` 的 `listComments`）归一；工具侧（`relay-tools.js`）出数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createQzoneChannel, QZONE_ACTIONS } from '../lib/qzone.js'

/** 造通道 + 记录打出去的请求；`result` 决定桥回什么。 */
function makeChannel ({ result, settings } = {}) {
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
      qzoneWatchList: '',
      ...settings
    },
    log: () => {},
    getCookies: null,
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : {} })
      const payload = result !== undefined
        ? result
        : { status: 'ok', retcode: 0, data: { commentlist: [] } }
      return { ok: true, text: async () => JSON.stringify(payload) }
    }
  })
  return { ch, calls }
}

test('① get_comment_list 必须在白名单里（否则 call() 直接拒）', () => {
  assert.ok(QZONE_ACTIONS.includes('get_comment_list'),
    '★ 不在白名单 ⇒ 读评论永远发不出去')
})

test('② ★ 桥的**小写**字段能归一成工具要的形状', async () => {
  const { ch, calls } = makeChannel({
    result: {
      status: 'ok',
      retcode: 0,
      data: {
        commentlist: [
          { commentid: 'c1', uin: '880000002', name: '阿岚', content: '不错', createtime: 1792000000, is_reply: false }
        ],
        feeds3_comment_total: 7
      }
    }
  })
  const r = await ch.listComments({ tid: 'tid-abc' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(calls[0].body.tid, 'tid-abc', '要带 tid')
  assert.equal(calls[0].body.user_id, '3783207594', '说说主人用自己的号（缺了桥自己兜）')
  assert.equal(r.total, 7, '总数用桥给的 feeds3_comment_total')
  assert.equal(r.items.length, 1)
  assert.deepEqual(r.items[0], {
    commentId: 'c1', uin: '880000002', name: '阿岚', content: '不错', at: 1792000000, isReply: false
  })
})

test('③ ★ camelCase 那一路（PC 接口）也要认', async () => {
  const { ch } = makeChannel({
    result: {
      status: 'ok',
      retcode: 0,
      data: { comments: [{ commentId: 'c9', uin: '880000003', nickname: '阿乙', content: '同意', createdTime: 1792000100, isReply: true, replyToUin: '880000002' }] }
    }
  })
  const r = await ch.listComments({ tid: 'tid-abc' })
  assert.equal(r.ok, true)
  assert.equal(r.items[0].commentId, 'c9')
  assert.equal(r.items[0].name, '阿乙')
  assert.equal(r.items[0].at, 1792000100)
  assert.equal(r.items[0].replyToUin, '880000002')
})

test('④ 三种容器键都认（commentlist / comment_list / comments）', async () => {
  for (const key of ['commentlist', 'comment_list', 'comments']) {
    const { ch } = makeChannel({
      result: { status: 'ok', retcode: 0, data: { [key]: [{ commentid: 'x', uin: '1', name: 'n', content: 'c', createtime: 1 }] } }
    })
    const r = await ch.listComments({ tid: 't' })
    assert.equal(r.items.length, 1, key + ' 没被认出来')
  }
})

test('⑤ 空 tid ⇒ 本地拒（不发请求）', async () => {
  const { ch, calls } = makeChannel()
  const r = await ch.listComments({})
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'tid-required')
  assert.equal(calls.length, 0, '不该白打一次桥')
})

test('⑥ 通道没开 ⇒ disabled（也不发请求）', async () => {
  const { ch, calls } = makeChannel({ settings: { qzoneEnabled: false } })
  const r = await ch.listComments({ tid: 't' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(calls.length, 0)
})

test('⑦ 桥回失败 ⇒ 原样往上报 reason（不吞）', async () => {
  const { ch } = makeChannel({
    result: { status: 'failed', retcode: 1401, message: 'need login | 0103-87', data: null }
  })
  const r = await ch.listComments({ tid: 't' })
  assert.equal(r.ok, false, '桥失败要让调用方知道')
  assert.ok(String(r.reason ?? '') !== '', '要有 reason')
})

test('⑧ 桥给你空数组 ⇒ ok + items 空（不是错误）', async () => {
  const { ch } = makeChannel({
    result: { status: 'ok', retcode: 0, data: { commentlist: [], feeds3_comment_total: 0 } }
  })
  const r = await ch.listComments({ tid: 't' })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 0)
  assert.equal(r.total, 0)
})


// ---- ★ 2026-10-20：帖主（postUin） ------------------------------------------

test('⑨ ★ 没给 postUin ⇒ 回包留空（**不装成自己的号**）', async () => {
  // ★ 2026-10-20 修：原来兜成 selfUin ⇒ 读别人帖子时会骗她说"帖主是她自己"
  const { ch } = makeChannel({ result: { status: 'ok', retcode: 0, data: { commentlist: [], feeds3_comment_total: 0 } } })
  const out = await ch.listComments({ tid: 't1' })
  assert.equal(out.ok, true)
  assert.equal(out.postUin, '', '★ 不知道就是不知道，别编')
})

test('⑩ ★ 给了 postUin ⇒ 透传给桥的 user_id，并原样回包', async () => {
  const { ch, calls } = makeChannel({ result: { status: 'ok', retcode: 0, data: { commentlist: [] } } })
  const out = await ch.listComments({ tid: 't1', postUin: '880000002' })
  assert.equal(out.ok, true)
  assert.equal(calls[0].body.user_id, '880000002', '★ 读别人的说说要带对帖主')
  assert.equal(out.postUin, '880000002', '★ 回包要告诉调用方这说法属于谁')
})
