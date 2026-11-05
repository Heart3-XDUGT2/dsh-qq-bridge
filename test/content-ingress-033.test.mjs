/**
 * 执行实际index的onEvent、二次准入及唤醒包装，依赖限于本进程假宿主。
 * 不求值插件apply，不读配置/用户日志/数据库；另有一条真实回环WS。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createOneBot } from '../lib/onebot.js'
import { allowsInbound } from '../lib/config.js'
import { createGroupAwake, decideGroupMessage, isAtMe, isStopCommand } from '../lib/group-awake.js'
import { buildPrivateEnvelope, imagesOfSegments } from '../lib/envelope.js'
import { expandForwardContent, hasForwardContent, FORWARD_NOTICES } from '../lib/forward-content.js'
import { createForwardCache } from '../lib/forward-cache.js'
import { createContentQueue } from '../lib/content-queue.js'
import { filesOfSegments } from '../lib/file-content.js'
import { createFileReceipts } from '../lib/file-receipts.js'
import { parseEnvelope, renderInboundText } from '../../dsh-memory-agent/lib/relay.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const future = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const response = text => ({ ok: true, data: { message: [
  { type: 'node', data: { user_id: '22', nickname: '乙', time: 10,
    content: [{ type: 'text', data: { text } }, { type: 'at', data: { qq: '33', name: '丙' } }] } }
] } })

async function waitFor (condition) {
  const until = Date.now() + 2000
  while (!condition() && Date.now() < until) await delay(2)
  assert.equal(condition(), true, '假链路应在预算内完成')
}

function arrowOf (label, endMarker) {
  const start = source.indexOf(label)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, '实际index函数边界存在')
  return source.slice(start + label.length, end + endMarker.indexOf('}') + 1)
}

function fixture (t, backend = async () => response('引文')) {
  const settings = {
    enabled: true, groupEnabled: true, allowedUsers: ['11', '22'], allowedGroups: ['33', '44'],
    selfId: '99', masterId: '11', groupHistoryOnWakeEnabled: false
  }
  const contentState = { epoch: 0, disposed: false, seen: new Map(), scopes: new Map() }
  const contentQueue = createContentQueue()
  const forwardCache = createForwardCache()
  const fileReceipts = createFileReceipts()
  const groupAwake = createGroupAwake({ setTimer: () => null, clearTimer: () => {} })
  t.after(() => { contentQueue.dispose(); forwardCache.clear(); fileReceipts.clear(); groupAwake.stop() })
  const injected = []
  const executions = []
  const journal = []
  const queries = []
  const deps = {
    settings, contentState, contentQueue, forwardCache, fileReceipts, filesOfSegments, groupAwake, allowsInbound,
    decideGroupMessage, isAtMe, isStopCommand, imagesOfSegments, buildPrivateEnvelope,
    hasForwardContent, expandForwardContent, FORWARD_NOTICES,
    chatKeyOf: value => value.chatType + ':' + value.chatId,
    log: () => {}, dir: 'fake-journal', appendInbound: (_dir, entry) => journal.push(entry),
    inboundEntry: value => value, clampHistoryCount: value => Number(value) || 5,
    groupHistory: { pull: async () => {}, digest: () => '' },
    onebot: { call: async (action, args, options) => {
      queries.push({ action, id: args.id })
      assert.equal(action, 'get_forward_msg')
      return backend(args.id, options)
    } },
    channel: { inject: async (raw, guard) => {
      assert.equal(guard.isCurrent(), true)
      executions.push(guard)
      const parsed = parseEnvelope(raw)
      assert.equal(parsed.ok, true)
      injected.push({ env: parsed.value, text: renderInboundText(parsed.value) })
      return { ok: true }
    } }
  }
  const compile = expression => new Function(...Object.keys(deps), 'return (' + expression + ')')(...Object.values(deps))
  deps.contentAllowed = compile(arrowOf('  const contentAllowed = ', '\n  }\n'))
  deps.groupAwakeApply = compile(arrowOf('  const groupAwakeApply = ', '\n  }\n'))
  const onEvent = compile(arrowOf('      onEvent: ', '\n      }\n    })'))
  const event = (id, patch = {}) => ({
    userId: '11', userName: '甲', selfId: '99', messageId: id,
    text: '', chatType: 'private', segments: [{ type: 'forward', data: { id } }], ...patch
  })
  return { settings, contentState, contentQueue, forwardCache, groupAwake, injected, executions, journal, queries, onEvent, event,
    idle: () => waitFor(() => contentQueue.stats().running === 0 && contentQueue.stats().pending === 0) }
}

test('033：非白名单与休眠群不查询转发', async t => {
  const f = fixture(t)
  f.onEvent(f.event('blocked', { userId: '55' }))
  f.onEvent(f.event('sleeping', { userId: '22', chatType: 'group', groupId: '33' }))
  await f.idle()
  assert.equal(f.queries.length, 0)
  assert.equal(f.injected.length, 0)
})

test('033：慢A与同聊天文字B有序，其它聊天C不被阻塞', async t => {
  const slow = future()
  const f = fixture(t, id => id === 'A' ? slow.promise : response(id))
  f.onEvent(f.event('A', { text: 'A的原话' }))
  await waitFor(() => f.queries.length === 1)
  f.onEvent(f.event('B', { text: 'B的原话', segments: [] }))
  f.onEvent(f.event('C', { userId: '22', text: 'C的原话', segments: [] }))
  await waitFor(() => f.injected.length === 1)
  assert.equal(f.injected[0].env.msgId, 'C')
  slow.resolve(response('A的引文'))
  await f.idle()
  assert.deepEqual(f.injected.map(item => item.env.msgId), ['C', 'A', 'B'])
  assert.equal(f.injected[1].env.text, 'A的原话')
  assert.match(f.injected[1].text, /A的引文/)
})

test('033：等待中stop再唤醒，旧展开不能回来注入', async t => {
  const slow = future()
  const f = fixture(t, () => slow.promise)
  f.groupAwake.wake('33')
  f.onEvent(f.event('old', { userId: '22', chatType: 'group', groupId: '33' }))
  await waitFor(() => f.queries.length === 1)
  f.onEvent(f.event('stop', { text: '/stop', chatType: 'group', groupId: '33', segments: [{ type: 'at', qq: 99 }] }))
  assert.equal(f.groupAwake.isAwake('33'), false)
  f.onEvent(f.event('wake', { text: '回来吧', chatType: 'group', groupId: '33', segments: [{ type: 'at', qq: 99 }] }))
  slow.resolve(response('不得注入的旧引文'))
  await f.idle()
  assert.deepEqual(f.injected.map(item => item.env.msgId), ['wake'])
})

test('033：等待中撤白名单，返回的展开不能越门', async t => {
  const slow = future()
  const f = fixture(t, () => slow.promise)
  f.onEvent(f.event('old'))
  await waitFor(() => f.queries.length === 1)
  f.settings.allowedUsers.length = 0
  slow.resolve(response('旧引文'))
  await f.idle()
  assert.equal(f.injected.length, 0)
  assert.ok(f.journal.some(entry => entry.stage === 'content-queue'))
})

test('033：展开失败不丢原话，重复入站不重复查询或注入', async t => {
  const f = fixture(t, async () => { throw Error('synthetic-private-url') })
  const event = f.event('failed', { text: '这句是真实原话' })
  f.onEvent(event)
  f.onEvent(structuredClone(event))
  await f.idle()
  assert.equal(f.queries.length, 1)
  assert.equal(f.injected.length, 1)
  assert.equal(f.injected[0].env.text, '这句是真实原话')
  assert.match(f.injected[0].text, /未展开|未读|读取失败/)
  assert.doesNotMatch(f.injected[0].text, /synthetic-private-url/)
})

test('033：后续页缓存故障仍交首段和原话', async t => {
  const f = fixture(t)
  f.forwardCache.put = () => { throw Error('synthetic-cache-failure') }
  f.onEvent(f.event('cache-failure', { text: '这句原话不能丢' }))
  await f.idle()
  assert.equal(f.injected.length, 1)
  assert.equal(f.injected[0].env.text, '这句原话不能丢')
  assert.match(f.injected[0].text, /引文/)
  assert.doesNotMatch(f.injected[0].text, /synthetic-cache-failure/)
})

test('033：实际QQ授权不随prepare job完成失效，且按聊天代际撤销', async t => {
  const f = fixture(t)
  f.groupAwake.wake('33')
  f.groupAwake.wake('44')
  f.onEvent(f.event('queued-scope', {
    chatType: 'group', groupId: '33', userId: '22', text: '正在等待主包的原话', segments: []
  }))
  await f.idle()
  const execution = f.executions[0]
  assert.equal(execution.isCurrent(), true, 'prepare/deliver job结束后，正常core busy队列仍能使用此许可')
  f.onEvent(f.event('other-stop', { chatType: 'group', groupId: '44', text: '/stop', segments: [{ type: 'at', qq: 99 }] }))
  assert.equal(execution.isCurrent(), true, '其它群stop不影响本群')
  f.onEvent(f.event('own-stop', { chatType: 'group', groupId: '33', text: '/stop', segments: [{ type: 'at', qq: 99 }] }))
  assert.equal(execution.isCurrent(), false)
  f.onEvent(f.event('own-wake', { chatType: 'group', groupId: '33', text: '回来', segments: [{ type: 'at', qq: 99 }] }))
  assert.equal(execution.isCurrent(), false, '重新wake不能复活旧许可')
  await f.idle()
})

test('033：实际数组/CQ测试WS进入真实onEvent展开，再到主包', async t => {
  let server
  const f = fixture(t, (id, options) => server.call('get_forward_msg', { id }, options))
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  server = createOneBot({ host: '127.0.0.1', port, accessToken: 'test-033-ingress', onEvent: f.onEvent, log: () => {} })
  t.after(() => server.stop())
  await server.start()
  const socket = new WebSocket('ws://127.0.0.1:' + port, { headers: { authorization: 'Bearer test-033-ingress' } })
  t.after(() => socket.close())
  socket.on('message', bytes => {
    const action = JSON.parse(String(bytes))
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: response('你看这个，Echo下线').data }))
  })
  await once(socket, 'open')
  for (const [index, message] of [
    [{ type: 'forward', data: { id: 'array-ref' } }],
    '[CQ:forward,id=cq-ref]'
  ].entries()) {
    socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', self_id: '99',
      user_id: '11', sender: { nickname: '甲' }, message_id: 'wire-' + index, message }))
    await waitFor(() => f.injected.length === index + 1)
    const item = f.injected[index]
    assert.equal(item.env.text, '')
    assert.match(item.text, /乙/)
    assert.match(item.text, /你看这个/)
    assert.equal('atMe' in item.env, false)
    assert.match(item.env.forwardContent.ref, /^[0-9a-f]{32}$/)
  }
  await f.idle()
  assert.equal(f.queries.length, 2)
})
