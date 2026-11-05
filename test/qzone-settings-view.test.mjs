/**
 * `qzoneSettingsView` × `cfg()` 的**键对齐** —— 2026-10-20
 * ==================================================================
 * ## 这条闸是为什么来的
 *
 * `qzone.js` 的 `cfg()` 从注入的 `settings` 里读一串键（`lib/qzone.js:259-271`），
 * 而生产给它的不是完整 settings，是 `index.js:220` 那张**裁剪过的视图**
 * `qzoneSettingsView`（只有显式列出的 getter 才读得到）。
 *
 * 2026-10-20 发现视图**漏了 `qzoneWatchList` 和 `masterId`** ⇒ 生产里两者永远是
 * `undefined`：
 *
 *   · `watchList` 空集 ⇒ `listFeeds` 永远 `watchlist-empty`、
 *     `listMoods(uin)` 看谁都 `not-in-watchlist`;
 *   · **`replyComment` 的白名单闸（`qzone.js:622`）永远 false** —— 连他本人都回不了。
 *
 * 这个洞从 `a7f636f`（2026-10-19）就在，**一直没被任何测试发现**，因为
 * 所有单测都是直接给 `createQzoneChannel` 喂**完整 settings**，
 * 而生产喂的是视图。**喂法不同，测试就测不到。**
 *
 * ⇒ 这条闸直接比对两边：**`cfg()` 读的键 ⊆ 视图暴露的键**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const QZONE = read('../lib/qzone.js')
const INDEX = read('../lib/index.js')

/** 抠出 `cfg()` 的函数体。 */
function cfgBody () {
  // 注意写法：源码里是 `function cfg() {`（cfg 与括号之间**没有空格**）
  const at = QZONE.search(/function cfg\s*\(/)
  assert.ok(at > 0, '找不到 cfg()')
  // 收到下一个同级的 `  function` / `  }` 为止（取靠前的那个）
  const nextFn = QZONE.indexOf('\n  function ', at + 5)
  const nextBrace = QZONE.indexOf('\n  }', at + 5)
  const cands = [nextFn, nextBrace].filter((x) => x > at)
  assert.ok(cands.length > 0, '找不到 cfg() 的收尾')
  return QZONE.slice(at, Math.min(...cands))
}

/** `cfg()` 里以 `s.<key>` 读的全部键。 */
function keysReadByCfg () {
  const body = cfgBody()
  const out = new Set()
  for (const m of body.matchAll(/\bs\.([A-Za-z_$][\w$]*)/g)) out.add(m[1])
  return [...out].sort()
}

/** `qzoneSettingsView` 暴露的 getter 名。 */
function keysExposedByView () {
  const at = INDEX.indexOf('const qzoneSettingsView')
  assert.ok(at > 0, '找不到 qzoneSettingsView')
  const end = INDEX.indexOf('\n  }', at)
  const body = INDEX.slice(at, end)
  const out = new Set()
  for (const m of body.matchAll(/get\s+([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1])
  return [...out].sort()
}

test('① ★ cfg() 读到的每个键，视图都必须暴露（否则生产读到 undefined）', () => {
  const need = keysReadByCfg()
  const have = new Set(keysExposedByView())
  const missing = need.filter((k) => !have.has(k))
  assert.deepEqual(missing, [],
    '★ 视图漏了这些键 ⇒ 生产里会是 undefined：' + missing.join(', '))
})

test('② ★ 两个"历史上漏过"的键必须在（回归钉）', () => {
  const have = keysExposedByView()
  assert.ok(have.includes('qzoneWatchList'),
    '★ 漏了它 ⇒ 白名单永远空集（listFeeds / listMoods(uin) / replyComment 全哑）')
  assert.ok(have.includes('masterId'),
    '★ 漏了它 ⇒ 连他本人都过不了 replyComment 的白名单闸')
})

test('③ 视图至少覆盖 cfg() 用的全部 9 个键', () => {
  const need = keysReadByCfg()
  assert.ok(need.length >= 9, 'cfg() 应读 9 个键，实际 ' + need.length + ': ' + need.join(', '))
  for (const k of ['qzoneEnabled', 'qzoneHost', 'qzonePort', 'qzoneAccessToken',
    'qzoneDefaultUgcRight', 'qzoneCookieRefreshMin', 'qzoneSelfUin',
    'qzoneWatchList', 'masterId']) {
    assert.ok(need.includes(k), 'cfg() 没读 ' + k + '？结构变了就来看这条')
  }
})

test('④ ★ 用"只暴露视图该有的键"的对象喂进去，白名单要读得到', async () => {
  // 关键：**故意不喂完整 settings**，只喂视图会暴露的那几个键 ——
  // 这正是生产的样子。上一轮所有测试都喂完整对象，所以没抓到那个洞。
  const { createQzoneChannel } = await import('../lib/qzone.js')
  const seen = []
  const viewLike = {
    qzoneEnabled: true,
    qzoneHost: '127.0.0.1',
    qzonePort: 5700,
    qzoneAccessToken: '',
    qzoneDefaultUgcRight: 1,
    qzoneCookieRefreshMin: 0,
    qzoneSelfUin: '3783207594',
    qzoneWatchList: '880000002,880000003',
    masterId: '880000001'
  }
  const ch = createQzoneChannel({
    settings: viewLike,
    log: () => {},
    getCookies: null,
    fetchImpl: async (url, opts) => {
      seen.push(opts && opts.body ? JSON.parse(opts.body) : {})
      return {
        ok: true,
        text: async () => JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: {
            msglist: [
              { tid: 't1', uin: '880000002', nickname: 'a', content: 'x', created_time: 1 },
              { tid: 't2', uin: '999999', nickname: 'b', content: 'y', created_time: 2 }
            ],
            has_more: false
          }
        })
      }
    }
  })

  // 白名单非空 ⇒ 不该是 watchlist-empty
  const r = await ch.listFeeds({ count: 5 })
  assert.equal(r.ok, true, '★ 白名单读到了就该能翻：' + JSON.stringify(r))
  assert.equal(r.count, 1, '名单外的 999999 要被筛掉')
  assert.equal(r.watchlistSize, 2, '★ watchlistSize 应为 2（证明视图里的值真读到了）')
})

test('⑤ ★ 视图喂进来时，replyComment 的闸认得 masterId', async () => {
  const { createQzoneChannel } = await import('../lib/qzone.js')
  const viewLike = {
    qzoneEnabled: true,
    qzoneHost: '127.0.0.1',
    qzonePort: 5700,
    qzoneAccessToken: '',
    qzoneDefaultUgcRight: 1,
    qzoneCookieRefreshMin: 0,
    qzoneSelfUin: '3783207594',
    qzoneWatchList: '880000002',
    masterId: '880000001'
  }
  let posted = false
  const ch = createQzoneChannel({
    settings: viewLike,
    log: () => {},
    getCookies: null,
    fetchImpl: async () => {
      posted = true
      return { ok: true, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: {} }) }
    }
  })
  // 他本人的评论 ⇒ 必须放行（masterId 那条分支）
  const r = await ch.replyComment({ tid: 'abcdef0123456789abcdef01', content: '嗯', targetUin: '880000001' })
  assert.equal(r.ok, true, '★ masterId 读到了，他本人的评论要能回：' + JSON.stringify(r))
  assert.equal(posted, true, '应真的发了 send_comment')

  // 名单外的人 ⇒ 仍要拒（闸没被放开）
  const bad = await ch.replyComment({ tid: 'abcdef0123456789abcdef01', content: '嗯', targetUin: '999999' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'not-in-watchlist')
})
