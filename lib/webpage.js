/**
 * 自带那一页的静态伺服(前缀路由 `/echo-qq`)。
 *
 * 与主包同款形状(`dsh-echo/lib/webpage.js`),但**公式只此一处**,不重复主包当年那个错:
 * 主包曾把 web 根算成 `lib/web`(应为包根的 `web/`),装机副本里根本不存在,
 * `/echo/` 404 了半个月才被发现。这里的 `webRootOf` 就写一遍,并由单测盯着。
 *
 * 两条纪律:
 *   ① **每请求现读文件** + `cache-control: no-store` —— 改完页面刷新即见效(不用重启 dsh web);
 *   ② **不许穿出 rootDir** —— 前缀剥掉后做规范化,任何 `..` 一律 404。
 */
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根的 `web/`(lib 的上一级)。**唯一真源**,别在别处再算一遍。 */
export function webRootOf (importMetaUrl) {
  return join(dirname(fileURLToPath(importMetaUrl)), '..', 'web')
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

export function mimeOf (path) {
  const i = String(path).lastIndexOf('.')
  if (i < 0) return 'application/octet-stream'
  return MIME[String(path).slice(i).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 前缀剥离 + 防穿越。返回 rootDir 内的**相对路径**(目录 → index.html),非法 → null。
 */
export function safeRelPath (urlPath, prefix = '/echo-qq') {
  let p = String(urlPath ?? '')
  const q = p.indexOf('?')
  if (q >= 0) p = p.slice(0, q)
  const h = p.indexOf('#')
  if (h >= 0) p = p.slice(0, h)
  if (!p.startsWith(prefix)) return null
  let rest = p.slice(prefix.length)
  if (rest.startsWith('/')) rest = rest.slice(1)
  if (rest === '') rest = 'index.html'
  if (rest.endsWith('/')) rest += 'index.html'
  // normalize 之后仍在 rootDir 内才算合法:../ 与绝对路径都在这里被挡下
  const rel = normalize(rest)
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep) || /^[a-zA-Z]:/.test(rel)) return null
  return rel.split(sep).join('/')
}

/**
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createWebPageHandler ({ rootDir, prefix = '/echo-qq' } = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') throw new Error('createWebPageHandler: rootDir 必填')
  return function handler (req, res) {
    const rel = safeRelPath(req?.url ?? '', prefix)
    if (rel === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const abs = join(rootDir, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    readFile(abs).then((buf) => {
      res.writeHead(200, {
        'content-type': mimeOf(abs),
        'cache-control': 'no-store',
        'content-length': String(buf.length)
      })
      res.end(buf)
    }).catch((err) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('read failed: ' + String(err?.message ?? err))
    })
  }
}
