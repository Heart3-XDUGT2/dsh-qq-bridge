import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGroupContext, normalizeGroupContext, replyIdOfSegments, messageIdOf, historyBefore } from '../lib/group-context.js'
import { buildPrivateEnvelope } from '../lib/envelope.js'
import { normalizeSegment } from '../lib/onebot.js'
import { createGroupHistory } from '../lib/group-history.js'
import { createGroupAwake } from '../lib/group-awake.js'
import { splitForSend } from '../lib/split.js'
import { stripEmoMarkers } from '../lib/emo-marker.js'
import { parseSettings } from '../lib/config.js'
import { QQ_SETTINGS_FIELDS } from '../lib/settings-fields.js'

const incoming = (messageId, text = 'fixture') => ({
  messageId, text, senderId: '11', senderName: '甲', ts: 10, direction: 'incoming', source: 'live'
})
test('044: social context has a user-facing opt-out, independent of admission and history', () => {
  assert.equal(parseSettings({}).settings.groupSocialEnabled, true)
  const settings = parseSettings({ groupSocialEnabled: false, groupHistoryOnWakeEnabled: true }).settings
  assert.equal(settings.groupSocialEnabled, false)
  assert.equal(settings.groupEnabled, false)
  assert.equal(settings.groupHistoryOnWakeEnabled, true)
  const field = QQ_SETTINGS_FIELDS.find(row => row.key === 'groupSocialEnabled')
  assert.equal(field.type, 'bool')
  assert.equal(field.label, '群聊社交上下文')
  assert.match(field.hint, /取消旧群任务/)
})
test('044: normalized and nested replies survive without changing text or at facts', () => {
  for (const parsed of [
    { segments: [normalizeSegment('reply', { id: 'prior' }), { type: 'text', text: '原话' }] },
    { segments: [{ type: 'reply', data: { id: 'prior' } }] }
  ]) assert.equal(replyIdOfSegments(parsed.segments), 'prior')
  const cache = createGroupContext()
  cache.record('33', incoming('prior', '先前话'))
  const context = cache.snapshot('33', { replyMessageId: 'prior' })
  const built = buildPrivateEnvelope({ userId: '11', messageId: 'now', text: '原话',
    chatType: 'group', groupId: '33', selfId: '99',
    segments: [{ type: 'at', qq: '99' }], groupContext: context })
  assert.equal(built.envelope.text, '原话')
  assert.equal(built.envelope.atMe, true)
  assert.equal(built.envelope.groupContext.reply.senderId, '11')
  assert.equal(built.envelope.groupContext.reply.isEcho, false)
  assert.equal('groupContext' in buildPrivateEnvelope({ userId: '11', messageId: 'p', text: 'x', groupContext: context }).envelope, false)
  assert.equal(normalizeGroupContext(context, '44'), null)
})
test('044: numeric reply/send identifiers accept only safe finite numbers', () => {
  assert.equal(replyIdOfSegments([{ type: 'reply', messageId: 42 }]), '42')
  assert.equal(messageIdOf(-17), '-17')
  for (const invalid of [Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, null]) assert.equal(messageIdOf(invalid), '')
})
test('044: history cutoff excludes the trigger and later messages, ambiguous times stay partial', () => {
  const rows = [{ messageId: 'a', at: 1 }, { messageId: 'now', at: 2 }, { messageId: 'later', at: 3 }]
  assert.deepEqual(historyBefore(rows, 'now', 200).entries.map(row => row.messageId), ['a'])
  assert.deepEqual(historyBefore(rows, 'missing', 2), { entries: [rows[0]], truncated: true })
  assert.deepEqual(historyBefore(rows, 'missing', undefined), { entries: [], truncated: true })
})
test('044: exact local IDs only; unknown, current and cross-group quotes never invent identities', () => {
  const cache = createGroupContext()
  cache.record('33', incoming('a'))
  cache.record('33', { ...incoming('b'), direction: 'outgoing', senderId: '99' })
  cache.record('33', { ...incoming(''), direction: 'outgoing' })
  assert.equal(cache.snapshot('33', { replyMessageId: 'b' }).reply.isEcho, true)
  assert.deepEqual(cache.snapshot('44', { replyMessageId: 'a' }).reply, { messageId: 'a', resolved: false })
  assert.deepEqual(cache.snapshot('33', { excludeMessageId: 'a', replyMessageId: 'a' }).reply, { messageId: 'a', resolved: false })
  assert.equal(cache.record('33', incoming('a', 'retry')), false)
  assert.equal(cache.snapshot('33').recent.length, 3)
})
test('044: groups, entry count, text budget, TTL and returned snapshots are bounded', () => {
  let clock = 100
  const cache = createGroupContext({ now: () => clock })
  for (let g = 0; g < 140; g++) cache.record(String(g), incoming('id'))
  assert.equal(cache.status().groups, 128)
  for (let i = 0; i < 30; i++) cache.record('active', incoming(String(i), '字'.repeat(600)))
  const snapshot = cache.snapshot('active', { replyMessageId: '29' })
  assert.ok(snapshot.recent.length <= 20)
  assert.equal(snapshot.truncated, true)
  assert.ok(snapshot.recent.every(row => row.text.length <= 400))
  assert.ok(snapshot.recent.reduce((n, row) => n + row.text.length, snapshot.reply?.text?.length ?? 0) <= 4000)
  snapshot.recent[0].text = 'mutated'
  assert.notEqual(cache.snapshot('active').recent[0].text, 'mutated')
  clock += 600000
  assert.equal(cache.status().groups, 0)
})
test('044: idle, manual sleep and stop each notify cleanup, retain is isolated', () => {
  const callbacks = []
  const timers = []
  const awake = createGroupAwake({ setTimer: fn => { timers.push(fn); return timers.length },
    clearTimer: () => {}, onSleep: (id, reason) => callbacks.push([id, reason]) })
  awake.wake('33'); timers.at(-1)()
  awake.wake('44'); awake.sleep('44')
  awake.wake('55'); awake.stop()
  assert.deepEqual(callbacks, [['33', 'idle'], ['44', 'sleep'], ['55', 'stop']])
  assert.equal(awake.status().awakeCount, 0)
})
test('044: history late responses cannot refill forgotten or revoked groups; bounded metadata', async () => {
  let resolve
  const history = createGroupHistory({ fetch: () => new Promise(done => { resolve = done }) })
  const pending = history.pull('33', 20)
  history.forget('33')
  resolve({ messages: [{ message_id: 'h', user_id: '11', time: 1, message: [{ type: 'text', data: { text: 'old' } }] }] })
  assert.deepEqual(await pending, [])
  assert.deepEqual(history.list('33'), [])
  let current = true
  const next = history.pull('33', 20, { isCurrent: () => current })
  current = false
  resolve({ messages: [] })
  await next
  assert.deepEqual(history.list('33'), [])
  history.clear()
  assert.deepEqual(history.status().groups, {})
})
test('044: history digest uses the same pre-trigger boundary and bounded cache expires without polling', async () => {
  let clock = 100
  let pulls = 0
  const history = createGroupHistory({ now: () => clock, fetch: async () => {
    pulls++
    return { messages: [
      { message_id: 'past', time: 1, raw_message: 'past-body', user_id: '11' },
      { message_id: 'now', time: 2, raw_message: 'trigger-body', user_id: '11' },
      { message_id: 'future', time: 3, raw_message: 'future-body', user_id: '11' }
    ] }
  } })
  await history.pull('33', 20)
  const digest = history.digest('33', { beforeMessageId: 'now', beforeTs: 2000 })
  assert.match(digest, /past-body/)
  assert.doesNotMatch(digest, /trigger-body|future-body/)
  for (let i = 0; i < 140; i++) await history.pull(String(i), 20)
  assert.equal(Object.keys(history.status().groups).length, 128)
  const before = pulls
  clock += 600000
  assert.equal(history.status().entries, 0)
  assert.equal(pulls, before)
})
test('044: actual outbound function records successful segments only; partial send and empty ack are distinct', async () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('  async function deliver (rows) {')
  const end = source.indexOf('\n  /**', start + 1)
  assert.ok(start > 0 && end > start)
  const cache = createGroupContext()
  const scope = {}
  const contentState = { epoch: 0, disposed: false, scopes: new Map([['group:33', scope]]) }
  let calls = 0
  const onebot = { sendGroupMsg: async () => ++calls === 1 ? { ok: true, messageId: 'sent-1' } : { ok: false } }
  const deps = { settings: { replyMaxChars: 10, segmentGapMs: 1, selfId: '99' }, contentState,
    groupAwake: { isAwake: () => true }, groupContext: cache, onebot, messageIdOf,
    DELIVER_BUDGET_MS: Number(source.match(/const DELIVER_BUDGET_MS = (\d+)/)[1]),
    BUBBLE_WAIT_CAP_MS: Number(source.match(/const BUBBLE_WAIT_CAP_MS = (\d+)/)[1]),
    splitForSend, stripEmoMarkers, log: () => {}, stats: { sent: 0, failed: 0 } }
  const deliver = new Function(...Object.keys(deps), 'return (' + source.slice(start, end).trim() + ')')(...Object.values(deps))
  const acks = await deliver([{ id: 1, chatType: 'group', chatId: '33', text: 'abcdefghij'.repeat(10) }])
  assert.deepEqual(acks, [])
  assert.deepEqual(cache.snapshot('33').recent.map(row => row.messageId), ['sent-1'])
  const before = calls
  assert.deepEqual(await deliver([{ id: 2, chatType: 'group', chatId: '33', text: '' }]), [2])
  assert.equal(calls, before)
  assert.equal(cache.snapshot('33').recent.length, 1)
  cache.clear()
  onebot.sendGroupMsg = async () => ({ ok: true, messageId: 42 })
  assert.deepEqual(await deliver([{ id: 3, chatType: 'group', chatId: '33', text: 'numeric receipt' }]), [3])
  assert.equal(cache.snapshot('33', { replyMessageId: '42' }).reply.isEcho, true)
  onebot.sendGroupMsg = async () => ({ ok: true })
  assert.deepEqual(await deliver([{ id: 4, chatType: 'group', chatId: '33', text: 'no ID' }]), [4])
  assert.equal(cache.snapshot('33').recent.at(-1).messageId, '')
  let finish
  onebot.sendGroupMsg = () => new Promise(resolve => { finish = resolve })
  const late = deliver([{ id: 5, chatType: 'group', chatId: '33', text: 'late' }])
  contentState.epoch++
  finish({ ok: true, messageId: 'late-receipt' })
  await late
  assert.equal(cache.snapshot('33').recent.some(row => row.messageId === 'late-receipt'), false)
})
test('044: actual reload and idle invalidation clear context/history and defeat late pulls', async () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const groupContext = createGroupContext()
  let resolve
  const groupHistory = createGroupHistory({ fetch: () => new Promise(done => { resolve = done }) })
  const contentState = { epoch: 0, seen: new Map(), scopes: new Map() }
  const contentQueue = { invalidate: () => {} }
  const forwardCache = { clear: () => {}, invalidateChat: () => {} }
  const fileReceipts = { clear: () => {}, invalidateChat: () => {} }
  const deps = { contentState, groupContext, groupHistory, contentQueue, forwardCache, fileReceipts }
  const start = source.indexOf('  function invalidateGroup (')
  const end = source.indexOf('\n  const forwardCache', start)
  const invalidate = new Function(...Object.keys(deps), 'return (' + source.slice(start, end).trim() + ')')(...Object.values(deps))
  const timers = []
  const groupAwake = createGroupAwake({ setTimer: callback => { timers.push(callback); return timers.length },
    clearTimer: () => {}, onSleep: invalidate })
  groupAwake.wake('33')
  groupContext.record('33', incoming('old'))
  const late = groupHistory.pull('33', 20)
  timers.at(-1)()
  assert.equal(groupContext.status().entries, 0)
  resolve({ messages: [{ message_id: 'late', user_id: '11', time: 1, raw_message: 'late' }] })
  await late
  assert.deepEqual(groupHistory.list('33'), [])
  const initial = { enabled: true, groupEnabled: true, allowedGroups: ['33'], selfId: '99', masterId: '11' }
  const request = { settings: initial, problems: [] }
  const rStart = source.indexOf('  async function reload () {')
  const rEnd = source.indexOf('\n  // 配置的', rStart)
  const reloadDeps = { ...deps, groupAwake, readSettings: async () => request, dir: 'synthetic', DEFAULT_SETTINGS: {} }
  const reload = new Function(...Object.keys(reloadDeps), 'settings', 'problems',
    source.slice(rStart, rEnd) + '\nreturn reload')(...Object.values(reloadDeps), initial, [])
  for (const next of [
    { ...initial, enabled: false }, { ...initial, selfId: '100' },
    { ...initial, allowedGroups: [] }
  ]) {
    groupAwake.wake('33')
    groupContext.record('33', incoming('live'))
    const pending = groupHistory.pull('33', 20)
    request.settings = next
    const epoch = contentState.epoch
    await reload()
    assert.equal(contentState.epoch, epoch + 1)
    assert.equal(groupContext.status().entries, 0)
    assert.equal(groupAwake.isAwake('33'), false)
    resolve({ messages: [{ message_id: 'late', user_id: '11', time: 1, raw_message: 'late' }] })
    await pending
    assert.deepEqual(groupHistory.list('33'), [])
  }
})
test('044: actual disposal clears timers, context/history and late work', async () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const contentState = { epoch: 0, disposed: false, seen: new Map(), scopes: new Map() }
  const groupContext = createGroupContext()
  const groupHistory = createGroupHistory()
  const groupAwake = createGroupAwake({ setTimer: () => null, clearTimer: () => {} })
  groupAwake.wake('33')
  groupContext.record('33', incoming('a'))
  const start = source.indexOf('  ctx.effect(() => () => {\n    contentState.disposed')
  const end = source.indexOf("\n  }, 'echo-qq.dispose()')", start)
  assert.ok(start > 0 && end > start)
  const deps = {
    contentState, groupContext, groupHistory, groupAwake,
    contentQueue: { dispose () {} }, fileSendService: null,
    forwardCache: { clear () {} }, fileReceipts: { clear () {} },
    channel: null, qzone: null, onebot: null
  }
  new Function(...Object.keys(deps), 'let disposed=false,mouthRegistered=false,mouthOff=null;\n' +
    source.slice(start + '  ctx.effect(() => () => {'.length, end))(...Object.values(deps))
  assert.equal(contentState.disposed, true)
  assert.equal(groupContext.status().entries, 0)
  assert.equal(groupAwake._timerCount(), 0)
})
test('044: startup uses the committed settings and only primes allowed history without injecting', async () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('  async function primeGroupHistory () {')
  const end = source.indexOf('\n  /**', start + 1)
  const settings = { enabled: true, groupEnabled: true, groupHistoryOnWakeEnabled: true,
    allowedGroups: ['33'], groupHistoryOnWakeCount: 20 }
  const contentState = { epoch: 0, disposed: false }
  const pulls = []
  const groupHistory = {
    pull: async (id, count, options) => { if (options.isCurrent()) pulls.push([id, count]) },
    status: () => ({})
  }
  const fn = new Function('settings', 'contentState', 'groupHistory', 'log',
    'return (' + source.slice(start, end).trim() + ')')(settings, contentState, groupHistory, () => {})
  await fn()
  assert.deepEqual(pulls, [['33', 20]])
  settings.enabled = false
  await fn()
  assert.equal(pulls.length, 1)
  settings.enabled = true
  settings.groupHistoryOnWakeEnabled = false
  await fn()
  assert.equal(pulls.length, 1)
})
test('044: actual social opt-out reload invalidates group tasks, retains awake/history and private tasks', async () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('  async function reload () {')
  const end = source.indexOf('\n  // 配置的', start)
  const initial = { enabled: true, groupEnabled: true, allowedGroups: ['33'], groupSocialEnabled: true }
  const next = { ...initial, groupSocialEnabled: false }
  const cache = createGroupContext()
  cache.record('33', incoming('a'))
  const contentState = { epoch: 0, socialEpoch: 0, seen: new Map(),
    scopes: new Map([['group:33', {}], ['private:11', {}]]) }
  const invalidated = []
  let stopped = false, historyCleared = false
  const deps = {
    readSettings: async () => ({ settings: next, problems: [] }), dir: 'synthetic', DEFAULT_SETTINGS: {},
    contentState, groupContext: cache, contentQueue: { invalidate: key => invalidated.push(key) },
    groupAwake: { stop: () => { stopped = true } },
    groupHistory: { clear: () => { historyCleared = true } },
    forwardCache: { clear () {}, invalidateChat () {} }, fileReceipts: { clear () {}, invalidateChat () {} }
  }
  const reload = new Function(...Object.keys(deps), 'settings', 'problems',
    source.slice(start, end) + '\nreturn reload')(...Object.values(deps), initial, [])
  await reload()
  assert.deepEqual(invalidated, ['group:33'])
  assert.equal(contentState.scopes.has('private:11'), true)
  assert.equal(contentState.epoch, 0)
  assert.equal(contentState.socialEpoch, 1)
  assert.equal(cache.status().entries, 0)
  assert.equal(stopped, false)
  assert.equal(historyCleared, false)
})
