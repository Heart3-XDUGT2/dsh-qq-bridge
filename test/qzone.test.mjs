/**
 * lib/qzone.js 的行为电池（2026-10-15）。
 *
 * 三条硬纪律各自钉一组：
 *   ① 白名单 —— 名单外一律拒发，**且不产生网络调用**；
 *   ② 权限必填 —— 不给/给错 ⇒ 拒，**且不产生网络调用**（桥侧默认是"所有人可见"，最危险的一条）；
 *   ③ 失败不静默 —— 超时/HTTP 错/桥返回失败/未登录，形状各不相同。
 *
 * 外加 Cookie 拼串（宽容认形状 + 缺字段不灌）与保活（复核、失败不抛、stop 生效）。
 *
 * 依赖全部注入 ⇒ 离线可测，不碰网络、不碰真桥。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildCookieString,
  cookieFieldOf,
  createQzoneChannel,
  missingCookieFields,
  buildMoodSegments,
  QZONE_ACTIONS,
  QZONE_COOKIE_DOMAIN,
  makeGetCookies,
  UGC_RIGHT,
} from '../lib/qzone.js'

/** 一个记账用的假 fetch：按脚本回包，并把每次请求记下来。 */
function fakeFetch (script = () => ({ status: 200, body: { status: 'ok', retcode: 0, data: {} } })) {
  const calls = []
  const fn = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {}
    calls.push({ url: String(url), method: opts?.method, headers: opts?.headers ?? {}, body })
    const r = script({ url: String(url), body, opts, index: calls.length - 1 }) ?? {}
    const status = Number(r.status ?? 200)
    if (r.throw) throw new Error(r.throw)
    const text = typeof r.raw === 'string' ? r.raw : JSON.stringify(r.body ?? {})
    return { status, text: async () => text }
  }
  fn.calls = calls
  return fn
}

const ON = {
  qzoneEnabled: true,
  qzoneHost: '127.0.0.1',
  qzonePort: 5700,
  qzoneAccessToken: 'tok',
  qzoneDefaultUgcRight: UGC_RIGHT.PUBLIC,
  qzoneCookieRefreshMin: 10,
  qzoneSelfUin: '3783207594',
}

function make (over = {}, fetchScript) {
  const logs = []
  const fetchImpl = fakeFetch(fetchScript)
  // ⚠️ `settings` 要**先摘出来**再铺 `...rest` —— 否则 `...over` 会把合并好的
  // settings 又覆盖成那个偏量（`{qzoneDefaultUgcRight: 64}` 少了 `qzoneEnabled`
  // ⇒ 通道被判成 disabled，测试会以"没发请求"这种看不懂的方式失败）。
  const { settings: overSettings, ...rest } = over
  const ch = createQzoneChannel({
    settings: { ...ON, ...(overSettings ?? {}) },
    log: (level, msg) => logs.push(level + ': ' + msg),
    fetchImpl,
    ...rest,
  })
  return { ch, fetchImpl, logs }
}

// ============================================================================
// ① 白名单
// ============================================================================

test('白名单:名单外的 action 一律拒发,且不发请求', async () => {
  const { ch, fetchImpl } = make()
  for (const bad of ['set_group_ban', 'get_group_list', 'send_group_msg', 'evil']) {
    const r = await ch.call(bad, {})
    assert.equal(r.ok, false, bad + ' 必须被拒')
    assert.equal(r.reason, 'action-not-allowed')
  }
  assert.equal(fetchImpl.calls.length, 0, '被拒的 action 不许产生任何网络调用')
})

test('白名单:名单本身只含空间那几条(写动作也在,但只走桥)', () => {
  assert.ok(QZONE_ACTIONS.includes('send_private_msg'), '发说说走这条')
  assert.ok(QZONE_ACTIONS.includes('delete_msg'), '删说说')
  assert.ok(QZONE_ACTIONS.includes('get_emotion_list'), '读说说')
  assert.ok(QZONE_ACTIONS.includes('login_cookie'), '灌 Cookie')
  assert.equal(QZONE_ACTIONS.includes('set_group_ban'), false)
  assert.equal(QZONE_ACTIONS.includes('send_group_msg'), false)
})

test('总闸关 ⇒ 白名单内的 action 也回 disabled,不发请求', async () => {
  const { ch, fetchImpl } = make({ settings: { qzoneEnabled: false } })
  const r = await ch.call('get_login_info', {})
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(fetchImpl.calls.length, 0)
})

// ============================================================================
// ② 权限必填（最危险的一条）
// ============================================================================

test('发说说:不给权限、面板也没默认值 ⇒ 拒,且不发请求', async () => {
  const { ch, fetchImpl } = make({ settings: { qzoneDefaultUgcRight: 0 } })
  const r = await ch.postMood({ content: '你好', whoCanSee: null })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ugc-right-required')
  assert.equal(fetchImpl.calls.length, 0, '★ 校验必须在发请求之前')
})

test('发说说:权限给错值(不在 1/4/16/64/128)⇒ 拒,且不发请求', async () => {
  const { ch, fetchImpl } = make()
  for (const bad of [0, 2, 3, 99, -1, NaN]) {
    const r = await ch.postMood({ content: '你好', whoCanSee: bad })
    assert.equal(r.ok, false, String(bad) + ' 必须被拒')
    assert.equal(r.reason, 'ugc-right-required')
  }
  assert.equal(fetchImpl.calls.length, 0)
})

test('发说说:显式给权限 ⇒ 发出,且 who_can_see 原样带上', async () => {
  const { ch, fetchImpl } = make({}, () => ({ body: { status: 'ok', retcode: 0, data: { tid: 'T1' } } }))
  const r = await ch.postMood({ content: '你好', whoCanSee: UGC_RIGHT.SELF })
  assert.equal(r.ok, true)
  assert.equal(r.tid, 'T1')
  assert.equal(r.whoCanSee, 64)
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].body.who_can_see, 64)
})

test('发说说:不给权限但面板配了默认 ⇒ 用默认值(不是"拒")', async () => {
  const { ch, fetchImpl } = make({ settings: { qzoneDefaultUgcRight: 64 } })
  const r = await ch.postMood({ content: '你好' })
  assert.equal(r.ok, true)
  assert.equal(fetchImpl.calls[0].body.who_can_see, 64)
})

test('发说说:正文空 / 超长 ⇒ 拒,不发请求', async () => {
  const { ch, fetchImpl } = make()
  assert.equal((await ch.postMood({ content: '   ' })).reason, 'content-required')
  assert.equal((await ch.postMood({ content: 'x'.repeat(2000) })).reason, 'content-too-long')
  assert.equal(fetchImpl.calls.length, 0)
})

test('发说说:图片段按 OneBot 形状拼(文本在前)', () => {
  const segs = buildMoodSegments('正文', ['http://a/1.png', '', 'base64://xx'])
  assert.equal(segs[0].type, 'text')
  assert.equal(segs[0].data.text, '正文')
  assert.equal(segs.length, 3, '空串要被过滤掉')
  assert.equal(segs[1].type, 'image')
  assert.equal(segs[1].data.file, 'http://a/1.png')
})

// ============================================================================
// ③ 失败不静默（形状要分得开）
// ============================================================================

test('失败形状:超时 / 网络 / 非 JSON / 桥返回失败 / 未登录 —— 各是一个 reason', async () => {
  const timeout = make({}, () => ({ throw: 'The operation was aborted' }))
  assert.equal((await timeout.ch.call('get_login_info', {})).reason, 'timeout')

  const net = make({}, () => ({ throw: 'connect ECONNREFUSED' }))
  assert.equal((await net.ch.call('get_login_info', {})).reason, 'network')

  const notJson = make({}, () => ({ raw: '<html>502</html>' }))
  assert.equal((await notJson.ch.call('get_login_info', {})).reason, 'bad-json')

  const failed = make({}, () => ({ body: { status: 'failed', retcode: 1400, message: '参数错' } }))
  const f = await failed.ch.call('get_login_info', {})
  assert.equal(f.reason, 'bridge-failed')
  assert.equal(f.error, '参数错', '桥的 message 要原样带出来')

  const notLogin = make({}, () => ({ body: { status: 'failed', retcode: 1401, message: '未登录' } }))
  assert.equal((await notLogin.ch.call('get_login_info', {})).reason, 'not-logged-in', '1401 单列,好据此触发续期')

  const unauth = make({}, () => ({ status: 401, body: {} }))
  assert.equal((await unauth.ch.call('get_login_info', {})).reason, 'unauthorized')
})

test('成功与失败形状分得开:成功带 data,失败带 reason', async () => {
  const { ch } = make({}, () => ({ body: { status: 'ok', retcode: 0, data: { user_id: 1, nickname: 'Echo' } } }))
  const ok = await ch.call('get_login_info', {})
  assert.equal(ok.ok, true)
  assert.equal(ok.reason, undefined)
  assert.ok(ok.data)
})

test('带 token 时请求头有 Authorization;没 token 时没有', async () => {
  const withTok = make()
  await withTok.ch.call('get_login_info', {})
  assert.equal(withTok.fetchImpl.calls[0].headers.Authorization, 'Bearer tok')

  const noTok = make({ settings: { qzoneAccessToken: '' } })
  await noTok.ch.call('get_login_info', {})
  assert.equal('Authorization' in noTok.fetchImpl.calls[0].headers, false)
})

test('URL 拼对了:http://host:port/<action>', async () => {
  const { ch, fetchImpl } = make()
  await ch.call('get_login_info', {})
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:5700/get_login_info')
  assert.equal(fetchImpl.calls[0].method, 'POST')
})

// ============================================================================
// Cookie 拼串（宽容认形状 + 缺字段不灌）
// ============================================================================

const GOOD = 'uin=o123; p_uin=o123; skey=abc; p_skey=xyz'

test('拼 Cookie:已经是串 ⇒ 原样用', () => {
  assert.equal(buildCookieString(GOOD), GOOD)
})

test('拼 Cookie:认得出各种包装形状', () => {
  assert.equal(buildCookieString({ cookies: GOOD }), GOOD, '{cookies}')
  assert.equal(buildCookieString({ cookie: GOOD }), GOOD, '{cookie}')
  assert.equal(buildCookieString({ data: { cookies: GOOD } }), GOOD, '{data:{cookies}}')
  assert.equal(buildCookieString({ result: { data: { cookie: GOOD } } }), GOOD, '再深一层')
  assert.equal(
    buildCookieString([{ name: 'uin', value: 'o123' }, { name: 'p_uin', value: 'o123' },
      { name: 'skey', value: 'abc' }, { name: 'p_skey', value: 'xyz' }]),
    'uin=o123; p_uin=o123; skey=abc; p_skey=xyz', '数组 [{name,value}]')
  assert.equal(
    buildCookieString({ uin: 'o123', p_uin: 'o123', skey: 'abc', p_skey: 'xyz' }),
    'uin=o123; p_uin=o123; skey=abc; p_skey=xyz', '对象映射')
})

test('拼 Cookie:缺任一必需字段 ⇒ null（宁可不灌,也不弄坏现有登录态）', () => {
  assert.equal(buildCookieString('uin=o123; skey=abc; p_skey=xyz'), null, '缺 p_uin')
  assert.equal(buildCookieString('uin=o123; p_uin=o123; skey=abc'), null, '缺 p_skey')
  assert.equal(buildCookieString({ cookies: 'skey=abc' }), null)
  assert.equal(buildCookieString(''), null)
  assert.equal(buildCookieString(null), null)
  assert.equal(buildCookieString(undefined), null)
  assert.equal(buildCookieString(42), null)
  assert.equal(buildCookieString({ 奇怪: { 嵌套: 1 } }), null, '认不出的形状 ⇒ null')
})

test('cookieFieldOf / missingCookieFields', () => {
  assert.equal(cookieFieldOf(GOOD, 'skey'), 'abc')
  assert.equal(cookieFieldOf(GOOD, 'nope'), '')
  assert.equal(cookieFieldOf('uin=o1; p_uin=o1; skey=; p_skey=x', 'skey'), '', '空值算缺')
  assert.deepEqual(missingCookieFields(GOOD), [])
  assert.deepEqual(missingCookieFields('uin=o1'), ['p_uin', 'skey', 'p_skey'])
})

// ============================================================================
// Cookie 保活（要 + 复核 + 失败不抛）
// ============================================================================

test('续期:全链路成功（要 → 灌 → 复核）', async () => {
  const { ch, fetchImpl } = make(
    { getCookies: async () => ({ ok: true, data: { cookies: GOOD } }) },
    ({ url }) => {
      if (url.endsWith('/login_cookie')) return { body: { status: 'ok', retcode: 0, data: {} } }
      if (url.endsWith('/get_login_info')) return { body: { status: 'ok', retcode: 0, data: { user_id: 123, nickname: 'Echo' } } }
      return { body: { status: 'failed', retcode: 1400 } }
    })
  const r = await ch.refreshCookie()
  assert.equal(r.ok, true)
  assert.equal(r.nickname, 'Echo')
  const urls = fetchImpl.calls.map((c) => c.url)
  assert.deepEqual(urls, [
    'http://127.0.0.1:5700/login_cookie',
    'http://127.0.0.1:5700/get_login_info',
  ], '顺序:先灌,后复核')
  assert.equal(fetchImpl.calls[0].body.cookie, GOOD)
})

test('续期:壳没接 getCookies ⇒ no-get-cookies', async () => {
  const { ch } = make()
  const r = await ch.refreshCookie()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-get-cookies')
})

test('续期:NapCat 没给 ⇒ get-cookies-failed', async () => {
  const { ch, fetchImpl } = make({ getCookies: async () => ({ ok: false, error: 'no client connected' }) })
  const r = await ch.refreshCookie()
  assert.equal(r.reason, 'get-cookies-failed')
  assert.equal(fetchImpl.calls.length, 0, '没拿到就一个字都不发')
})

test('★ 续期:形状认不出 / 缺字段 ⇒ cookie-incomplete,且**不灌**', async () => {
  const bad1 = make({ getCookies: async () => ({ ok: true, data: { 什么鬼: 1 } }) })
  const r1 = await bad1.ch.refreshCookie()
  assert.equal(r1.reason, 'cookie-incomplete')
  assert.equal(bad1.fetchImpl.calls.length, 0, '★ 认不出就不灌 —— 免得把好的登录态弄坏')

  const bad2 = make({ getCookies: async () => ({ ok: true, data: { cookies: 'uin=o1; skey=x' } }) })
  const r2 = await bad2.ch.refreshCookie()
  assert.equal(r2.reason, 'cookie-incomplete')
  assert.ok(r2.error.includes('p_uin'), '要说清缺哪个字段')
  assert.equal(bad2.fetchImpl.calls.length, 0)
})

test('★ 续期:灌进去了但复核没过 ⇒ cookie-rejected（这条最该被人看见）', async () => {
  const { ch, fetchImpl } = make(
    { getCookies: async () => ({ ok: true, data: { cookies: GOOD } }) },
    ({ url }) => (url.endsWith('/login_cookie')
      ? { body: { status: 'ok', retcode: 0, data: {} } }
      : { body: { status: 'failed', retcode: 1401, message: '未登录' } }))
  const r = await ch.refreshCookie()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'cookie-rejected')
  assert.ok(r.error.includes('手工'), '要给人一条出路')
  assert.equal(fetchImpl.calls.length, 2, '灌 + 复核都发生过')
})

test('续期:桥拒收 ⇒ login-cookie-failed', async () => {
  const { ch } = make(
    { getCookies: async () => ({ ok: true, data: { cookies: GOOD } }) },
    () => ({ body: { status: 'failed', retcode: 1400, message: '缺少 cookie' } }))
  const r = await ch.refreshCookie()
  assert.equal(r.reason, 'login-cookie-failed')
})

test('续期:getCookies 抛错 ⇒ 兜住,不冒泡', async () => {
  const { ch } = make({ getCookies: async () => { throw new Error('炸了') } })
  const r = await ch.refreshCookie()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'get-cookies-failed')
})

test('保活:start 会立刻续一次,stop 之后不再续', async () => {
  let timers = 0
  const captured = []
  const fakeSet = (fn, ms) => {
    timers += 1
    captured.push({ fn, ms })
    return { unref() {}, id: timers }
  }
  const fakeClear = () => {}
  let refreshed = 0
  const { ch } = make({
    getCookies: async () => { refreshed += 1; return { ok: true, data: { cookies: GOOD } } },
    setTimer: fakeSet,
    clearTimer: fakeClear,
  }, ({ url }) => (url.endsWith('/login_cookie')
    ? { body: { status: 'ok', retcode: 0, data: {} } }
    : { body: { status: 'ok', retcode: 0, data: { nickname: 'Echo' } } }))

  const s = ch.start()
  assert.equal(s.ok, true)
  assert.equal(timers, 1, '起了一个定时器')
  assert.equal(captured[0].ms, 10 * 60 * 1000, '间隔 = 10 分钟')

  ch.stop()
  assert.equal(ch.status().keeperRunning, false)
})

test('保活:没接 getCookies ⇒ 不起（明说一句,不静默）', () => {
  const { ch, logs } = make()
  const r = ch.start()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-get-cookies')
  assert.ok(logs.some((m) => m.includes('getCookies')), '要留一句话,别让人以为保活在跑')
})

test('保活:总闸关 ⇒ 不起', () => {
  const { ch } = make({ settings: { qzoneEnabled: false } })
  assert.equal(ch.start().reason, 'disabled')
})

test('status 形状:给面板看的那些格都在', () => {
  const { ch } = make()
  const st = ch.status()
  assert.equal(st.enabled, true)
  assert.equal(st.baseUrl, 'http://127.0.0.1:5700')
  assert.equal(st.hasToken, true)
  assert.equal(st.defaultUgcRight, 1)
  assert.equal(st.refreshMin, 10)
  assert.equal(st.keeperRunning, false)
  assert.equal(st.canAutoRefresh, false, '没注入 getCookies ⇒ 不能自动续')
  assert.equal(st.refreshOk, 0)
  assert.equal(st.refreshFail, 0)
})

test('配置现读:改完 settings,下一轮 action 就用新值（不是快照）', async () => {
  const live = { ...ON }
  const fetchImpl = fakeFetch()
  const ch = createQzoneChannel({ settings: live, log: () => {}, fetchImpl })
  await ch.call('get_login_info', {})
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:5700/get_login_info')
  live.qzonePort = 5800
  await ch.call('get_login_info', {})
  assert.equal(fetchImpl.calls[1].url, 'http://127.0.0.1:5800/get_login_info', '★ 活视图:不是快照')
})

// ============================================================================
// ★ 接线守卫（2026-10-15 真机抓到的 bug）
//
// 那一版单测**全部注入假 getCookies** —— 于是"真实接线"没人测：
// `lib/index.js` 里那根内联的 `onebot.call('get_cookies', {})` **漏了 `domain`**，
// 真机回 `1400 Schema compilation error: Expected required property`，保活一次都没成。
// 三绿过了、真机挂 —— 教训记在这里。
//
// 修法：把那根接线抽成 `makeGetCookies()`（可注入假 onebot 桩，直接断言"真的传了什么"），
// 并在此钉住。**不是"修那一行"，是"钉住那根接线"。**
// ============================================================================

test('★ 接线:getCookies 必须带 domain="qzone.qq.com"（漏了真机回 1400）', async () => {
  const seen = []
  const fakeOnebot = {
    call: (action, params) => {
      seen.push({ action, params })
      return Promise.resolve({ ok: true, data: { cookies: 'uin=o1; p_uin=o1; skey=a; p_skey=b' } })
    }
  }
  const getCookies = makeGetCookies(() => fakeOnebot)
  const r = await getCookies()

  assert.equal(r.ok, true)
  assert.equal(seen.length, 1, '只该发一次')
  assert.equal(seen[0].action, 'get_cookies', '第一个参数必须是 get_cookies')
  assert.ok(seen[0].params && typeof seen[0].params === 'object', '第二个参数要是个对象')
  assert.equal(seen[0].params.domain, 'qzone.qq.com', '★ domain 必填,且必须是 QZone 那个域')
  assert.equal(QZONE_COOKIE_DOMAIN, 'qzone.qq.com', '常量本身也要钉住')
})

test('接线:onebot 还没起来 ⇒ 明确失败(不抛,让保活只 warn)', async () => {
  for (const stub of [() => null, () => undefined, () => ({}), null]) {
    const r = await makeGetCookies(stub)()
    assert.equal(r.ok, false)
    assert.ok(String(r.error).includes('onebot'), '要说清是 onebot 没起来:' + r.error)
  }
})

test('接线:onebotOf 抛错 ⇒ 兜住,不冒泡', async () => {
  const r = await makeGetCookies(() => { throw new Error('炸了') })()
  assert.equal(r.ok, false)
})

test('接线:壳里必须用 makeGetCookies（不是自己内联一份）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /import \{[^}]*makeGetCookies[^}]*\} from '\.\/qzone\.js'/, '要从 qzone.js 取 makeGetCookies')
  assert.match(src, /getCookies:\s*makeGetCookies\(/, 'createQzoneChannel 的 getCookies 用它')
  // 反面：别再出现"手搓一个 get_cookies 调用"（那就是这次漏 domain 的形状）
  const inline = src.match(/onebot\.call\(\s*'get_cookies'/g) || []
  assert.equal(inline.length, 0, '壳里不该再有内联的 get_cookies 调用（会漏 domain）—— 走 makeGetCookies')
})

test('接线:抽出来的这根线真的能走完续期（接上 createQzoneChannel）', async () => {
  const fetchImpl = fakeFetch(({ url }) => (url.endsWith('/login_cookie')
    ? { body: { status: 'ok', retcode: 0, data: {} } }
    : { body: { status: 'ok', retcode: 0, data: { nickname: 'Echo' } } }))
  const fakeOnebot = {
    call: () => Promise.resolve({
      ok: true,
      data: { cookies: 'uin=o1; p_uin=o1; skey=a; p_skey=b' }
    })
  }
  const ch = createQzoneChannel({
    settings: { ...ON },
    log: () => {},
    fetchImpl,
    getCookies: makeGetCookies(() => fakeOnebot)
  })
  const r = await ch.refreshCookie()
  assert.equal(r.ok, true, '整条链要能走通:' + JSON.stringify(r))
  assert.equal(r.nickname, 'Echo')
})