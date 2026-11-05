/**
 * `lib/onebot.js` 的 start() 在**端口被占**时的行为 —— 这是切换期最要紧的一条。
 *
 * 为什么必须测:6199 现在被 AstrBot 的 python 后端占着(2026-09-28 实测)。
 * 如果 start() 在端口被占时**不报错、静默"成功"**,那么:
 *   - 插件面板会显示"正在监听",实际一个字都收不到 ⇒ 最难查的半死;
 *   - 退避重试那条路也永远不会被触发(它以为已经起来了)。
 * 所以这里用真客户端 + 真占位端口,验:
 *   ① 端口被占 ⇒ `start()` **必须 reject**(而且不把宿主拉下水);
 *   ② 腾出端口 + 重试(先 stop() 再 start())⇒ 能起来 —— 这就是退避重试的那条序列;
 *   ③ 重复 start() 幂等;
 *   ④ 真接得上反向 WS 连接,断线只回 listening(**不重建 wss**)。
 * 状态取值:`closed | listening | client-connected`(见 lib/onebot.js 的 refreshState)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createOneBot } from '../lib/onebot.js'

/** 占住一个端口,返回 { port, release }。 */
async function occupyPort () {
  const server = createServer(() => {})
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { port: server.address().port, release: () => new Promise((r) => server.close(() => r())) }
}

/** 要一个(大概率)空闲的端口:先占再放。 */
async function freePort () {
  const held = await occupyPort()
  const port = held.port
  await held.release()
  return port
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等到条件成立(最多 2s),返回是否等到。 */
async function waitFor (cond, ms = 2000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

const clientOf = (port, extra = {}) => createOneBot({ host: '127.0.0.1', port, accessToken: '', log: () => {}, ...extra })

test('端口被占:start() 必须 reject(不许静默"成功"),腾出后重试能起来', async () => {
  const held = await occupyPort()
  const client = clientOf(held.port)
  await assert.rejects(client.start(), /EADDRINUSE|address|listen/i, '占了端口就该 reject')
  // ① 之后:状态如实(没在听)
  assert.equal(client.status().listening, false, '失败之后不许自称在听')
  assert.equal(client.status().state, 'closed')

  // ② 腾出端口 → 重试(退避重试用的就是这一串:stop() 再 start())
  await held.release()
  await client.stop()
  await client.start()
  assert.equal(client.status().listening, true, '腾出端口后应当能起来')
  assert.equal(client.status().state, 'listening')
  // ③ 幂等
  await client.start()
  assert.equal(client.status().listening, true)
  await client.stop()
  assert.equal(client.status().listening, false)
})

test('真能接到反向 WS 连接:接上=client-connected,断开只回 listening(不重建 wss)', async () => {
  const port = await freePort()
  const states = []
  const client = clientOf(port, { onState: (s) => states.push(s.state) })
  await client.start()
  assert.equal(client.status().listening, true)

  const { WebSocket } = await import('ws')
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws') // NapCat 用的就是这个路径
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  assert.ok(await waitFor(() => client.status().clients === 1), '接上了就该报 1 个连接')
  assert.equal(client.status().state, 'client-connected')
  assert.ok(states.includes('client-connected'), '状态变更要广播出去(面板靠它)')

  // 断开只回到 listening:连接数归零,但**服务还在听**(NapCat 重连不用重启我们)
  ws.close()
  assert.ok(await waitFor(() => client.status().clients === 0), '断开后连接数归零')
  assert.equal(client.status().state, 'listening')
  assert.equal(client.status().listening, true, '断线不许把 wss 也关了')
  await client.stop()
})

test('鉴权:配了 token 就只认 Authorization: Bearer <token>(NapCat 那边就是这么带的)', async () => {
  const port = await freePort()
  const client = clientOf(port, { accessToken: '<test-token>' })
  await client.start()
  const { WebSocket } = await import('ws')

  // 带对的口令 ⇒ 握得上
  const good = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { authorization: 'Bearer <test-token>' } })
  await new Promise((resolve, reject) => {
    good.once('open', resolve)
    good.once('error', reject)
  })
  assert.ok(await waitFor(() => client.status().clients === 1), '带对 token 应当接上')

  // 带错的/不带的 ⇒ 拒(握手就断;而且不能把先连上的那个挤掉)
  const bad = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { authorization: 'Bearer wrong' } })
  await new Promise((resolve) => {
    bad.once('open', () => resolve())
    bad.once('error', () => resolve())
    bad.once('close', () => resolve())
    setTimeout(resolve, 800)
  })
  assert.equal(client.status().clients, 1, '错 token 不许接上')
  assert.ok(client.status().rejectedAuth >= 1, '拒了要记账(面板看得见)')

  good.close()
  await client.stop()
})
