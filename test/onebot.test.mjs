/**
 * onebot.js 的**真机级**单测:真的开一个 WebSocketServer,真的用 ws 连进去,
 * 真的走一遍"他发消息 → onEvent;她说的话 → send_private_msg → NapCat 回包"。
 *
 * 为什么值得这么测:这一份是**借来的代码**(见 THIRD_PARTY.md),我们对它的承诺是
 * "只私聊、六个 action、心跳只标 stale、断线不销毁"。光有语法检查证明不了任何一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createOneBot } from '../lib/onebot.js'

const TOKEN = 'tok-' + Math.random().toString(36).slice(2, 8)

function portOf () {
  return 17000 + Math.floor(Math.random() * 2000)
}

function connect (port, token = TOKEN, path = '/') {
  return new WebSocket('ws://127.0.0.1:' + port + path, {
    headers: token === '' ? {} : { authorization: 'Bearer ' + token }
  })
}

function once (emitter, event) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等 ' + event + ' 超时')), 3000)
    emitter.once(event, (...args) => { clearTimeout(t); resolve(args) })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const privateMsg = (over = {}) => JSON.stringify({
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

async function boot ({ onEvent = () => {}, onState = () => {}, heartbeatMs = 30000, maxMisses = 3 } = {}) {
  const port = portOf()
  const server = createOneBot({ host: '127.0.0.1', port, accessToken: TOKEN, onEvent, onState, heartbeatMs, maxMisses })
  await server.start()
  return { port, server }
}

test('反向 WS:私聊进 onEvent(字段齐全);群聊也进(带 chatType/groupId/selfId)', async (t) => {
  const got = []
  const { port, server } = await boot({ onEvent: (e) => got.push(e) })
  const ws = connect(port)
  t.after(async () => { ws.close(); await server.stop() })
  await once(ws, 'open')

  ws.send(privateMsg())
  for (let i = 0; i < 60 && got.length === 0; i += 1) await sleep(10)
  assert.equal(got.length, 1)
  assert.equal(got[0].userId, '3783')
  assert.equal(got[0].messageId, 'm-1')
  assert.equal(got[0].text, '在吗')
  assert.equal(got[0].userName, '<称呼>')
  assert.equal(got[0].ts, 1758888888 * 1000) // ts = 消息自带的时间
  assert.ok(got[0].at > 1700000000000) // at = 我们收到的时刻(本地时钟)
  assert.equal(got[0].chatType, 'private', '2026-10-15:带出 chatType')

  const st = server.status()
  assert.equal(st.state, 'client-connected')
  assert.equal(st.clients, 1)
  assert.equal(st.received, 1)

  // ★ 2026-10-15 加群聊：群消息**现在也进 onEvent**（带 chatType/groupId/selfId）。
  //   "这个群收不收"由 `allowsInbound` 判，"现在该不该收"由 `lib/group-awake.js` 判 ——
  //   这一层只管"事件形状读得出来"。
  ws.send(privateMsg({ message_type: 'group', group_id: '99', self_id: '8888' }))
  for (let i = 0; i < 60 && got.length < 2; i += 1) await sleep(10)
  assert.equal(got.length, 2, '群消息该进 onEvent')
  assert.equal(got[1].chatType, 'group')
  assert.equal(got[1].groupId, '99')
  assert.equal(got[1].selfId, '8888', '★ selfId 带出去 —— 判"@她没"要用')
  assert.equal(got[1].userId, '3783', 'sender 仍是说话的人')
  assert.equal(server.status().received, 2)

  // guild / 频道仍然不收：连计数都不该动
  ws.send(privateMsg({ message_type: 'guild' }))
  await sleep(120)
  assert.equal(got.length, 2, 'guild 不该进 onEvent')
  assert.equal(server.status().received, 2)

  // 缺 msgId 的私聊:拒,且计入 rejected
  ws.send(privateMsg({ message_id: '' }))
  await sleep(120)
  assert.equal(got.length, 2, '（私聊 + 群聊两条；缺 msgId 那条不该进）')
  assert.ok(server.status().rejected >= 1)
})

test('鉴权:口令不对连不进来(恒定时间比较),失败计数看得见', async (t) => {
  const got = []
  const { port, server } = await boot({ onEvent: (e) => got.push(e) })
  t.after(async () => { await server.stop() })

  const ws = connect(port, 'wrong-token')
  await once(ws, 'close').catch(() => {})
  await sleep(80)
  assert.equal(got.length, 0)
  assert.equal(server.status().rejectedAuth >= 1, true)
  assert.equal(server.status().clients, 0)
})

test('出站:sendPrivateMsg 发出 action,NapCat 回包后 resolve', async (t) => {
  const { port, server } = await boot()
  const ws = connect(port)
  t.after(async () => { ws.close(); await server.stop() })
  await once(ws, 'open')

  const frames = []
  ws.on('message', (buf) => {
    const frame = JSON.parse(String(buf))
    frames.push(frame)
    // 扮演 NapCat:回一个带 echo 的成功包
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: frame.echo }))
  })

  const r = await server.sendPrivateMsg('3783', '晚安')
  assert.equal(r.ok, true)
  assert.equal(r.messageId, '42') // 对外 id 一律字符串
  assert.equal(frames.length, 1)
  assert.equal(frames[0].action, 'send_private_msg')
  // 出网给 NapCat 的 user_id 是数字(协议如此);对内的 id 才是字符串
  assert.equal(frames[0].params.user_id, 3783)
  assert.equal(typeof frames[0].params.user_id, 'number')
  assert.equal(frames[0].params.message, '晚安')
  assert.equal(server.status().sent >= 1, true)
})

test('出站:NapCat 回失败时给 error,不假装成功', async (t) => {
  const { port, server } = await boot()
  const ws = connect(port)
  t.after(async () => { ws.close(); await server.stop() })
  await once(ws, 'open')

  ws.on('message', (buf) => {
    const frame = JSON.parse(String(buf))
    ws.send(JSON.stringify({ status: 'failed', retcode: 100, msg: '风控', echo: frame.echo }))
  })

  const r = await server.sendPrivateMsg('3783', 'x')
  assert.equal(r.ok, false)
  assert.ok(String(r.error).length > 0)
})

test('心跳:没人应就标 stale,但**绝不销毁状态**;有人应了就归位', async (t) => {
  const states = []
  const { port, server } = await boot({ heartbeatMs: 40, maxMisses: 2, onState: (s) => states.push(s) })
  const ws = connect(port)
  t.after(async () => { ws.close(); await server.stop() })
  await once(ws, 'open')

  // 一开始不应答心跳(单次探测超时 = max(300, min(heartbeatMs,2000)),
  // 所以 stale 的判定时间是 heartbeatMs × maxMisses 量级,由配置决定)
  for (let i = 0; i < 300 && server.status().stale !== true; i += 1) await sleep(10)
  assert.equal(server.status().stale, true, '连续不应答应该标 stale')
  // 关键纪律:连接与计数一个都没丢
  assert.equal(server.status().clients, 1)
  assert.equal(server.status().state, 'client-connected')
  assert.ok(states.some((s) => s.stale === true))

  // 开始应答 get_status,stale 应归位
  ws.on('message', (buf) => {
    const frame = JSON.parse(String(buf))
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true, good: true }, echo: frame.echo }))
  })
  for (let i = 0; i < 150 && server.status().stale !== false; i += 1) await sleep(10)
  assert.equal(server.status().stale, false)
  assert.equal(server.status().clients, 1)
})

test('stop():断开连接、状态收尾,不留定时器', async (t) => {
  const { port, server } = await boot({ heartbeatMs: 40 })
  const ws = connect(port)
  await once(ws, 'open')
  assert.equal(server.status().clients, 1)
  await server.stop()
  await sleep(60)
  assert.equal(server.status().state, 'closed')
  assert.equal(server.status().listening, false)
  ws.close()
})
