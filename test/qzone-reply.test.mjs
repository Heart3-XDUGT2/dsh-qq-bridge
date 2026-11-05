/**
 * 回复空间评论 —— 2026-10-19（第四件）
 * ==================================================================
 * 桥的 `send_comment`（`actions.ts:398`）参数：
 *   `tid` / `target_tid`（必填）· `content`（必填）
 *   `user_id` / `target_uin`（说说主人）· `reply_comment_id` / `reply_uin`（二级回复）
 *
 * **白名单闸放在 `qzone.js` 的 `replyComment` 里**（配置所在地），不放到主包 ——
 * 只有 `targetUin` 在白名单里、或就是他本人，才允许回。
 * 名单外的人一律拒（与「不回复、不进记忆」同一条纪律）。
 *
 * ## ★ 2026-10-20 修的一个必错 bug
 *
 * 原来 `target_uin` 传的是**评论人**，但桥的 `commentEmotion(ouin, tid, ...)` 拿它拼
 * `hostUin: ouin` / `topicId: \`${ouin}_${tid}\``（`client.ts:4237-4238`）——
 * 那是**帖主**。于是 topicId 指向"评论人的空间里的这条 tid" ⇒ 不存在 ⇒ **评论 100% 失败**。
 * 而且 `client.ts:4210` 只在 `!ouin` 时才用缓存补真帖主 ⇒ 传错了桥纠正不了。
 *
 * 现在：`target_uin` = **帖主**（`selfUin`，她只在自己说说下回）、
 * `reply_uin` = **评论人**（桥拿它拼 `@{uin:xxx,nick:yyy,auto:1}`）。
 *
 * 测试能这么做是因为 `cfg()` 的 `readSettings` 是**注入的**
 * （`qzone.js:232`：`typeof settings === 'function' ? settings : () => settings`）——
 * 传个对象进去就行，不碰真实 config.json。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createQzoneChannel, QZONE_ACTIONS } from '../lib/qzone.js'

/** 造通道 + 记录它发出去的那些 HTTP 调用。 */
function makeChannel (settings, { onCall } = {}) {
  const calls = []
  const ch = createQzoneChannel({
    settings: {
      qzoneEnabled: true,
      qzoneHost: '127.0.0.1',
      qzonePort: 5700,
      qzoneAccessToken: '',
      qzoneDefaultUgcRight: 1,
      qzoneCookieRefreshMin: 0,
      qzoneSelfUin: '900999',
      qzoneWatchList: '200222, 300333',
      masterId: '100111',
      ...settings
    },
    log: () => {},
    getCookies: null,
    fetchImpl: async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : {}
      calls.push({ url, body })
      if (typeof onCall === 'function') return onCall(url, body)
      return {
        ok: true,
        text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: {} })
      }
    }
  })
  return { ch, calls }
}

test('① send_comment 已在白名单里（否则 call() 会直接拒）', () => {
  assert.ok(QZONE_ACTIONS.includes('send_comment'), '★ 不在白名单 ⇒ 回复永远发不出去')
})

test('② ★ 白名单里的人 ⇒ 放行，参数形状对', async () => {
  const { ch, calls } = makeChannel()
  const r = await ch.replyComment({ tid: 'tid-1', content: '谢谢呀', targetUin: '200222' })
  assert.equal(r.ok, true, '应当成功: ' + JSON.stringify(r))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.endsWith('/send_comment'), '应打到 /send_comment')
  assert.equal(calls[0].body.target_tid, 'tid-1')
  assert.equal(calls[0].body.content, '谢谢呀')
  // ★ 2026-10-20 再改：**postUin 空时压根不传 target_uin** ——
  //   让桥走它的三级兜底（target_uin → postMetaCache 的真帖主 → 自己）。
  //   硬塞 selfUin 会把第一级填死 ⇒ 在别人的说说下必然拼错 topicId。
  assert.equal('target_uin' in calls[0].body, false,
    '★ 不传才是对的：桥会从 postMetaCache 解析真帖主')
  // ★ 评论人只走 reply_uin（桥拿它做 @ 提及）
  assert.equal(calls[0].body.reply_uin, '200222',
    '★ 评论人要放在 reply_uin，不能塞进 target_uin')
})

test('③ ★ 名单外的人 ⇒ 拒，且**一个请求都不发**', async () => {
  const { ch, calls } = makeChannel()
  const r = await ch.replyComment({ tid: 'tid-1', content: '你好', targetUin: '400444' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-in-watchlist')
  assert.equal(calls.length, 0, '★ 拒的时候不许真的发出去')
})

test('④ ★ 他本人（masterId）即使不在白名单也放行', async () => {
  const { ch, calls } = makeChannel({ qzoneWatchList: '' })
  const r = await ch.replyComment({ tid: 'tid-1', content: '在呢', targetUin: '100111' })
  assert.equal(r.ok, true, '主人的评论照旧可回: ' + JSON.stringify(r))
  assert.equal(calls.length, 1)
})

test('⑤ 空 tid / 空内容 / 超长 ⇒ 都在本地拒（不发请求）', async () => {
  const { ch, calls } = makeChannel()
  assert.equal((await ch.replyComment({ tid: '', content: 'x', targetUin: '200222' })).reason, 'tid-required')
  assert.equal((await ch.replyComment({ tid: 't', content: '   ', targetUin: '200222' })).reason, 'content-required')
  const long = 'x'.repeat(1600)
  assert.equal((await ch.replyComment({ tid: 't', content: long, targetUin: '200222' })).reason, 'content-too-long')
  assert.equal(calls.length, 0)
})

test('⑥ 通道没开 ⇒ 直接拒（disabled）', async () => {
  const { ch, calls } = makeChannel({ qzoneEnabled: false })
  const r = await ch.replyComment({ tid: 't', content: 'x', targetUin: '200222' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(calls.length, 0)
})

test('⑦ 二级回复：带 commentId 时透传 reply_comment_id', async () => {
  const { ch, calls } = makeChannel()
  await ch.replyComment({ tid: 'tid-1', content: '回你', targetUin: '200222', replyCommentId: 'c-9' })
  assert.equal(calls[0].body.reply_comment_id, 'c-9')
  // ★ 桥的 `client.ts:4218` 要**同时**有 reply_comment_id 和 reply_uin 才加 @ 提及
  assert.equal(calls[0].body.reply_uin, '200222', '★ 缺了它就不会变成"回复某某"')
  assert.equal('target_uin' in calls[0].body, false, '★ 帖主交给桥解析')
  // 不带就不该出现这个字段（桥那边 undefined 与"空"语义不同）
  const { ch: ch2, calls: calls2 } = makeChannel()
  await ch2.replyComment({ tid: 'tid-1', content: '回你', targetUin: '200222' })
  assert.equal('reply_comment_id' in calls2[0].body, false)
})

test('⑧ 桥回错误 ⇒ 把错误往上抛（不吞）', async () => {
  const { ch } = makeChannel({}, {
    onCall: async () => ({
      ok: true,
      text: async () => JSON.stringify({ status: 'failed', retcode: 1500, message: '风控' })
    })
  })
  const r = await ch.replyComment({ tid: 't', content: 'x', targetUin: '200222' })
  assert.equal(r.ok, false, '桥失败要让调用方知道')
})


test('⑨ ★ selfUin 没配 + postUin 空 ⇒ 仍发请求，把帖主留给桥解析', async () => {
  // ★ 2026-10-20 再改：原来这里本地拒（self-uin-missing）。
  //   但桥的兜底链是 target_uin → postMetaCache → client.qqNumber，
  //   我们不该替它做决定 —— 未登录时桥自己会回 1401。
  const { ch, calls } = makeChannel({ qzoneSelfUin: '' })
  const r = await ch.replyComment({ tid: 'tid-1', content: 'x', targetUin: '200222' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal('target_uin' in calls[0].body, false, '★ 不传，交给桥')
})

test('⑩ ★ 显式给 replyUin 时优先用它（将来"别人空间回复"走这条）', async () => {
  const { ch, calls } = makeChannel()
  await ch.replyComment({
    tid: 'tid-1', content: 'x', targetUin: '200222',
    replyCommentId: 'c-9', replyUin: '300333'
  })
  assert.equal(calls[0].body.reply_uin, '300333', '显式值要覆盖')
  assert.equal('target_uin' in calls[0].body, false, '帖主仍交给桥解析')
})


// ---- ★ 2026-10-20：postUin（别人的说说）+ 甲方案两把闸 ------------------------

test('⑪ ★ postUin 空 ⇒ **不传 target_uin**（交给桥的三级兜底）', async () => {
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({ tid: 'tid-1', content: 'x', targetUin: '200222' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal('target_uin' in calls[0].body, false,
    '★ 不传 ⇒ 桥用 postMetaCache 里的真帖主；缓存没有时它自己落到「自己」')
})

test('⑫ ★ postUin 有值 ⇒ target_uin = postUin（别人的说说）', async () => {
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({ tid: 'tid-1', content: 'x', targetUin: '200222', postUin: '300333' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(calls[0].body.target_uin, '300333', '★ 帖主 = 别人')
  assert.equal(calls[0].body.reply_uin, '200222', '评论人仍走 reply_uin')
})

test('⑬ ★ 闸①：postUin 不在白名单 ⇒ post-not-in-watchlist（且不发请求）', async () => {
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({ tid: 'tid-1', content: 'x', targetUin: '200222', postUin: '400444' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'post-not-in-watchlist')
  assert.equal(calls.length, 0, '★ 不去别人的地盘说话，一个请求都不发')
})

test('⑭ ★ 闸②（甲）：postUin 合法但 targetUin 不在白名单 ⇒ 仍然拒', async () => {
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({ tid: 'tid-1', content: 'x', targetUin: '400444', postUin: '300333' })
  assert.equal(out.ok, false, '★ 甲：**两把闸都要过**')
  assert.equal(out.reason, 'not-in-watchlist')
  assert.equal(calls.length, 0)
})

test('⑮ ★ 守卫：postUin 和 targetUin 都空 ⇒ owner-required', async () => {
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({ tid: 'tid-1', content: 'x' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'owner-required')
  assert.equal(calls.length, 0)
})

test('⑯ ★ postUin = 自己的号 ⇒ 当作自己的说说（闸①不拦）', async () => {
  // ⚠️ 不能清空 watchList —— 那会让闸②（targetUin=200222）也跟着挂，
  //    测到的就不是"闸①放行"了。用默认名单（含 200222）。
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({ tid: 'tid-1', content: 'x', targetUin: '200222', postUin: '900999' })
  assert.equal(out.ok, true, '自己的号不该被闸①挡: ' + JSON.stringify(out))
  assert.equal(calls[0].body.target_uin, '900999')
})


// ---- ★ 2026-10-20：**他要的那个场景** ---------------------------------------
//   帖主在名单里 + 评论人在名单里 + 有 commentId
//   ⇒ 桥要的三个参数必须全对：target_uin=帖主、reply_uin=评论人、reply_comment_id=那条评论

test('⑰ ★ 场景：白名单内的人，评论在白名单内的帖子上 —— 三个参数全对', async () => {
  // 默认名单 = 200222, 300333；自己 = 900999；主人 = 100111
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({
    tid: 'tid-1',
    content: '谢谢',
    postUin: '300333',        // 帖主（名单内）
    targetUin: '200222',      // 评论人（名单内）
    replyCommentId: 'c-9'     // 那条评论
  })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.postUin, '300333', '回包要报帖主')

  const b = calls[0].body
  assert.equal(b.target_uin, '300333', '★ target_uin = 帖主（桥拼 topicId 用）')
  assert.equal(b.reply_uin, '200222', '★ reply_uin = 评论人（桥拼 @ 提及用）')
  assert.equal(b.reply_comment_id, 'c-9', '★ reply_comment_id = 那条评论')
  assert.equal(b.target_tid, 'tid-1')
  // 桥的 client.ts:4218 要 reply_comment_id 和 reply_uin **同时**有才加 @
  assert.ok('reply_comment_id' in b && 'reply_uin' in b, '两个都在 ⇒ 会变成"回复某某"')
})

test('⑱ ★ 同样场景，但帖主 = 她自己 ⇒ 用自己的号当 target_uin', async () => {
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({
    tid: 'tid-1', content: 'x', postUin: '900999', targetUin: '200222', replyCommentId: 'c-1'
  })
  assert.equal(out.ok, true)
  assert.equal(calls[0].body.target_uin, '900999')
})

test('⑲ ★ 帖主在名单内、评论人也在名单内，但**帖主就是评论人**（他自己评论自己）', async () => {
  const { ch, calls } = makeChannel()
  const out = await ch.replyComment({
    tid: 'tid-1', content: 'x', postUin: '300333', targetUin: '300333', replyCommentId: 'c-2'
  })
  assert.equal(out.ok, true)
  assert.equal(calls[0].body.target_uin, '300333')
  assert.equal(calls[0].body.reply_uin, '300333')
})
