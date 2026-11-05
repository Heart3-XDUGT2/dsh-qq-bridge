/**
 * 打包纪律电池:**源码里不许写死地址 / 端口 / 本机路径**。
 *
 * 为什么要一条测试来管这件事:打包出去以后,别人的 `dsh web` 跑在哪个端口、
 * 插件源码放在哪个目录,都不是我们说了算。靠自觉迟早会漏,所以让门卫来管。
 *
 * 允许清单只有两处,理由都写在明面上:
 *   - `config.js`:默认值集中地(监听默认 loopback + 监听端口)。**2026-09-28 起它不再需要
 *     "现推主包地址"那一行** —— 主包地址随旧桥(HTTP 兜底)退役,唯一的路 = 服务注入,不需要地址;
 *   - `onebot.js`:借来的文件,自带默认监听地址(出处见 `THIRD_PARTY.md`),
 *     并用**运行时**的 host/port 拼监听地址(`ws://${host}:${port}`,地址来自参数)。
 *
 * 关于"回环字面量只许出现在 config.js"这条约定,顺便核对了一遍(2026-09-28):
 *   **它仍然成立,但没有更严的空间** —— `config.js` 的 `host: '127.0.0.1'` 是**监听位默认值**,
 *   跟旧桥那条路无关,退役后照样要留;借来的 `onebot.js` 也自带一个 `127.0.0.1` 默认值。
 *   所以还不能把口径收紧成"全仓不许出现回环字面量"(那会红在借来的文件与监听默认值上),
 *   两处允许清单继续保留。
 *
 * URL 形态的允许清单**收紧了**:`config.js` 不再有任何绝对 URL(那条"现推 127.0.0.1:port"没了),
 * 所以现在只有借来的 `onebot.js` 被放行。
 *
 * 规则只认**地址形态**,不认"冒号后跟数字" —— 头一版就栽在这上面:
 * `pollMs: 2000`、`heartbeatMs: 30000` 是配置默认值,CSS 里的 `:20px` 是样式,
 * 它们都不是写死的地址。误报会让门卫被绕过(或者被删掉),所以宁可窄一点。
 * 同一版还栽在"盘符"上:`[A-Za-z]:[\\/]` 会把 **URL 的 `http:/`** 也算成 `p:/`,
 * 现在要求盘符前面不能是字母数字(`(^|[^A-Za-z0-9])`),两边的元测试都钉住了。
 *
 * 注释先被剥掉再扫:注释里写 `~/.dsh/echo-qq` 是文档,不是硬编码。
 * 文档(`README.md` / `CHANGELOG.md`)不进扫描 —— 它们本来就要**解释**这条规则,
 * 会正当地提到那个端口号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')
const WEB = join(ROOT, 'web')
const SCRIPTS = join(ROOT, 'scripts')

/**
 * 这几个文件允许出现 loopback / 具体 IP 与监听端口字面量(理由见文件头)。
 *
 * ★ 2026-10-20：**`bridge-supervisor.js` 加进来** —— 它要做"启动前探端口"的自愈：
 *   `net.connect` 和 `http.request` 都得有个 host。那个 host 现在**从桥的
 *   `dir/.env` 的 `ONEBOT_HOST` 读**（读不到才用 `127.0.0.1` 兜底，与桥自己的
 *   `.env.example` 一致）。探的是一个**本机进程**，天然只在回环上，没有
 *   "对外地址"可言 —— 所以这里放行的是"允许出现回环字面量当默认值"。
 */
const LOOPBACK_OK = new Set(['config.js', 'onebot.js', 'bridge-supervisor.js'])
const LISTEN_PORT_OK = new Set(['config.js', 'onebot.js'])
/**
 * URL 形态白名单:**用运行时 host/port 拼出地址**的那两个文件。
 *
 * `onebot.js` 拼的是**监听**地址(反向 WS 服务端);
 * `qzone.js` 拼的是**出站**地址(`http://<qzoneHost>:<qzonePort>/<action>`,发给
 * onebot-qzone 桥)。两者都是"地址来自配置、运行时才成形",没有可硬编码的常量 ——
 * 所以放行的是"允许出现 `http://` 这个形态",不是"允许写死某个地址":
 * 主机名与端口一律取自 `config.js` 的 `DEFAULT_SETTINGS`,那两个字面量仍受
 * `LOOPBACK_OK` / `LISTEN_PORT_OK` 约束(`qzone.js` **不在**那两张表里)。
 *
 * ★ 2026-10-19:`qzone-events.js` 是同一种情况 —— 它拼的是**连桥评论事件流**的地址
 *   (`ws://<qzoneHost>:<qzonePort>/event?access_token=…`),主机/端口/令牌**全部**来自配置,
 *   函数里连默认值都没留(缺 host/port 直接返回空串)。所以放行的只是 `ws://` 这个形态。
 */
const URL_SCHEME_OK = new Set(['onebot.js', 'qzone.js', 'qzone-events.js'])

function stripComments (src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * 纯函数:一个文件里有哪些硬编码违规。
 * @param {string} name 文件名(决定它是否在允许清单里)
 * @param {string} raw  原文
 * @returns {string[]} 违规说明(空数组 = 干净)
 */
function violationsOf (name, raw) {
  const src = stripComments(raw)
  const out = []
  const ipv4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/
  if (!LOOPBACK_OK.has(name) && (ipv4.test(src) || /localhost/i.test(src))) out.push('loopback/具体 IP 字面量')
  if (!LISTEN_PORT_OK.has(name) && /\b6700\b/.test(src)) out.push('监听端口字面量')
  if (/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(src)) out.push('绝对路径(盘符)')
  if (/\/Users\/|\/home\//.test(src)) out.push('绝对路径(家目录)')
  if (/\b3080\b/.test(src)) out.push('主包端口 3080:必须现推,不许写死')
  if (!URL_SCHEME_OK.has(name) && /(?:https?|wss?):\/\//.test(src)) out.push('绝对 URL')
  return out
}

const libFiles = () => readdirSync(LIB).filter((f) => f.endsWith('.js'))
const webFiles = () => readdirSync(WEB).filter((f) => /\.(js|html)$/.test(f))
const readLib = (f) => readFileSync(join(LIB, f), 'utf8')
const readWeb = (f) => readFileSync(join(WEB, f), 'utf8')

test('① lib/*.js 全部干净(除允许清单里那两处的默认值)', () => {
  const files = libFiles()
  assert.ok(files.length >= 5, 'lib 里应该有一把文件,别扫空了')
  const bad = []
  for (const f of files) {
    const v = violationsOf(f, readLib(f))
    if (v.length > 0) bad.push(f + ' → ' + v.join('、'))
  }
  assert.deepEqual(bad, [], '硬编码违规:\n' + bad.join('\n'))
})

test('② web/ 也干净(页面里同样不许出现地址 / 具体 IP / 本机路径)', () => {
  const bad = []
  for (const f of webFiles()) {
    const v = violationsOf('web/' + f, readWeb(f))
    if (v.length > 0) bad.push(f + ' → ' + v.join('、'))
  }
  assert.deepEqual(bad, [], '硬编码违规:\n' + bad.join('\n'))
})

test('③ 代码里不许出现主包端口(它是"现推"而不是"约定")', () => {
  const hits = []
  for (const f of libFiles()) if (/\b3080\b/.test(stripComments(readLib(f)))) hits.push('lib/' + f)
  for (const f of webFiles()) if (/\b3080\b/.test(stripComments(readWeb(f)))) hits.push('web/' + f)
  if (/\b3080\b/.test(readFileSync(join(ROOT, 'package.json'), 'utf8'))) hits.push('package.json')
  assert.deepEqual(hits, [], '这些文件里还写着主包端口:' + hits.join('、'))
  // 文档不进扫描(见文件头):README / CHANGELOG 要解释这条规则,会正当提到那个端口号
})

test('④ 监听端口只允许出现在"默认值集中地"与借来的文件里', () => {
  const hits = []
  for (const f of libFiles()) {
    if (LISTEN_PORT_OK.has(f)) continue
    if (/\b6700\b/.test(stripComments(readLib(f)))) hits.push(f)
  }
  assert.deepEqual(hits, [], '这些文件里写死了监听端口:' + hits.join('、'))
})

test('⑤ 门卫自己得管用(元测试:喂它硬编码必须报出来,喂它配置默认值不许误报)', () => {
  // 报得出来
  assert.deepEqual(violationsOf('contract.js', "const u = 'http://127.0.0.1:3080/x'").sort(),
    ['主包端口 3080:必须现推,不许写死', 'loopback/具体 IP 字面量', '绝对 URL'].sort())
  assert.deepEqual(violationsOf('random.js', "const p = 'C:\\\\Users\\\\me\\\\.dsh'"), ['绝对路径(盘符)'])
  assert.deepEqual(violationsOf('random.js', "const p = '/home/me/.dsh/echo-qq'"), ['绝对路径(家目录)'])
  assert.deepEqual(violationsOf('random.js', "const s = 'ws://localhost:9000'").sort(),
    ['loopback/具体 IP 字面量', '绝对 URL'].sort())
  assert.deepEqual(violationsOf('random.js', 'const host = "127.0.0.1"'), ['loopback/具体 IP 字面量'])
  assert.deepEqual(violationsOf('random.js', 'const port = 6700'), ['监听端口字面量'])
  // 不许误报(头一版就栽在这儿)
  assert.deepEqual(violationsOf('random.js', 'const pollMs = 2000'), [], '配置默认值不是地址')
  assert.deepEqual(violationsOf('random.js', 'grid-template-columns:minmax(240px, 1fr)'), [], 'CSS 不是地址')
  assert.deepEqual(violationsOf('random.js', "const t = 'HTTP ' + res.status"), [])
  // 注释不算违规(文档里写路径是允许的)
  assert.deepEqual(violationsOf('random.js', '// 数据在 ~/.dsh/echo-qq/ 与 C:\\Users\\me\nconst x = 1'), [])
  // 允许清单生效:借来的文件里那个"用运行时 host/port 拼出来的监听地址"必须放行
  assert.deepEqual(violationsOf('onebot.js', "const url = 'ws://' + host + ':' + port"), [])
})

/**
 * ⑥ 反悔钉子(2026-09-28):旧桥的 HTTP 兜底随"旧桥完整退役"被拆掉了 ——
 * 它打的那些主包端点已经不存在、那条路永远不可能成功,留着只会骗人。
 * 这条钉子钉死它:源码里再出现旧桥那条路的端点路径、或把 mainToken 当凭证用,就红。
 *
 * 唯一例外是 `lib/config.js`:它必须**认出**这两个退役的键(mainBaseUrl / mainToken),
 * 才能把"已退役、不再读取"写进 `problems`(只识别与提示,不读、不用)。
 * 它只在 `mainToken` 这一项上豁免;端点路径、Bearer 鉴权写法照旧全仓不许出现。
 *
 * 唯一例外是 `lib/onebot.js` 的 Bearer:那是 **NapCat→插件** 的 OneBot 11
 * 反向 WS 握手鉴权(`Authorization: Bearer <accessToken>`,凭证是本插件自己的
 * `accessToken`)—— 方向与旧桥正好相反(旧桥是 插件→主包,凭证 `mainToken`,
 * 打 `/api/echo/relay/*`)。
 *
 * ⚠️ 2026-09-28 收窄(他要求,也是我留的宽口子):上一版这里是**文件级豁免**
 * (`name !== 'lib/onebot.js'`),等于"这个文件以后随便写 Bearer" —— 一个文件整段放行,
 * 谁往里加一行旧桥鉴权都没人管。现在改成**行级 + 理由必填**:
 *   ① 只有**带 `// pin-allow: <理由>` 的同一行**才豁免(理由至少 2 个字符);
 *   ② 空理由、只写个冒号,**不算豁免**(下面 ⑦ 有元测试证明它真不算);
 *   ③ 判定看的是**代码行**(注释先剥掉,但**保留行号**)—— 文件头那段解释 Bearer 的
 *      注释不该被当成违规,而 `extractBearer(...)` 这种**函数名**也不算(只认
 *      `authorization` 与后面带空格的 `Bearer `,即真正的 HTTP 头形态)。
 * 这条口径是照 Cortico 的白名单纪律写的:**豁免要带理由,而且要自带自测**
 * (`architecture.test.ts:85-90,212-227`)。
 */
const sourceFiles = () => {
  const out = []
  for (const f of readdirSync(LIB)) if (f.endsWith('.js')) out.push(['lib/' + f, readFileSync(join(LIB, f), 'utf8')])
  for (const f of readdirSync(WEB)) if (/\.(js|html)$/.test(f)) out.push(['web/' + f, readFileSync(join(WEB, f), 'utf8')])
  for (const f of readdirSync(SCRIPTS)) if (f.endsWith('.mjs')) out.push(['scripts/' + f, readFileSync(join(SCRIPTS, f), 'utf8')])
  return out
}

/**
 * 注释剥掉、**但保留行号**(块注释换成等量空白)—— 行级判定要用原行号读 `pin-allow` 标记。
 * @param {string} src
 */
function stripCommentsKeepLines (src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 这一行的豁免成立吗?**必须带理由**:`// pin-allow: 为什么`(理由 ≥2 字符)。
 * 空理由、只写一个冒号 —— 一律不算。
 * @param {string} line
 */
function allowsLine (line) {
  const m = /pin-allow:\s*(\S.*)$/.exec(String(line))
  return m !== null && m[1].trim().length >= 2
}

test('⑥ 反悔钉子:旧桥那条 HTTP 兜底不许被加回来(端点路径 / mainToken / Bearer)', () => {
  const bad = []
  const files = sourceFiles()
  assert.ok(files.length >= 9, '源码文件该有一把,别扫空了')
  for (const [name, raw] of files) {
    const src = stripComments(raw)
    if (src.includes('/api/echo/relay/')) bad.push(name + ' → 又出现了旧桥的 relay 端点路径')
    if (/\bmainToken\b/.test(src) && name !== 'lib/config.js') {
      bad.push(name + ' → 又把 mainToken 当配置读了(它已随旧桥退役)')
    }
    // Bearer/authorization:**逐行**判,豁免必须同行带理由(见文件头 2026-09-28 那条)
    const rawLines = String(raw).split(/\r?\n/)
    const codeLines = stripCommentsKeepLines(raw).split(/\r?\n/)
    for (let i = 0; i < codeLines.length; i++) {
      if (!/authorization|Bearer\s/i.test(codeLines[i])) continue
      if (allowsLine(rawLines[i] ?? '')) continue
      bad.push(name + ':' + (i + 1) + ' → 又出现了 Bearer/authorization(旧桥的 HTTP 鉴权写法;'
        + '确实要留就同行写 "// pin-allow: 理由")')
    }
  }
  assert.deepEqual(bad, [], '旧桥那条路不许回来:\n' + bad.join('\n'))
})

/**
 * ⑦ 豁免纪律的元测试:**空理由不算豁免**。
 * 为什么必须有这条:豁免是门卫身上唯一的洞 —— 洞上不装自测,它就会慢慢变大
 * (上一版就是整文件放行)。Cortico 的白名单自带自测,我们照抄这个口径。
 */
test('⑦ 豁免必须带理由(空理由 / 只有冒号 = 不算),且注释与函数名不算违规', () => {
  // 带理由 ⇒ 豁免
  assert.equal(allowsLine('const h = r.headers.authorization; // pin-allow: NapCat 握手鉴权'), true)
  assert.equal(allowsLine("if (h.startsWith('Bearer ')) return h; // pin-allow: OneBot 11 反向 WS"), true)
  // 空理由 / 只有冒号 / 只有空格 ⇒ **不算豁免**
  assert.equal(allowsLine('const h = r.headers.authorization; // pin-allow:'), false, '空理由不许算豁免')
  assert.equal(allowsLine('const h = r.headers.authorization; // pin-allow:   '), false, '只有空格也不许算')
  assert.equal(allowsLine('const h = r.headers.authorization;'), false, '没有标记当然不算')
  assert.equal(allowsLine('const h = r.headers.authorization; // pin-allow: x'), false, '一个字符的理由太糊弄')
  // 注释先剥掉再判:文件头解释 Bearer 的注释不该被算成违规
  const doc = '/**\n * 鉴权:保留 Authorization: Bearer <token>\n */\nconst x = 1\n'
  assert.equal(/authorization|Bearer\s/i.test(stripCommentsKeepLines(doc).split('\n')[1]), false, '块注释里的解释不算违规')
  // 但函数名不算"HTTP 头形态"(否则 extractBearer 会被误伤)
  assert.equal(/authorization|Bearer\s/i.test('const t = extractBearer(request)'), false, '函数名不是鉴权头')
  // 行号保留:剥注释不能改变行数(否则报错的行号会骗人)
  assert.equal(stripCommentsKeepLines(doc).split('\n').length, doc.split('\n').length)
})
