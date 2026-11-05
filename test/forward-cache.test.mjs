/** 033：随机引用、来源边界与无遗漏分页；纯内存、假时钟。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createForwardCache } from '../lib/forward-cache.js'
import { FORWARD_NOTICES as N } from '../lib/forward-content.js'

const privateSource = { chatId: '11', chatType: 'private', senderId: '11', isMaster: true }
const groupSource = { chatId: '33', chatType: 'group', senderId: '11', isMaster: true }
const LABEL = /^转发(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([1-9]\d{0,15})$/
function labelParts (value) {
  const match = LABEL.exec(value)
  assert.ok(match, 'label应为真实UTC毫秒命名空间与进程单调序号')
  assert.ok(value.length <= 43)
  return { epoch: match[1], sequence: Number(match[2]) }
}
const image = number => ({ url: 'https://example.invalid/' + number + '.png' })
const node = (text, patch = {}) => ({
  sender: { id: '22', name: '乙' }, time: 1700000000, text, depth: 0,
  at: [], imageIndexes: [], ...patch
})
const payload = (nodes, images = [], patch = {}) => ({
  forwardContent: {
    source: 'qq-forward-quote', present: true, nodes, notices: [], truncated: false,
    stats: { requests: 2, nodes: nodes.length, chars: nodes.reduce((n, value) => n + value.text.length, 0), images: images.length },
    ...patch
  },
  images
})

function read (cache, first, page = 1, source = privateSource) {
  const result = cache.readForward({ ref: first.ref, page, source })
  assert.equal(result.ok, true, result.reason)
  return result.forwardContent
}

test('033 cache：首段有随机引用、真实页码与独立来源', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('原文')]), privateSource)
  assert.match(first.ref, /^[0-9a-f]{32}$/)
  assert.equal(first.page, 1)
  assert.equal(first.totalPages, 1)
  assert.equal(first.hasMore, false)
  assert.equal(first.source, 'qq-forward-quote')
  assert.equal(first.nodes[0].text, '原文')
  assert.deepEqual(first.nodes[0].sender, { id: '22', name: '乙' })
  assert.equal(first.nodes[0].time, 1700000000)
})

test('033 cache：按节点数分页，读取不漏不重', () => {
  const cache = createForwardCache({ pageNodes: 2 })
  const first = cache.put(payload(Array.from({ length: 5 }, (_, i) => node(String(i)))), privateSource)
  const pages = [first, read(cache, first, 2), read(cache, first, 3)]
  assert.deepEqual(pages.flatMap(page => page.nodes.map(value => value.text)), ['0', '1', '2', '3', '4'])
  assert.deepEqual(pages.map(page => page.nodes.length), [2, 2, 1])
  assert.deepEqual(pages.map(page => page.hasMore), [true, true, false])
  assert.deepEqual(pages.flatMap(page => page.nodes.map(value => value.sourceIndex)), [0, 1, 2, 3, 4])
})

test('033 cache：长节点跨页不切坏emoji，来源偏移精确连续', () => {
  const cache = createForwardCache({ pageChars: 4 })
  const original = '甲😀乙丙😀丁戊'
  const first = cache.put(payload([node(original)]), privateSource)
  const pages = Array.from({ length: first.totalPages }, (_, i) => i === 0 ? first : read(cache, first, i + 1))
  const fragments = pages.flatMap(page => page.nodes)
  assert.equal(fragments.map(value => value.text).join(''), original)
  let offset = 0
  for (const fragment of fragments) {
    assert.equal(fragment.sourceIndex, 0)
    assert.equal(fragment.textStart, offset)
    assert.equal(fragment.text, original.slice(fragment.textStart, fragment.textEnd))
    assert.equal(fragment.continued, offset > 0)
    assert.equal(fragment.hasMoreText, fragment.textEnd < original.length)
    assert.equal(fragment.sender.name, '乙')
    assert.equal(fragment.time, 1700000000)
    assert.doesNotMatch(fragment.text, /[\uD800-\uDBFF]$/)
    offset = fragment.textEnd
  }
  assert.equal(offset, original.length)
  assert.ok(pages.every(page => page.stats.chars <= 4))
})

test('033 cache：跨节点字符预算完整覆盖原正文', () => {
  const cache = createForwardCache({ pageChars: 5 })
  const texts = ['abc', 'defg', 'hi']
  const first = cache.put(payload(texts.map(value => node(value))), privateSource)
  const pages = Array.from({ length: first.totalPages }, (_, i) => i ? read(cache, first, i + 1) : first)
  for (let i = 0; i < texts.length; i++) assert.equal(pages.flatMap(page => page.nodes).filter(value => value.sourceIndex === i).map(value => value.text).join(''), texts[i])
  assert.ok(pages.every(page => page.nodes.length <= 20 && page.stats.chars <= 5))
})

test('033 cache：每页仅保留关联图片，索引重映射', () => {
  const images = [0, 1, 2, 3].map(image)
  const cache = createForwardCache({ pageNodes: 1 })
  const first = cache.put(payload([
    node('一', { imageIndexes: [2] }),
    node('二', { imageIndexes: [0, 3] })
  ], images), privateSource)
  const second = read(cache, first, 2)
  assert.deepEqual(first.images, [images[2]])
  assert.deepEqual(first.nodes[0].imageIndexes, [0])
  assert.deepEqual(second.images, [images[0], images[3]])
  assert.deepEqual(second.nodes[0].imageIndexes, [0, 1])
})

test('033 cache：长节点续片不重复图片、@或语音事实', () => {
  const cache = createForwardCache({ pageChars: 3 })
  const first = cache.put(payload([node('abcdefgh', {
    at: [{ qq: '33', name: '甲' }], imageIndexes: [0], voice: { count: 1, transcribed: false }
  })], [image(0)]), privateSource)
  const second = read(cache, first, 2)
  assert.equal(first.images.length, 1)
  assert.equal(first.nodes[0].at.length, 1)
  assert.equal(first.nodes[0].voice.count, 1)
  assert.deepEqual(second.images, [])
  assert.deepEqual(second.nodes[0].imageIndexes, [])
  assert.deepEqual(second.nodes[0].at, [])
  assert.equal('voice' in second.nodes[0], false)
})

test('033 cache：空正文图片节点仍占一条且偏移为零', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('', { imageIndexes: [0] })], [image(0)]), privateSource)
  assert.equal(first.nodes.length, 1)
  assert.equal(first.nodes[0].textStart, 0)
  assert.equal(first.nodes[0].textEnd, 0)
  assert.equal(first.nodes[0].hasMoreText, false)
  assert.equal(first.stats.chars, 0)
  assert.equal(first.stats.images, 1)
})

test('033 cache：跨群、群读私聊和私聊读群均拒绝', () => {
  const cache = createForwardCache()
  const group = cache.put(payload([node('群引文')]), groupSource)
  const privatePage = cache.put(payload([node('私聊引文')]), privateSource)
  for (const [first, source] of [
    [group, { ...groupSource, chatId: '44' }],
    [privatePage, { ...privateSource, chatType: 'group' }],
    [group, { ...groupSource, chatType: 'private' }]
  ]) {
    const result = cache.readForward({ ref: first.ref, page: 1, source })
    assert.equal(result.ok, false)
    assert.equal('forwardContent' in result, false)
  }
})

test('033 cache：私聊必须当前主人且sender与缓存主人一致', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('引文')]), privateSource)
  for (const source of [
    { ...privateSource, isMaster: false },
    { ...privateSource, senderId: '55' },
    { ...privateSource, senderId: '' }
  ]) assert.equal(cache.readForward({ ref: first.ref, source }).ok, false)
  assert.equal(read(cache, first).nodes[0].text, '引文')
})

test('033 cache：缓存私聊非主人来源不能后来冒充主人继续读', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('引文')]), { ...privateSource, isMaster: false })
  assert.equal(cache.readForward({ ref: first.ref, source: privateSource }).ok, false)
})

test('033 cache：同群不同当前说话人仍按群来源读取', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('群引文')]), groupSource)
  assert.equal(read(cache, first, 1, { ...groupSource, senderId: '55', isMaster: false }).nodes[0].text, '群引文')
})

test('033 cache：拒绝未知引用、坏页码与越界页', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('引文')]), privateSource)
  for (const ref of ['', 'not-a-ref', 'a'.repeat(32)]) assert.equal(cache.readForward({ ref, source: privateSource }).ok, false)
  for (const page of [0, -1, 1.5, '1', null, NaN, 999]) {
    assert.deepEqual(cache.readForward({ ref: first.ref, page, source: privateSource }), { ok: false, reason: 'invalid-page' })
  }
  assert.equal(read(cache, first).page, 1)
})

test('033 cache：TTL绝对过期，读取不会续期', () => {
  let now = 0
  const cache = createForwardCache({ now: () => now, ttlMs: 10 })
  const first = cache.put(payload([node('引文')]), privateSource)
  now = 5
  assert.equal(read(cache, first).nodes.length, 1)
  now = 10
  assert.deepEqual(cache.readForward({ ref: first.ref, source: privateSource }), { ok: false, reason: 'not-found' })
})

test('033 cache：容量上限与LRU淘汰', () => {
  const cache = createForwardCache({ maxEntries: 2 })
  const first = cache.put(payload([node('一')]), privateSource)
  const second = cache.put(payload([node('二')]), privateSource)
  read(cache, first)
  const third = cache.put(payload([node('三')]), privateSource)
  assert.equal(cache.readForward({ ref: second.ref, source: privateSource }).ok, false)
  assert.equal(read(cache, first).nodes[0].text, '一')
  assert.equal(read(cache, third).nodes[0].text, '三')
})

test('033 cache：来源拒绝不帮其它引用续LRU', () => {
  const cache = createForwardCache({ maxEntries: 2 })
  const first = cache.put(payload([node('一')]), privateSource)
  cache.put(payload([node('二')]), privateSource)
  cache.readForward({ ref: first.ref, source: { ...privateSource, isMaster: false } })
  cache.put(payload([node('三')]), privateSource)
  assert.equal(cache.readForward({ ref: first.ref, source: privateSource }).ok, false)
})

test('033 cache：clear与按type:id失效不影响其它聊天', () => {
  const cache = createForwardCache()
  const group = cache.put(payload([node('群')]), groupSource)
  const privatePage = cache.put(payload([node('私')]), privateSource)
  assert.equal(cache.invalidateChat('group:33'), 1)
  assert.equal(cache.readForward({ ref: group.ref, source: groupSource }).ok, false)
  assert.equal(read(cache, privatePage).nodes[0].text, '私')
  assert.equal(cache.clear(), 1)
  assert.equal(cache.readForward({ ref: privatePage.ref, source: privateSource }).ok, false)
})

test('033 cache：输入与输出修改不能改写缓存正文和图片', () => {
  const cache = createForwardCache()
  const input = payload([node('引文', { imageIndexes: [0] })], [image(0)])
  const first = cache.put(input, privateSource)
  input.forwardContent.nodes[0].text = '改写输入'
  input.images[0].url = 'https://example.invalid/changed.png'
  first.nodes[0].text = '改写输出'
  first.nodes[0].sender.name = '丙'
  first.images[0].url = 'https://example.invalid/output.png'
  const again = read(cache, first)
  assert.equal(again.nodes[0].text, '引文')
  assert.equal(again.nodes[0].sender.name, '乙')
  assert.equal(again.images[0].url, image(0).url)
})

test('033 cache：最多16项引用且随机值不同', () => {
  const cache = createForwardCache({ maxEntries: 999 })
  const pages = Array.from({ length: 17 }, () => cache.put(payload([node('引文')]), privateSource))
  assert.equal(new Set(pages.map(value => value.ref)).size, 17)
  assert.equal(cache.readForward({ ref: pages[0].ref, source: privateSource }).ok, false)
  assert.equal(read(cache, pages[16]).nodes.length, 1)
})

test('033 cache：原节点上限80并保留未缓存提示', () => {
  const cache = createForwardCache()
  const first = cache.put(payload(Array.from({ length: 100 }, () => node('引文'))), privateSource)
  const pages = Array.from({ length: first.totalPages }, (_, i) => i ? read(cache, first, i + 1) : first)
  assert.equal(pages.flatMap(value => value.nodes).length, 80)
  assert.equal(first.truncated, true)
  assert.ok(first.notices.includes(N.messages))
})

test('033 cache：正文总量24000，最后一页仍明确原内容不完整', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('a'.repeat(25000))]), privateSource)
  const pages = Array.from({ length: first.totalPages }, (_, i) => i ? read(cache, first, i + 1) : first)
  assert.equal(pages.flatMap(value => value.nodes).map(value => value.text).join('').length, 24000)
  assert.equal(pages.at(-1).hasMore, false)
  assert.equal(pages.at(-1).truncated, true)
  assert.ok(pages.at(-1).notices.includes(N.chars))
})

test('033 cache：只保存图片引用，不携带二进制或其它音频字段', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('引文', {
    imageIndexes: [0, 1], audioUrl: 'https://audio-private.invalid/token'
  })], [
    { ...image(0), data: new Uint8Array([1, 2, 3]), audio: 'private-audio' },
    { data: new Uint8Array([4, 5]) }
  ]), privateSource)
  assert.deepEqual(first.images, [image(0)])
  assert.doesNotMatch(JSON.stringify(first), /audio-private|private-audio|Uint8Array/)
})

test('033 cache：非法来源或不合法内容不创建引用', () => {
  const cache = createForwardCache()
  assert.equal(cache.put(payload([node('引文')]), { ...privateSource, chatId: '' }), null)
  assert.equal(cache.put(payload([node('引文')]), { ...privateSource, chatType: 'unknown' }), null)
  assert.equal(cache.put({ forwardContent: null }, privateSource), null)
  assert.equal(cache.put(payload([node('引文')], [], { source: 'other' }), privateSource), null)
  assert.equal('getForward' in cache, false)
})

test('033 cache：通知只接受固定安全原因，原始异常不会上屏', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('引文')], [], {
    notices: [N.requestFailed, 'https://private-error.invalid/token'], truncated: true
  }), privateSource)
  assert.deepEqual(first.notices, [N.requestFailed])
  assert.equal(first.truncated, true)
  assert.doesNotMatch(JSON.stringify(first), /private-error/)
})

test('033 cache：页预算不能由配置放大到超过20节点6000正文', () => {
  const cache = createForwardCache({ pageNodes: 9999, pageChars: 99999 })
  const first = cache.put(payload(Array.from({ length: 21 }, () => node('x'.repeat(400)))), privateSource)
  assert.ok(first.nodes.length <= 20)
  assert.ok(first.stats.chars <= 6000)
  assert.equal(first.hasMore, true)
})

test('033 cache：总正文预算边界不切坏代理对', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('a'.repeat(23999) + '😀')]), privateSource)
  const pages = Array.from({ length: first.totalPages }, (_, i) => i ? read(cache, first, i + 1) : first)
  const combined = pages.flatMap(page => page.nodes).map(value => value.text).join('')
  assert.equal(combined, 'a'.repeat(23999))
  assert.equal(first.truncated, true)
})

test('033 cache：无节点但有未读原因仍是一页，不伪造正文', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([], [], { notices: [N.unavailable], truncated: true }), privateSource)
  assert.equal(first.totalPages, 1)
  assert.equal(first.hasMore, false)
  assert.deepEqual(first.nodes, [])
  assert.deepEqual(first.notices, [N.unavailable])
})

test('033 cache：转发图片同样拒绝本机与data来源并重映射剩余HTTP引用', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('引文', { imageIndexes: [0, 1, 2, 3] })], [
    { url: 'file:///not-real/picture.png' },
    { file: 'C:\\not-real\\picture.png' },
    { url: 'data:image/png;base64,AAAA' },
    { url: '/not-real/picture.png', file: 'https://example.invalid/valid.png' }
  ]), privateSource)
  assert.deepEqual(first.images, [{ file: 'https://example.invalid/valid.png' }])
  assert.deepEqual(first.nodes[0].imageIndexes, [0])
  assert.ok(first.notices.includes(N.imageMissing))
})

test('033 cache：友好label带真实毫秒时间与单调序号且每页保留', () => {
  const cache = createForwardCache({ pageNodes: 1 })
  const first = cache.put(payload([node('一'), node('二')]), groupSource)
  const second = cache.put(payload([node('三')]), groupSource)
  const a = labelParts(first.label)
  const b = labelParts(second.label)
  assert.equal(a.epoch, b.epoch)
  assert.ok(b.sequence > a.sequence)
  assert.equal(read(cache, first, 2, groupSource).label, first.label)
  assert.notEqual(first.ref, second.ref)
})

test('033 cache：不同聊天label也不复用且引用仍隔离', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('群甲')]), groupSource)
  const source = { ...groupSource, chatId: '44' }
  const second = cache.put(payload([node('群乙')]), source)
  assert.notEqual(first.label, second.label)
  assert.ok(labelParts(second.label).sequence > labelParts(first.label).sequence)
  assert.equal(cache.readForward({ ref: first.ref, source }).ok, false)
})

test('033 cache：TTL与容量淘汰后旧label不指向新内容', () => {
  let now = 0
  const cache = createForwardCache({ maxEntries: 2, ttlMs: 10, now: () => now })
  const first = cache.put(payload([node('一')]), groupSource)
  const second = cache.put(payload([node('二')]), groupSource)
  assert.notEqual(first.label, second.label)
  const third = cache.put(payload([node('三')]), groupSource)
  assert.notEqual(third.label, first.label)
  assert.equal(cache.readForward({ ref: first.ref, source: groupSource }).ok, false)
  now = 10
  const afterExpiry = cache.put(payload([node('四')]), groupSource)
  assert.equal(new Set([first.label, second.label, third.label, afterExpiry.label]).size, 4)
  assert.ok(labelParts(afterExpiry.label).sequence > labelParts(third.label).sequence)
  assert.notEqual(labelParts(first.label).epoch, new Date(0).toISOString(), 'TTL假时钟不应成为label创建时间')
})

test('033 cache：容量仍最多16项，淘汰不回收进程单调名称', () => {
  const cache = createForwardCache()
  const active = Array.from({ length: 16 }, () => cache.put(payload([node('引文')]), groupSource))
  assert.equal(new Set(active.map(value => value.label)).size, 16)
  assert.ok(active.every(value => LABEL.test(value.label)))
  const next = cache.put(payload([node('新引文')]), groupSource)
  assert.equal(new Set([...active, next].map(value => value.label)).size, 17)
  assert.ok(labelParts(next.label).sequence > labelParts(active.at(-1).label).sequence)
  assert.equal(cache.readForward({ ref: active[0].ref, source: groupSource }).ok, false)
})

test('033 cache：同clock重建缓存实例，不复用旧名称或旧引用', () => {
  const oldCache = createForwardCache({ now: () => 0 })
  const old = oldCache.put(payload([node('旧引文')]), groupSource)
  const freshCache = createForwardCache({ now: () => 0 })
  const fresh = freshCache.put(payload([node('新引文')]), groupSource)
  assert.notEqual(old.label, fresh.label)
  assert.equal(labelParts(old.label).epoch, labelParts(fresh.label).epoch)
  assert.ok(labelParts(fresh.label).sequence > labelParts(old.label).sequence)
  assert.equal(freshCache.readForward({ ref: old.ref, source: groupSource }).ok, false)
})

test('033 cache：ESM模块重载共用小标量命名空间，旧名不成为新数据别名', async () => {
  const oldCache = createForwardCache({ now: () => 0 })
  const old = oldCache.put(payload([node('旧引文')]), groupSource)
  const reloaded = await import('../lib/forward-cache.js?label-namespace-reload-033')
  assert.notEqual(reloaded.createForwardCache, createForwardCache)
  const freshCache = reloaded.createForwardCache({ now: () => 0 })
  const fresh = freshCache.put(payload([node('新引文')]), groupSource)
  assert.notEqual(old.label, fresh.label)
  assert.equal(labelParts(old.label).epoch, labelParts(fresh.label).epoch)
  assert.ok(labelParts(fresh.label).sequence > labelParts(old.label).sequence)
  assert.equal(freshCache.readForward({ ref: old.ref, source: groupSource }).ok, false)
  assert.equal(freshCache.readForward({ ref: old.label, source: groupSource }).ok, false)
})

test('033 cache：clear与invalidateChat不重置名称序号', () => {
  const cache = createForwardCache()
  const first = cache.put(payload([node('一')]), groupSource)
  cache.clear()
  const second = cache.put(payload([node('二')]), groupSource)
  cache.invalidateChat('group:33')
  const third = cache.put(payload([node('三')]), groupSource)
  assert.equal(new Set([first.label, second.label, third.label]).size, 3)
  assert.ok(labelParts(third.label).sequence > labelParts(second.label).sequence)
})
