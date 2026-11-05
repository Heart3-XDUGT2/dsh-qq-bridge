import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWebPageHandler, mimeOf, safeRelPath, webRootOf } from '../lib/webpage.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = webRootOf(new URL('../lib/webpage.js', import.meta.url).href)

function fakeRes () {
  const res = { status: 0, headers: null, body: null, done: false }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body = body; res.done = true }
  return res
}

async function callHandler (handler, url) {
  const res = fakeRes()
  handler({ url, method: 'GET' }, res)
  for (let i = 0; i < 200 && !res.done; i += 1) await new Promise((r) => setTimeout(r, 5))
  assert.equal(res.done, true, 'handler 没能在 1 秒内响应:' + url)
  return res
}

test('webRootOf 指向包根的 web/ —— 不是主包当年那个 lib/web(那个 404 了半个月)', () => {
  assert.equal(WEB.endsWith('web'), true)
  assert.equal(existsSync(join(WEB, 'index.html')), true)
  assert.equal(existsSync(join(WEB, 'app.js')), true)
  // 反证:主包当年的错误公式
  assert.equal(existsSync(join(dirname(WEB), 'lib', 'web')), false)
})

test('safeRelPath:目录落到 index.html;.. 与绝对路径一律 null', () => {
  assert.equal(safeRelPath('/echo-qq/', '/echo-qq'), 'index.html')
  assert.equal(safeRelPath('/echo-qq', '/echo-qq'), 'index.html')
  assert.equal(safeRelPath('/echo-qq/app.js?x=1', '/echo-qq'), 'app.js')
  assert.equal(safeRelPath('/echo-qq/sub/page.html', '/echo-qq'), 'sub/page.html')
  assert.equal(safeRelPath('/echo-qq/../../etc/passwd', '/echo-qq'), null)
  assert.equal(safeRelPath('/echo-qq/..%2f..%2fsecret', '/echo-qq'), null)
  assert.equal(safeRelPath('/other/index.html', '/echo-qq'), null)
})

test('mimeOf:认得出常见类型,认不出给 octet-stream', () => {
  assert.equal(mimeOf('a.html').startsWith('text/html'), true)
  assert.equal(mimeOf('a.js').startsWith('text/javascript'), true)
  assert.equal(mimeOf('a.css').startsWith('text/css'), true)
  assert.equal(mimeOf('a.bin'), 'application/octet-stream')
})

test('handler:出页 200 + no-store;缺文件 404;穿越 404', async () => {
  const handler = createWebPageHandler({ rootDir: WEB, prefix: '/echo-qq' })

  const ok = await callHandler(handler, '/echo-qq/')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['cache-control'], 'no-store')
  assert.equal(String(ok.body).includes('Echo · QQ 渠道'), true)

  const js = await callHandler(handler, '/echo-qq/app.js')
  assert.equal(js.status, 200)
  assert.equal(js.headers['cache-control'], 'no-store')
  // app.js 里那一行就是本页与状态接口的契约
  assert.ok(String(js.body).includes('/api/echo-qq/status'))

  const missing = await callHandler(handler, '/echo-qq/nope.html')
  assert.equal(missing.status, 404)

  const escape = await callHandler(handler, '/echo-qq/../../package.json')
  assert.equal(escape.status, 404)
})

test('handler 构造时必须有 rootDir(静默错算根目录,才是当年那个坑)', () => {
  assert.throws(() => createWebPageHandler({}), /rootDir 必填/)
})

test('web/index.html 不带外部依赖(这一页只回答"通不通",不引库)', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8')
  assert.equal(/<script[^>]+src=["']https?:/.test(html), false)
  assert.equal(/<link[^>]+href=["']https?:/.test(html), false)
})
