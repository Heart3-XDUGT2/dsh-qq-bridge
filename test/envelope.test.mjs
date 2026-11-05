import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPrivateEnvelope, MAX_TEXT, MAX_IMAGES, readPrivateEvent, textOfSegments, imagesOfSegments
} from '../lib/envelope.js'

const priv = (over = {}) => ({
  post_type: 'message',
  message_type: 'private',
  self_id: '1000',
  user_id: '3783',
  message_id: 'm-1',
  time: 1758888888,
  sender: { nickname: '<称呼>' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...over
})

test('readPrivateEvent:私聊文本消息 → 最小事实', () => {
  const r = readPrivateEvent(priv())
  assert.equal(r.ok, true)
  assert.equal(r.event.userId, '3783')
  assert.equal(r.event.userName, '<称呼>')
  assert.equal(r.event.messageId, 'm-1')
  assert.equal(r.event.text, '在吗')
  assert.equal(r.event.ts, 1758888888 * 1000)
  assert.equal(r.event.chatType, 'private', '2026-10-15:带出 chatType')
})

// ★ 2026-10-15 加群聊：从"群聊一律不收"改成"群聊也读，并带出群信息"。
test('readPrivateEvent:群聊也收（带 chatType/groupId/selfId）；guild 等仍不收', () => {
  // ⚠️ self_id 要用**跟她自己**一致的号（9999），别用 3783 —— 那是说话的人，
  //    两个相等会被判成"自己的回声"（这条正是上一版我写错的地方）。
  const g = readPrivateEvent(priv({ message_type: 'group', group_id: 'G123', self_id: '9999' }))
  assert.equal(g.ok, true, '群聊现在该收')
  assert.equal(g.event.chatType, 'group')
  assert.equal(g.event.groupId, 'G123')
  assert.equal(g.event.selfId, '9999', '★ selfId 要带出去 —— 判"@她没"要用')
  assert.equal(g.event.userId, '3783', 'sender 仍是说话的人')
  // 群聊但缺 group_id ⇒ 拒（会话 id 立不住）
  const noGid = readPrivateEvent(priv({ message_type: 'group' }))
  assert.equal(noGid.ok, false)
  assert.ok(noGid.reason.includes('group_id'))
  // guild / 频道 / 空 message_type ⇒ 仍不收
  assert.ok(String(readPrivateEvent(priv({ message_type: 'guild' })).reason).includes('guild'))
  assert.equal(readPrivateEvent(priv({ message_type: '' })).ok, false)
})

test('readPrivateEvent:非消息 / 自己的回声 一律不收', () => {
  assert.equal(readPrivateEvent({ post_type: 'notice' }).ok, false)
  assert.equal(readPrivateEvent(priv({ user_id: '1000' })).reason, '是自己的回声')
  assert.equal(readPrivateEvent(null).ok, false)
})

test('textOfSegments:文本/图/表情拼接,at 与 reply 不进文本', () => {
  const segs = [
    { type: 'text', data: { text: '看这个 ' } },
    // 2026-09-29(S2-b):能送出去的图段**不再**在正文里留「［图片］」——
    // 她真的会看到那张图(主包注入时附实况行),正文再写一遍是重复,
    // 还会让她以为"只有个标记、没图"。送不过去的怪段才留标记(下一条用例)。
    { type: 'image', data: { file: 'x.jpg' } },
    { type: 'at', data: { qq: '1' } },
    { type: 'face', data: { id: '1' } },
    { type: 'reply', data: { id: 'm-0' } }
  ]
  assert.equal(textOfSegments(segs), '看这个 ［表情］')
  assert.equal(textOfSegments('纯字符串也算'), '纯字符串也算')
  assert.equal(textOfSegments(null), '')
})

test('textOfSegments:送不过去的怪图段照旧留「［图片］」标记(不静默)', () => {
  const segs = [
    { type: 'text', data: { text: '这个呢' } },
    { type: 'image', data: { summary: '一张图' } } // 没有 url 也没有 file:带不走
  ]
  assert.equal(textOfSegments(segs), '这个呢［图片］')
})

test('imagesOfSegments:OneBot 图段 → 主包 parseImages 的形状(url 优先,带 name)', () => {
  const segs = [
    { type: 'text', data: { text: '看' } },
    { type: 'image', data: { url: 'https://cdn.example/a.jpg', file: 'a.image' } },
    { type: 'image', data: { file: 'file:///tmp/b.png', name: 'b.png' } },
    { type: 'face', data: { id: '1' } },
    null,
    { type: 'image', data: { summary: '带不走' } } // 丢弃,不发明形状
  ]
  const out = imagesOfSegments(segs)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { url: 'https://cdn.example/a.jpg', file: 'a.image' })
  assert.deepEqual(out[1], { file: 'file:///tmp/b.png', name: 'b.png' })
  assert.deepEqual(imagesOfSegments(null), [])
  assert.deepEqual(imagesOfSegments('不是数组'), [])
})

test('imagesOfSegments:最多 4 张(与主包 MAX_IMAGES 同值)', () => {
  const segs = Array.from({ length: 7 }, (_, i) => ({ type: 'image', data: { url: 'https://x/' + i + '.jpg' } }))
  assert.equal(imagesOfSegments(segs).length, MAX_IMAGES)
  assert.equal(MAX_IMAGES, 4)
})

test('buildPrivateEnvelope:**只发图不写字**也是一封信(他现场就是这种)', () => {
  const r = buildPrivateEnvelope({ userId: '3783', messageId: 'm-2', images: [{ url: 'https://cdn.example/moon.jpg' }] })
  assert.equal(r.ok, true)
  assert.equal(r.envelope.text, '')
  assert.deepEqual(r.envelope.images, [{ url: 'https://cdn.example/moon.jpg' }])
  // 图 + 字:两边都带上
  const both = buildPrivateEnvelope({ userId: '3783', messageId: 'm-3', text: '今晚的月亮', images: [{ url: 'https://x/1.jpg' }] })
  assert.equal(both.ok, true)
  assert.equal(both.envelope.text, '今晚的月亮')
  assert.equal(both.envelope.images.length, 1)
  // 形状不对的图记被丢掉;丢了之后没字没图 ⇒ 照旧拒(负控制)
  const junk = buildPrivateEnvelope({ userId: '3783', messageId: 'm-4', images: [{ summary: 'x' }, 'string', null] })
  assert.equal(junk.ok, false)
  assert.ok(junk.reason.includes('除非他发的是图'))
  // 上限收紧:递给它 9 条,信封里最多 4 条
  const many = buildPrivateEnvelope({
    userId: '3783', messageId: 'm-5',
    images: Array.from({ length: 9 }, (_, i) => ({ url: 'https://x/' + i + '.jpg' }))
  })
  assert.equal(many.envelope.images.length, MAX_IMAGES)
})

test('buildPrivateEnvelope:形状与主包 relay.js:107-148 的 parseEnvelope 对齐', () => {
  const r = buildPrivateEnvelope({ userId: '3783', userName: '<称呼>', messageId: 'm-1', text: ' 在吗 ', ts: 123 })
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.envelope).sort(), ['chat', 'images', 'msgId', 'platform', 'sender', 'text', 'ts', 'v'].sort())
  assert.equal(r.envelope.v, 1)
  assert.equal(r.envelope.platform, 'qq')
  assert.deepEqual(r.envelope.chat, { id: '3783', type: 'private', title: '' })
  assert.equal(r.envelope.sender.id, '3783')
  assert.equal(r.envelope.sender.isMaster, false)
  assert.equal(r.envelope.text, '在吗') // 去空白
  assert.deepEqual(r.envelope.images, [])
  assert.equal(r.envelope.msgId, 'm-1')
  assert.equal(r.envelope.ts, 123)
})

test('buildPrivateEnvelope:缺 msgId / 空文本 / 超长 都拒(附理由)', () => {
  assert.equal(buildPrivateEnvelope({ userId: '1', text: 'x' }).reason, 'msgId 必填(幂等要用)')
  // 空文本**且没有图**才拒(只有图是合法的 —— 见上面那条用例)
  assert.equal(buildPrivateEnvelope({ userId: '1', messageId: 'm', text: '   ' }).ok, false)
  assert.equal(buildPrivateEnvelope({ userId: '', messageId: 'm', text: 'x' }).ok, false)
  assert.equal(buildPrivateEnvelope({ userId: '1', messageId: 'm', text: 'x'.repeat(MAX_TEXT + 1) }).ok, false)
})

test('imagesOfSegments:**生产的平铺形状**也要认(第一版只认 data 嵌套 = 假绿)', () => {
  // lib/onebot.js 的 normalizeSegment() 交给 onEvent 的是平铺段:
  //   {type:'image', url, file} / {type:'text', text}
  // 而原始 NapCat 事件是 data 嵌套。两种都必须认 —— 真机走的是平铺那种。
  const flat = [
    { type: 'text', text: '看这个' },
    { type: 'image', url: 'https://cdn.example/flat.jpg', file: 'flat.image' }
  ]
  assert.deepEqual(imagesOfSegments(flat), [{ url: 'https://cdn.example/flat.jpg', file: 'flat.image' }])
  assert.equal(textOfSegments(flat), '看这个')
  // 嵌套(原始事件)那一侧照旧能认
  const nested = [{ type: 'image', data: { url: 'https://cdn.example/n.jpg' } }]
  assert.deepEqual(imagesOfSegments(nested), [{ url: 'https://cdn.example/n.jpg' }])
  // 真接缝(真 WS + 真 onebot 归一化)在 test/image-seam.test.mjs
})

test('readPrivateEvent:图片消息(text 空)也读得出来,segments 原样带出', () => {
  const r = readPrivateEvent(priv({
    message: [{ type: 'image', data: { url: 'https://cdn.example/p.jpg', file: 'p.image' } }]
  }))
  assert.equal(r.ok, true)
  assert.equal(r.event.text, '', '没有文字就是没有(不许编)')
  assert.equal(imagesOfSegments(r.event.segments).length, 1, '图段要能一路带到信封')
})
