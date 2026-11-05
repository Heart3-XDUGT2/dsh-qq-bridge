# dsh-echo-qq 交接文档

> 写给接手的人(或下一个我)。路径 / 命令都是**从代码里查实的**。
> 最后核对时间:2026-09-29。

---

## 一、这是什么、和另一个包的关系、当前版本

**`dsh-echo-qq` 是「嘴」**:Echo 的 QQ(OneBot 11 / NapCat)渠道插件。
只负责**私聊收发、送达回执、心跳、一页自己的诊断页**。

**`dsh-echo` 是「脑」**(另一个独立仓库:`~/.dsh/plugins/dsh-echo`):
人格 / 记忆 / 气泡 / 节奏 / 打断 / 想念 / 工具族 / 面板 —— **她要不要说、说什么、分几泡、
什么时候说,全在主包**;这里只负责"把他的话递进去、把她的话发出去、发到了回执"。
为什么拆、拆到哪一步、哪些功能一个都不能丢:主包仓库的 `docs/QQ_BRIDGE_DIY_PLAN.md`。

**两个包怎么接上**:主包 `lib/index.js` 里 `ctx.provide('echo:relay', {…})`(`SERVICE_NAME`
见主包 `lib/speak.js`);本插件用 **`ctx.get('echo:relay')` 能力探测**(不是 `export const
inject = ['echo:relay']` —— 那语义是"等服务出现才激活",主包不提供就**永远不激活**)。
契约字段以 `lib/contract.js` 顶部那份为准;跨仓各钉一条测试。

> **唯一的路 = 服务注入**。旧的 HTTP 轮询兜底已随"旧桥完整退役"于 **2026-09-28 拆除**
> (主包那几条路由已不存在,`lib/contract.js` 文件头有说明)。服务不在 ⇒ 如实报 `none`,
> **不悄悄回落**(否则"零轮询那条路真通了"没法证明)。

| | 值 |
|---|---|
| 包名 | `dsh-echo-qq`(`private: true`) |
| **当前版本** | **`0.1.6`**(`package.json` ↔ `CHANGELOG.md` 顶部一致) |
| 仓库位置 | `~/.dsh/plugins/dsh-echo-qq`(独立 git 仓库,**没有 remote**;不许擅自 push) |
| 入口 | `main: lib/index.js`;导出 `./contract` `./envelope` `./onebot` |
| 唯一真依赖 | **`ws` ^8.18.0**(必须真的被装,否则本插件起不来;宿主包一律 `ctx.get`) |
| 页面 | `/echo-qq/`;状态 JSON `/api/echo-qq/status` |

---

## 二、前置条件

| 依赖 | 要求 | 依据 |
|---|---|---|
| **Node.js** | **≥ 22.5**(与主包同款下限) | `package.json` 的 `engines`。本包自身不碰 `node:sqlite`,但宿主 DSH 与 `node --test` 这套工具链要新 Node |
| **`ws`** | 装得上就行(`npm install` / 宿主装 tgz 时自动装) | `dependencies`;这是唯一的真依赖 |
| **NapCat / OneBot 11** | 一个能发**反向 WebSocket** 的 OneBot 11 实现 | `lib/onebot.js` 是**反向 WS**:它连我们,我们不连它;连接的地址就是配置里的 `host` / `port` |
| **QQ 小号 + 端口** | 真机验收要一个 QQ 号与一个空闲端口 | `docs/REAL_MACHINE.md`;历史现场:6199 曾被 AstrBot 占着(**一个端口只能有一个听众**) |
| 本机实测环境 | Node **v24.21.0** | 本次交接现场 `node -v` |

> **它不 import 任何宿主包**(一律 `ctx.get('webServer')` 等),所以没有主包那条
> "链接装机解析不到 `@deepseek-ai/*`" 的雷。**但它要能解析到 `ws`** —— link 装机时 Node 会先把
> junction 解析成真实路径,解析起点落在**源码区**(见九-3)。

---

## 三、安装

### A. link 装机(本机现形态)

```powershell
cd $env:USERPROFILE\.dsh\plugins\dsh-echo-qq
npm install                        # 只为 ws
node scripts\install.mjs           # link 装机(junction → 源码区)+ 登记三件套
node scripts\install.mjs --check   # 只校验(重启前先跑这条)
node scripts\install.mjs --doctor  # 认三种半死(见下)
node scripts\install.mjs --remove  # 卸载
node scripts\install.mjs --profile qqtest   # 换 profile(默认 web)
```

**「三件套」缺一件就是半死**:

1. `profiles/<profile>/node_modules/dsh-echo-qq` —— junction 指向源码区(link 装机);
2. `profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里有 `"dsh-echo-qq"`;
3. 同一份 `package.json` 的 `dependencies["dsh-echo-qq"] = "link:<源码区>"`。

- 只有 ②、装机位不在 ⇒ loader 抛 `cannot resolve profile bundle "dsh-echo-qq"` ⇒
  **整个 `dsh web` 起不来**;
- 只有装机位、没登记 ② ⇒ 宿主起得来,但**这条嘴不会被挂载**(最难查的半死)。

### B. tarball 装机(发给别人 / 换机器)

```powershell
cd $env:USERPROFILE\.dsh\plugins\dsh-echo-qq
npm pack                                    # ⇒ dsh-echo-qq-0.1.6.tgz
dsh plugin --profile web add "$env:USERPROFILE\.dsh\plugins\dsh-echo-qq\dsh-echo-qq-0.1.6.tgz"
dsh --profile web --dump-config             # 两处登记都在、零错误才算装对
```

> ⚠️ **别用裸名装**:`dsh plugin add dsh-echo-qq` / `dsh plugin add dsh-echo` 装的是 **npm 上的
> 同名包** —— `dsh-echo` 那个是 **`dsh-echo@0.0.1` 占位包**,没有 `dsh.bundle`,CLI 只会警告
> 「declares no dsh.bundle — installed as a plain dependency」。要用 **tgz 的绝对路径**。

`ws` 不进 tgz,`add` 时会从 registry 装;离网机器要先 `npm install`(或用 link 装机那条)。

### 开发循环

改源码 → **重启 `dsh web`**(link 装机不用重跑脚本;`web/` 是每请求现读,刷新页面就够)。

---

## 四、配置

**数据目录**:`~/.dsh/echo-qq/`(`DSH_HOME` 可改;`lib/config.js` 的 `dataDirOf()`)。
**源码在 `~/.dsh/plugins/dsh-echo-qq/`** —— 两个地方别混。
配置 = `~/.dsh/echo-qq/config.json`(**现读**,改完不用重启;`readSettings()`)。

**直接抄样板**:同目录的 **`config.example.json`**(字段与 `lib/config.js` 的 `DEFAULT_SETTINGS`
一一对应,字段范围也照 `parseSettings()` 的 `asInt` 上下限)。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | **总闸。装上了 ≠ 开了**;关着就只挂页面,连反向 WS 都不监听 |
| `host` / `port` | `127.0.0.1` / `6700` | 反向 WS 监听位(NapCat 连这里;`host` 填 `0.0.0.0` 才收外部连接) |
| `accessToken` | `""` | **空 = 拒收一切连接**;比较用**恒定时间** |
| `allowedUsers` | `[]` | 私聊白名单(QQ 号字符串)。**空 = 一律拒收**,绝不"空即全通" |
| `replyMaxChars` | `500` | 单条出站上限(1..4000;超出**分段发**,不是截断,见 `lib/split.js`) |
| `heartbeatMs` / `maxMisses` | `30000` / `3` | 心跳与容忍次数(5000..600000 / 1..20);超了只标 `stale`,**不销毁状态** |
| `segmentGapMs` | `500` | 分段间隔(0..10000;躲 QQ 侧发送频率限制) |
| `inboundRetryTimes` / `inboundRetryBaseMs` | `6` / `1500` | 入站重试:她正忙(503 `agent-busy`)时按 `msgId` 重试,第 n 次等 `n × base`(≈22s 窗口) |
| `pollMs` | `2000` | 旧桥轮询时代的间隔,**现在没有使用者**(唯一的路 = 服务注入),保留只为兼容旧 `config.json` |
| `transport` | `auto` | `auto` / `service`(严格,验收用)。两者行为一致(**服务注入是唯一的路**);旧值 `http` 已退役,落回 `auto` 并在 `problems` 里说明 |
| `mainBaseUrl` / `mainToken` | — | **已随旧桥退役**:留着也不读,解析时在 `problems` 里记一声 |

**三条纪律(每一条都是踩过的坑,不许"顺手放宽")**:

① 总闸默认关;② 白名单为空 = 一律拒收;③ `accessToken` 为空 = 拒收一切连接。
配置坏值一律**落回默认并记进 `problems`**,由面板与启动日志显示 —— 静静吞掉配置错误,
最后会变成"她为什么不说话"。

**入站流水账**:`~/.dsh/echo-qq/inbound.jsonl`(`lib/journal.js`),每步一行:
阶段 `gate` / `envelope` / `sent` / `core-refused` / `core-error`,带图数、字长、前 40 字、原因;
**按 500 行滚动、永不抛**。排查从"翻进程输出"变成"看一个文件"。

---

## 五、数据与备份

**数据根**:`~/.dsh/echo-qq/`

| 路径 | 是什么 | 私密? |
|---|---|---|
| `~/.dsh/echo-qq/config.json` | 配置(**含 `accessToken` 口令**) | **是(密钥)** |
| `~/.dsh/echo-qq/inbound.jsonl` | **入站流水账**(他消息的前 40 字、图数、拒收原因) | **是**(有他说话的内容) |
| `~/.dsh/echo-qq/*.bak-*` | 配置的历史备份 | 是(可能含旧口令) |

**她的记忆与对话不在这个包里** —— 在**主包**的数据目录 `~/.dsh/echo/`(`echo.db`)与宿主的
`~/.dsh/attachments/v1/`(图片字节)。备份要连着主包一起备。

**备份怎么做**

```powershell
Copy-Item "$env:USERPROFILE\.dsh\echo-qq\config.json"    <备份目录>\ -Force
Copy-Item "$env:USERPROFILE\.dsh\echo-qq\inbound.jsonl"  <备份目录>\ -Force
```

> `config.json` **已在 `.gitignore` 里拦了一道**(`config.json` / `.env`),仓库里**一个密钥都没有**。
> 交任何日志时先看一眼 `inbound.jsonl` —— 里面有他说话的内容。

---

## 六、装完怎么验

```powershell
# ① 三件套 + ws 解析
node scripts\install.mjs --check
#    期望:装机位在、bundles/dependencies 都在、ws 真解析到哪儿会打印出来;退出码 0

# ② 宿主侧两处登记
dsh --profile web --dump-config
#    期望:dsh-echo 与 dsh-echo-qq 都出现;零错误

# ③ 重启 dsh web + 硬刷新,看两条:
#    http://127.0.0.1:3080/echo-qq/             自带那页
#    http://127.0.0.1:3080/api/echo-qq/status   状态 JSON
#    期望:总闸与连接状态、接缝模式、收发计数、最后收发、配置问题、mouth{registered, serviceAvailable}、
#          timing(sent P50/P95)、accessTokenSet(只报配没配,**不吐口令**)

# ④ 一条命令看清"她这条嘴通没通"(只读:不发消息、不写库、不改配置)
node scripts\acceptance.mjs --port 3080
#    或 node scripts\acceptance.mjs          # 不给也行:自动找他本机在听的端口
#    三级判据:✔ 正常 / ! 注意(能用但有代价)/ ✖ 挡路,末尾附分段耗时;退出码 0/1/2

# ⑤ 真机(要 QQ 号 + 端口配合):照 docs/REAL_MACHINE.md
#    NapCat 反向 WS 指到我们的 host:port + 同一个 accessToken ⇒ 日志出现 client-connected;
#    发一条私聊 ⇒ inbound.jsonl 出现一行 stage:"sent";她回的话要真的出现在手机上
```

**NapCat 连接状态真值**:`closed | listening | client-connected`(体检把 `client-connected` 算**正常**,
不是"没连上")。

---

## 七、测试与闸门

2026-09-29 本次现场实测:

| 命令 | 期望 | 说明 |
|---|---|---|
| `npm test` | **130 / 130 通过**,退出码 0 | `node --test "test/*.test.mjs"`;含**真开 WebSocketServer 真连 ws** 的回归、`image-seam.test.mjs`(真发 NapCat 那条 JSON 走完整归一化) |
| `npm run check` | **退出码 0** | 每个源文件过一遍 `node --check`:`lib/index.js` `contract.js` `envelope.js` `config.js` `webpage.js` `onebot.js` `journal.js` `split.js` `verdict.js` `web/app.js` |
| `node scripts\acceptance.mjs --port <端口>` | 退出码 0/1/2 | 验收体检;判据与排版是纯函数(`lib/verdict.js`,有单测) |

**这个包没有 Python**,不会产出 `.pyc`,所以**没有 `prepack` 清 pycache** 那一步(主包有,见主包
`HANDOVER.md`)。

---

## 八、发布流程(打包由用户自己按这条做)

```powershell
cd $env:USERPROFILE\.dsh\plugins\dsh-echo-qq
# 1) 改版本号:package.json 的 version ↔ CHANGELOG.md 顶部条目必须一致
# 2) 更新 CHANGELOG.md(中文:现场 → 根因 → 修法 → 测试数字)
# 3) 打包
npm pack                                        # ⇒ dsh-echo-qq-0.1.6.tgz
# 4) 对一眼包内容
tar -tzf dsh-echo-qq-0.1.6.tgz
#    期望带上:lib/ web/ scripts/ docs/ cordis.patch.yml README.md CHANGELOG.md THIRD_PARTY.md LICENSE
#    期望没有:node_modules/ws、config.json、*.tgz、inbound.jsonl
```

**`files` 白名单**(改包内容只看这里):`lib/`、`web/`、`scripts/`、`docs/`、`cordis.patch.yml`、
`README.md`、`CHANGELOG.md`、`THIRD_PARTY.md`、`LICENSE`。
(`scripts/` 与 `docs/` 是 2026-09-29 补的:README 教的 `node scripts/install.mjs` /
`node scripts/acceptance.mjs` 与它指路的 `docs/REAL_MACHINE.md`,此前在 tgz 里是 file not found。)

---

## 九、排障(今晚真踩过的坑)

### 1. 他**只发一张图**(不打字)⇒ 什么都没发生
**根因**:`buildPrivateEnvelope` 里 `images: []` 是写死的,图文段被降级成正文的「［图片］」四个字,
而且**空正文直接拒** ⇒ 那条信连门都进不了。**修法(v0.1.5)**:`imagesOfSegments()` 把 OneBot
图段按主包 `parseImages` 的形状(`url`/`file`/`name`,最多 4 张)送过去;拒信理由改成主包同口径
「text 不能为空(除非他发的是图)」。**认不出来的段不发明形状** —— 宁可只有文字痕迹,也不发一个
形状不对的段让主包把**整条**信拒掉(整条被拒 = 他连字都白打)。

### 2. ⚠️ 图片的**两种 segment 形状**(第一版是假绿,当场抓回来的)
生产里段是**平铺的** —— `lib/onebot.js` 的 `normalizeSegment()` 早就把段归一成
`{type:'image', url, file}` 才交给 `onEvent`;只有**原始 NapCat 事件**才是 `data` **嵌套**
(`{type:'image', data:{url,…}}`)。第一版只读 `seg.data.url`,单元测试照原始形状 ⇒**全绿,
真机照样丢图**。现在 `fieldOf()` **两种形状都认**;回归钉子 = `test/image-seam.test.mjs`
(**真开反向 WS、真发 NapCat 那条 JSON、真走 onebot 归一化**,再拿 `onEvent` 收到的 `evt` 造信封)
—— 它在修之前**必红**。

### 3. link 装机下 `ws` 解析不到(运行期才哑)
**根因**:Node 会先把 junction 解析成真实路径,解析起点落在源码区;别靠猜,`install.mjs` 的
`verify()` 会**真解析一次**并打印解析到哪儿。本机靠 `~/.dsh/plugins/node_modules`
(junction → `~/.dsh/profiles/node_modules`)兜住。

### 4. 面板把总闸从"关"拨到"开",看着开了其实没在听
**根因(v0.1.4)**:反向 WS 只在挂载那一刻起过一次,之后那 5 秒一轮只重读配置 + 自报家门,
**永远不会去起监听**。**修法**:每轮 `syncListener()` 对账 —— 该听没听 ⇒ 起(15s × 20 退避);
不该听却在听 ⇒ 停;`host/port/token` 变了 ⇒ 先停再起;`disposed` 后不再补起。

### 5. 他收到**两份**同一句话
**根因(v0.1.4)**:一批出站"等 `notBefore`(封顶 3s)+ 逐段发 + 段间 500ms"叠起来可能超过主包那
**30s 租约**;租约一过期,主包会把**已发出去**的行再推一遍。**修法**:整批给 20s 预算,超预算或
还没到点的行**不回执**,留队列等下一轮;`stats.failed` 只数**真试过**的,不把推迟记成失败。

### 6. emoji 发出两个乱码方块
**根因**:单行超长硬切按**码元** `slice`,落点正好在**代理对**中间。**修法**:`cutAt()` 落点退一格
到字符边界;退化情形宁可这一段超 1 个码元,也不发半个字。

### 7. 他发图那次"什么都没发生",但宿主日志里只有一行 info
**根因**:适配器在门口就拒了,而这件事没有可查的痕迹。**修法**:`lib/journal.js` →
`~/.dsh/echo-qq/inbound.jsonl`(见四)。**排查顺序**:先看这个文件,再看宿主 stdout。

### 8. 入站被主包整条 403 `not-master`
**根因(v0.1.1)**:信封少了 `sender.isMaster`,主包 `lib/relay.js` 那道门把每条都拒 —— 而**理由
只在宿主 stdout 里**,面板和体检都看不见。**修法**:白名单过了就声明 `isMaster: true`(单主人;
白名单的职责就是认人);主包给的理由落到 `channel.lastRejectReason`,体检里"入站被拒"直接算**挡路**
并摆出理由。

### 9. 她**正忙着**的时候你说的话会没
**根因**:主包回 503 `agent-busy` 前会 `relayRollbackInbound`(撤掉受理记录),注释写明"让适配器
按 `msgId` 重试";旧适配器有 `inbound_retry_times`,头一版**漏搬了**。**修法**:`inboundRetryTimes` ×
`inboundRetryBaseMs` 重试;**只有值得重试的**才重试(`agent-busy`/`agent-unavailable`/HTTP 5xx),
形状不对、不是主人、群聊、总闸关这种一次就够;`duplicate: true` 算已收。

### 10. 配置读不动 / 装机器当场炸在半路
**根因**:**BOM**。PowerShell(`Set-Content -Encoding UTF8`,尤其 PS 5.1)会写 UTF-8 BOM,而
`JSON.parse` 见 BOM 就抛。**修法**:读配置容忍 BOM;写文件一律
`[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($false)))`。
`README` 也照这条纪律写过。

### 11. 端口被占 / "谁在听 6199"
**根因**:历史现场 6199 归 AstrBot(`python.exe launch_backend.py`)。**一个端口只能有一个听众**。
**修法**:绑不上端口时退避重试(15s × 20 ≈ 5 分钟),腾出端口后自己接上,不用再重启一次。
查:
```powershell
Get-NetTCPConnection -LocalPort <端口> -State Listen | Select-Object OwningProcess
```

### 12. "体检"说通过了,但其实什么都没发出去
**根因**(真 bug):插件发的是**已算好的摘要**,脚本头一版只认原始样本 ⇒ 永远显示"样本 0 条"、
还把整条耗时结论**静默漏掉**。**修法**:两种输入都认,"有推送却没有数字"明确报出来;同一轮还修掉
`Number(null) === 0` 把"没样本"编成 `0ms` 的问题 —— **"没样本"与"很快"不是一回事**。

---

## 十、目录速查

```
~/.dsh/plugins/dsh-echo-qq/        源码区(= link 装机位)
├─ lib/       index.js(挂载/监听/入站/出站) contract.js(接缝消费端)
│             envelope.js(信封) onebot.js(借来的反向 WS 客户端,见 THIRD_PARTY.md)
│             config.js(配置三条纪律) split.js(分段) journal.js(入站流水账)
│             verdict.js(体检判据纯函数) webpage.js(自带那页)
├─ web/       /echo-qq/ 静态页
├─ scripts/   install.mjs(装机器三件套) acceptance.mjs(验收体检)
├─ test/      node --test 用例(含 image-seam 真 WS 回归、nohardcode 打包纪律门卫)
├─ docs/      REAL_MACHINE.md(真机清单与本轮数字)
├─ config.example.json   配置样板(照 lib/config.js 抄)
├─ package.json          files 白名单 + engines>=22.5 + dependencies: ws
└─ HANDOVER.md           本文
```
