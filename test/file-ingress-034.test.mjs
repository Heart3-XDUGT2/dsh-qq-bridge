/** 034实际QQ入口，虚构事件与回环WS，无真实QQ/附件/模型。 */
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
import { filesOfSegments, resolveFileDownload } from '../lib/file-content.js'
import { createFileReceipts } from '../lib/file-receipts.js'
import { parseEnvelope, renderInboundText } from '../../dsh-memory-agent/lib/relay.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
async function waitFor (condition) {
  const until = Date.now() + 2000
  while (!condition() && Date.now() < until) await delay(2)
  assert.equal(condition(), true, '虚构文件入口应按预算结算')
}
function arrowOf (label, endMarker) {
  const start = source.indexOf(label), end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start + label.length, end + endMarker.indexOf('}') + 1)
}
function fixture (t) {
  const settings = { enabled: true, groupEnabled: true, allowedUsers: ['11'], allowedGroups: ['33', '44'],
    selfId: '99', masterId: '11', groupHistoryOnWakeEnabled: false }
  const contentState = { epoch: 0, disposed: false, seen: new Map(), scopes: new Map() }
  const contentQueue = createContentQueue(), forwardCache = createForwardCache()
  const groupAwake = createGroupAwake({ setTimer: () => null, clearTimer: () => {} })
  const injected = [], queries = [], executions = []
  const onebot = { call: async (action, params) => {
    queries.push({ action, params })
    return { ok: true, data: { url: 'http://download.invalid/signed?token=fixture' } }
  } }
  const fileReceipts = createFileReceipts({
    resolve: (file, origin, execution) => resolveFileDownload(file, origin, { ...execution, call: onebot.call })
  })
  t.after(() => { contentQueue.dispose(); forwardCache.clear(); fileReceipts.clear(); groupAwake.stop() })
  const deps = {
    settings, contentState, contentQueue, forwardCache, fileReceipts, groupAwake, allowsInbound,
    decideGroupMessage, isAtMe, isStopCommand, imagesOfSegments, buildPrivateEnvelope,
    filesOfSegments, hasForwardContent, expandForwardContent, FORWARD_NOTICES, onebot,
    chatKeyOf: value => value.chatType + ':' + value.chatId,
    log: () => {}, dir: 'fake', appendInbound: () => {}, inboundEntry: value => value,
    clampHistoryCount: () => 5, groupHistory: { pull: async () => {}, digest: () => '' },
    channel: { inject: async (raw, execution) => {
      assert.equal(execution.isCurrent(), true)
      const parsed = parseEnvelope(raw)
      assert.equal(parsed.ok, true)
      injected.push({ env: parsed.value, text: renderInboundText(parsed.value) })
      executions.push(execution)
      return { ok: true }
    } }
  }
  const compile = expression => new Function(...Object.keys(deps), 'return (' + expression + ')')(...Object.values(deps))
  deps.contentAllowed = compile(arrowOf('  const contentAllowed = ', '\n  }\n'))
  deps.groupAwakeApply = compile(arrowOf('  const groupAwakeApply = ', '\n  }\n'))
  const onEvent = compile(arrowOf('      onEvent: ', '\n      }\n    })'))
  const event = (id, patch = {}) => ({
    userId: '11', userName: '甲', selfId: '99', messageId: id, text: '', chatType: 'private',
    segments: [{ type: 'file', data: { file_id: 'file-' + id, name: '资料.txt', size: 30 } }], ...patch
  })
  return { settings, groupAwake, fileReceipts, injected, queries, onEvent, event, executions,
    idle: () => waitFor(() => contentQueue.stats().running === 0 && contentQueue.stats().pending === 0) }
}

test('034旧缺口：QQ信封保留独立files，主包空正文不丢弃', () => {
  const raw = buildPrivateEnvelope({ userId: '11', messageId: 'file', isMaster: true,
    segments: [{ type: 'file', data: { name: '资料.txt', size: 30 } }] })
  assert.equal(raw.ok, true)
  assert.equal(raw.envelope.text, '')
  assert.equal(raw.envelope.files.length, 1)
  assert.equal(parseEnvelope(raw.envelope).ok, true)
})

test('034实际入口：纯文件先交元数据；只有按需读取才查询私聊链接', async t => {
  const f = fixture(t)
  f.onEvent(f.event('metadata'))
  await f.idle()
  assert.equal(f.injected.length, 1)
  assert.equal(f.queries.length, 0)
  const item = f.injected[0]
  assert.equal(item.env.text, '')
  assert.equal(item.env.files.length, 1)
  assert.match(item.text, /正文.*未读|正文尚未读取/)
  assert.doesNotMatch(item.text, /signed|token=|file-metadata|0张图/)
  const result = await f.fileReceipts.openFile({ ref: item.env.files[0].ref,
    source: item.env, signal: new AbortController().signal, isCurrent: f.executions[0].isCurrent })
  assert.equal(result.ok, true)
  assert.deepEqual(f.queries.map(x => x.action), ['get_private_file_url'])
  result.finish(30)
})

test('034实际入口：未准入/睡群无收件引用，无取链动作', async t => {
  const f = fixture(t)
  f.onEvent(f.event('denied', { userId: '22' }))
  f.onEvent(f.event('sleep', { userId: '22', chatType: 'group', groupId: '33' }))
  await f.idle()
  assert.equal(f.injected.length, 0)
  assert.equal(f.queries.length, 0)
})

test('034实际入口：群醒后收文件，stop再wake不能复活旧引用；其它群不受影响', async t => {
  const f = fixture(t)
  f.groupAwake.wake('33'); f.groupAwake.wake('44')
  for (const groupId of ['33', '44']) f.onEvent(f.event('group-' + groupId, { userId: '22', chatType: 'group', groupId }))
  await f.idle()
  assert.equal(f.injected.length, 2)
  const old = f.injected.find(x => x.env.chatId === '33').env
  const other = f.injected.find(x => x.env.chatId === '44').env
  f.onEvent(f.event('stop', { chatType: 'group', groupId: '33', text: '/stop', segments: [{ type: 'at', qq: 99 }] }))
  f.onEvent(f.event('wake', { chatType: 'group', groupId: '33', text: '回来', segments: [{ type: 'at', qq: 99 }] }))
  await f.idle()
  assert.equal(f.fileReceipts.inspectFile({ ref: old.files[0].ref, source: old }).ok, false)
  assert.equal(f.fileReceipts.inspectFile({ ref: other.files[0].ref, source: other }).ok, true)
})

test('034实际入口：最多2文件，不支持音频/图片在取链前拒绝，record不走文件', async t => {
  const f = fixture(t)
  f.onEvent(f.event('mixed', { text: '看一下', segments: [
    { type: 'record', data: { file: 'voice.amr', url: 'http://audio.invalid/private' } },
    ...['录音.mp3', '图片.png', '第三份.txt'].map(name => ({ type: 'file', data: { name, file_id: 'unread' } }))
  ] }))
  await f.idle()
  const env = f.injected[0].env
  assert.equal(env.text, '看一下')
  assert.equal(env.voices.length, 1)
  assert.equal(env.files.length, 2)
  for (const file of env.files) {
    const result = await f.fileReceipts.openFile({ ref: file.ref, source: env,
      signal: new AbortController().signal, isCurrent: () => true })
    assert.equal(result.ok, false)
  }
  assert.equal(f.queries.length, 0)
  assert.match(f.injected[0].text, /未转写/)
  assert.match(f.injected[0].text, /未识图/)
  assert.doesNotMatch(f.injected[0].text, /audio\.invalid|不用回/)
})

test('034实际入口：相同通知幂等，数组/CQ/file notice均过真实测试WS', async t => {
  const f = fixture(t)
  const probe = createServer()
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const server = createOneBot({ host: '127.0.0.1', port, accessToken: 'test034',
    onEvent: f.onEvent, log: () => {} })
  t.after(() => server.stop())
  await server.start()
  const socket = new WebSocket('ws://127.0.0.1:' + port, { headers: { authorization: 'Bearer test034' } })
  t.after(() => socket.close()); await once(socket, 'open')
  const send = value => socket.send(JSON.stringify(value))
  const common = { self_id: '99', user_id: '11', time: 1700000000 }
  for (const [index, message] of [
    [{ type: 'file', data: { name: '数组.md', file_id: 'array-ref' } }],
    '[CQ:file,name=CQ.txt,file_id=cq-ref]'
  ].entries()) {
    send({ ...common, post_type: 'message', message_type: 'private', message_id: 'wire-' + index, message })
    await waitFor(() => f.injected.length === index + 1)
  }
  const notice = { ...common, post_type: 'notice', notice_type: 'offline_file',
    file: { name: '离线.txt', size: 24, url: 'http://download.invalid/?token=fixture' } }
  send(notice); send(notice)
  await waitFor(() => f.injected.length === 3)
  f.groupAwake.wake('33')
  send({ ...common, post_type: 'notice', notice_type: 'group_upload', group_id: '33',
    file: { id: 'group-file', name: '群文档.pdf', size: 50, busid: 102 } })
  await waitFor(() => f.injected.length === 4)
  send({ ...common, post_type: 'notice', notice_type: 'group_increase', group_id: '33' })
  await delay(20); await f.idle()
  assert.equal(f.injected.length, 4)
  assert.equal(f.queries.length, 0)
  assert.ok(f.injected.every(x => x.env.files.length === 1 && x.env.text === ''))
  assert.doesNotMatch(f.injected.map(x => x.text).join('\n'), /token=|download\.invalid/)
})
