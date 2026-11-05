/**
 * S2-b 的**接缝电池**(2026-09-29):真 NapCat 事件 → onebot 归一化 → 信封 → 主包形状。
 *
 * 为什么单独一条:第一版带图入站是**假绿** —— `imagesOfSegments()` 只读了
 * `seg.data.url`,而生产里 `lib/onebot.js` 的 `normalizeSegment()` 早把段归一成
 * **平铺**形状(`{type:'image', url, file}`)才交给 `onEvent`。单元测试照的是原始事件的
 * 嵌套形状,所以全绿;真机上图片照样丢。这条用例刻意走**整条真路**:
 * 真的开一个反向 WS 服务、真的把 NapCat 那条 JSON 发进去、拿 `onEvent` 收到的 evt
 * 去造信封 —— 它要是绿的,真机就没得躲。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createOneBot } from '../lib/onebot.js'
import { buildPrivateEnvelope, imagesOfSegments, textOfSegments } from '../lib/envelope.js'

const TOKEN = 'T-SEAM-1'
let portBase = 7300 + (process.pid % 200)
const portOf = () => (portBase += 1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** NapCat 真机形状:message 是**段数组**,每段带 data 嵌套。 */
const napcatMsg = (segments, over = {}) => JSON.stringify({
  post_type: 'message',
  message_type: 'private',
  self_id: '1000',
  user_id: '<your-qq>',
  message_id: 'm-img-1',
  time: 1758888888,
  sender: { nickname: '<称呼>' },
  message: segments,
  ...over
})

async function boot (onEvent) {
  const port = portOf()
  const server = createOneBot({ host: '127.0.0.1', port, accessToken: TOKEN, onEvent, onState: () => {}, heartbeatMs: 30000, maxMisses: 3 })
  await server.start()
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/', { headers: { Authorization: 'Bearer ' + TOKEN } })
  await once(ws, 'open')
  return { ws, server }
}

async function drive (segments) {
  const got = []
  const { ws, server } = await boot((e) => got.push(e))
  try {
    ws.send(napcatMsg(segments))
    for (let i = 0; i < 80 && got.length === 0; i += 1) await sleep(10)
    assert.equal(got.length, 1, '这条消息要能进 onEvent')
    return got[0]
  } finally {
    ws.close()
    await server.stop()
  }
}

test('接缝:**只发一张图不写字** → 信封带着图(他现场那种)', async () => {
  const evt = await drive([{ type: 'image', data: { url: 'https://cdn.example/moon.jpg', file: 'moon.image' } }])
  assert.equal(evt.text, '', '没写字就是没写字')
  const pics = imagesOfSegments(evt.segments)
  assert.equal(pics.length, 1, '图段必须活着走到信封这一层(第一版就是这里丢的)')
  assert.deepEqual(pics, [{ url: 'https://cdn.example/moon.jpg', file: 'moon.image' }])

  const built = buildPrivateEnvelope({
    userId: evt.userId, userName: evt.userName, messageId: evt.messageId,
    text: evt.text, images: pics, ts: evt.ts, isMaster: true
  })
  assert.equal(built.ok, true, '只有图也是一封合法的信:' + JSON.stringify(built))
  assert.equal(built.envelope.images.length, 1)
})

test('接缝:图 + 字 → 图带着、字也在;正文不再重复「［图片］」', async () => {
  const evt = await drive([
    { type: 'text', data: { text: '今晚的月亮 ' } },
    { type: 'image', data: { url: 'https://cdn.example/m.jpg' } }
  ])
  assert.equal(evt.text, '今晚的月亮', 'onebot 归一化后的正文')
  const pics = imagesOfSegments(evt.segments)
  assert.equal(pics.length, 1)
  const built = buildPrivateEnvelope({
    userId: evt.userId, messageId: evt.messageId, text: evt.text, images: pics, isMaster: true
  })
  assert.equal(built.envelope.text, '今晚的月亮')
  assert.equal(built.envelope.images.length, 1)
  // 信封里给的是真图,就不该再在正文里写标记(标记只留给"带不走"的怪段)
  assert.equal(built.envelope.text.includes('［图片］'), false)
})

test('接缝:CQ 码字符串形式(`[CQ:image,…]`)也认 —— NapCat 两种上报格式都行', async () => {
  const evt = await drive('[CQ:image,file=moon.jpg,url=https://cdn.example/cq.jpg]')
  const pics = imagesOfSegments(evt.segments)
  assert.equal(pics.length, 1, 'CQ 码里的 image 段也要能带图')
  assert.equal(pics[0].url, 'https://cdn.example/cq.jpg')
  const built = buildPrivateEnvelope({ userId: evt.userId, messageId: evt.messageId, text: evt.text, images: pics, isMaster: true })
  assert.equal(built.ok, true)
})

test('接缝:带不走的怪图段 → 正文留「［图片］」标记,信封照发(不静默、也不整条被拒)', async () => {
  const evt = await drive([
    { type: 'text', data: { text: '这个呢' } },
    { type: 'image', data: { summary: '一张图' } }
  ])
  assert.equal(imagesOfSegments(evt.segments).length, 0, '没有 url/file 认不出发源 ⇒ 不带图')
  assert.equal(textOfSegments(evt.segments), '这个呢［图片］')
  const built = buildPrivateEnvelope({ userId: evt.userId, messageId: evt.messageId, text: textOfSegments(evt.segments), images: [], isMaster: true })
  assert.equal(built.ok, true, '文字痕迹还在 ⇒ 信照发')
})

test('接缝:一张图都没有的空消息 → 照旧拒(负控制)', async () => {
  const got = []
  const { ws, server } = await boot((e) => got.push(e))
  try {
    ws.send(napcatMsg([{ type: 'face', data: { id: '1' } }], { message_id: 'm-face' }))
    await sleep(150)
    // 表情段能进 onEvent(它不是"空消息"),但信封侧不该凭空造图
    const evt = got[0]
    if (evt !== undefined) {
      assert.equal(imagesOfSegments(evt.segments).length, 0)
      const built = buildPrivateEnvelope({ userId: evt.userId, messageId: evt.messageId, text: textOfSegments(evt.segments), images: [], isMaster: true })
      assert.equal(built.ok, true, '「［表情］」是文字痕迹 ⇒ 放行')
    }
    const empty = buildPrivateEnvelope({ userId: '1', messageId: 'm-0', text: '', images: [] })
    assert.equal(empty.ok, false)
  } finally {
    ws.close()
    await server.stop()
  }
})
