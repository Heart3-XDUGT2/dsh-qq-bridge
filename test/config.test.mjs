import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowsInbound, DEFAULT_SETTINGS, parseSettings } from '../lib/config.js'

test('默认值:总闸关、白名单空、口令空(三条纪律的默认面)', () => {
  const { settings } = parseSettings({})
  assert.equal(settings.enabled, false)
  assert.deepEqual(settings.allowedUsers, [])
  assert.equal(settings.accessToken, '')
  assert.equal(settings.port, DEFAULT_SETTINGS.port)
  // 旧桥退役(2026-09-28):HTTP 兜底连同它专用的两个键一起没了 —— 默认面里不该再有它们。
  assert.equal('mainBaseUrl' in DEFAULT_SETTINGS, false, 'mainBaseUrl 已随旧桥退役,不该回到默认值里')
  assert.equal('mainToken' in DEFAULT_SETTINGS, false, 'mainToken 已随旧桥退役,不该回到默认值里')
  assert.equal(settings.mainBaseUrl, undefined)
  assert.equal(settings.mainToken, undefined)
})

test('transport 开关:默认 auto,只认 auto/service,坏值落回并记账', () => {
  assert.equal(parseSettings({}).settings.transport, 'auto')
  assert.equal(parseSettings({ transport: 'service' }).settings.transport, 'service')
  assert.equal(parseSettings({ transport: ' SERVICE ' }).settings.transport, 'service', '宽容:trim + 小写')
  const bad = parseSettings({ transport: 'websocket' })
  assert.equal(bad.settings.transport, 'auto')
  assert.ok(bad.problems.some((p) => p.includes('transport')), '坏值必须记账(不静默)')
})

test('transport=http 已退役:落回 auto,并且**明说一句**(不静默)', () => {
  const { settings, problems } = parseSettings({ transport: 'http' })
  assert.equal(settings.transport, 'auto', '旧配置里的 http 落回 auto')
  const note = problems.find((p) => p.includes('transport=http'))
  assert.ok(note, '要有一条专门讲退役的:' + JSON.stringify(problems))
  assert.ok(note.includes('退役'), '理由要说清是退役,而不是"值不认识":' + note)
})

test('mainBaseUrl / mainToken 已退役:配着也不读,并且记进 problems', () => {
  const { settings, problems } = parseSettings({ mainBaseUrl: 'http://10.0.0.5:9000', mainToken: 'tok' })
  assert.equal(settings.mainBaseUrl, undefined, '不再解析这个字段')
  assert.equal(settings.mainToken, undefined, '不再解析这个字段')
  const note = problems.find((p) => p.includes('mainBaseUrl'))
  assert.ok(note, '必须报出来(留给面板与启动日志看):' + JSON.stringify(problems))
  assert.ok(note.includes('退役'), '理由要说清是"随旧桥退役":' + note)
  // 只留一个键也要报
  assert.ok(parseSettings({ mainToken: 'x' }).problems.some((p) => p.includes('退役')))
  // 没配过这两个键 ⇒ 不该有这条噪音
  assert.equal(parseSettings({}).problems.some((p) => p.includes('退役')), false)
})

test('严格模式会留一条提醒(验收完记得改回去)', () => {
  const { problems } = parseSettings({ enabled: true, accessToken: 't', allowedUsers: ['1'], transport: 'service' })
  assert.ok(problems.some((p) => p.includes('严格模式')), 'service 严格模式要有提醒')
  const auto = parseSettings({ enabled: true, accessToken: 't', allowedUsers: ['1'] })
  assert.equal(auto.problems.some((p) => p.includes('严格模式')), false, 'auto 不该有这条')
})

test('坏值落回默认,并记账(不静默吞)', () => {
  const { settings, problems } = parseSettings({ port: 99999, replyMaxChars: 0 })
  assert.equal(settings.port, DEFAULT_SETTINGS.port)
  assert.equal(settings.replyMaxChars, DEFAULT_SETTINGS.replyMaxChars)
  assert.equal(problems.length, 2)
  assert.ok(problems[0].includes('port'))
})

test('开了总闸但没口令 / 没白名单 —— 都要明确警告', () => {
  const { problems } = parseSettings({ enabled: true })
  assert.ok(problems.some((p) => p.includes('accessToken')))
  assert.ok(problems.some((p) => p.includes('白名单')))
})

test('白名单:非数组/空串一律清成干净数组', () => {
  const { settings } = parseSettings({ allowedUsers: [' 123 ', '', null, 456] })
  assert.deepEqual(settings.allowedUsers, ['123', '456'])
  const { settings: s2 } = parseSettings({ allowedUsers: 'not-an-array' })
  assert.deepEqual(s2.allowedUsers, [])
})

/**
 * ★ 2026-10-17：`masterId` —— 群里判「这话是不是他说的」。
 *
 * 原来拿 `selfId`（**她**的号）比 ⇒ 群里发言的永远不是她
 * ⇒ `isMaster` 恒 false ⇒ 他自己说的话也被标「（非主人）」+ 贴警惕。
 */
test('★ masterId:显式配就用自己的,没配就回退到私聊白名单第一个', () => {
  // 显式配 ⇒ 用它
  assert.equal(parseSettings({ masterId: ' 999 ', allowedUsers: ['123'] }).settings.masterId, '999')
  // 没配 ⇒ 回退 allowedUsers[0]
  assert.equal(parseSettings({ allowedUsers: ['123', '456'] }).settings.masterId, '123')
  // 都没有 ⇒ 空（群聊里谁都不算主人，从严）
  assert.equal(parseSettings({}).settings.masterId, '')
  // ⚠️ 绝不许拿 selfId 顶 —— 那是她的号
  const withSelf = parseSettings({ selfId: '3783207594', allowedUsers: [] })
  assert.equal(withSelf.settings.masterId, '', 'selfId 不许被当成 masterId')
  assert.equal(withSelf.settings.selfId, '3783207594', 'selfId 仍然独立存在')
})

test('allowsInbound:总闸关 / 不在白名单 / 通过（私聊，原样不变）', () => {
  const base = { enabled: true, allowedUsers: ['123'] }
  assert.equal(allowsInbound({ ...base, enabled: false }, { userId: '123' }).reason, 'disabled')
  assert.equal(allowsInbound(base, { userId: '999' }).reason, 'not-allowlisted')
  assert.equal(allowsInbound(base, { userId: '' }).reason, 'no-user')
  assert.equal(allowsInbound(base, { userId: '123' }).ok, true)
  assert.equal(allowsInbound(base, { userId: '123' }).chatType, 'private')
  // 白名单为空 ⇒ 一律拒收(不做"空即全通")
  assert.equal(allowsInbound({ enabled: true, allowedUsers: [] }, { userId: '123' }).reason, 'not-allowlisted')
})

// ★ 2026-10-15 加群聊：判据按类型分开。私聊那条路一字未变（上面那条钉着）。
test('allowsInbound 群聊:总闸 / 群闸 / 群白名单 / 通过（成员不设白名单）', () => {
  const base = { enabled: true, allowedUsers: ['123'], groupEnabled: true, allowedGroups: ['G1'] }
  const g = (over, args) => allowsInbound({ ...base, ...over }, { chatType: 'group', groupId: 'G1', userId: '123', ...args })
  // ① 群聊总闸关 ⇒ 拒（默认就是关的）
  assert.equal(g({ groupEnabled: false }).reason, 'group-disabled')
  assert.equal(g({}).ok, true)
  assert.equal(g({}).chatType, 'group')
  // ② 不在群白名单里 ⇒ 拒
  assert.equal(g({}, { groupId: 'G9' }).reason, 'group-not-allowlisted')
  // ③ 没有群号 ⇒ 拒
  assert.equal(g({}, { groupId: '' }).reason, 'no-group')
  // ④ ★ 群白名单为空 ⇒ 一律拒收（与私聊同一条纪律；群聊这条更危险 —— 一进群就被灌满）
  assert.equal(g({ allowedGroups: [] }).reason, 'group-not-allowlisted')
  // ⑤ ★ **群里谁说话都收** —— 成员不设白名单（"谁进记忆"由主包按 isMaster 判，不是这里）
  assert.equal(g({}, { userId: '999' }).ok, true, '非白名单成员在群里也该收')
  assert.equal(g({}, { userId: '' }).ok, true, '群里甚至连 userId 都可以空')
  // ⑥ 群聊白名单**不**该被私聊名单影响
  assert.equal(allowsInbound({ enabled: true, allowedUsers: [], groupEnabled: true, allowedGroups: ['G1'] },
    { userId: 'x', groupId: 'G1', chatType: 'group' }).ok, true, '私聊名单空不影响群聊')
})
