# 0.2.0-preview.1

发布准备：跨仓路径与测试范围、依赖锁、Node24门、独立official MIT/安装脚本、隐私/贡献/安全文档及双tgz验收；业务能力与限制见RELEASE_NOTES.md。

# dsh-echo-qq 更新日志

## v0.1.6(未发布)· 声明 dsh peer(0.2.0-rc 适配)(2026-10-02)

- **`peerDependencies: {[…]: […]}`**:0.2.0 的宿主启动/安装
  **不**给 `@deepseek-ai/dsh-tools` / `dsh-llm` 声明 peer:它们随宿主从
- 全套测试照旧全绿(`npm test` / `npm run check` 0);与主包跨包契约一个字没动。

## v0.1.5(未发布)· 带图入站接上了(S2-b 最后一块)(2026-09-29)

- **`imagesOfSegments(segments)`(新)**:OneBot 图段 → 主包 `parseImages` 的形状
- **只发图不写字也是信**(`buildPrivateEnvelope`):拒信的理由改成与主包同口径的
- **正文不再重复[…]**:能当图送过去的段,她真的会看到图(主包注入时附
- **适配器入站同步传图**(`lib/index.js` 的 `onEvent`):`images: imagesOfSegments(evt.segments)`。
- **第一版是假绿,当场抓回来了**:`imagesOfSegments` 起初只读 `seg.data.url`,而**生产里段是
- **入站流水账**(`lib/journal.js` 新):他发图那次[…],而[…]
- 测试:适配器 **130/130 通过**(`envelope.test.mjs` +7、新增 `image-seam.test.mjs` 5 条真 WS、
- 已知边界(写在这免得又被当成 bug):图靠主包**注入那一刻去抓**(QQ 的 CDN 链接是临时的,

## v0.1.4(未发布)· 审计:监听只起一次 / 出站超租约 / emoji 被切两半(2026-09-29)

- **反向 WS 只在挂载那一刻起过一次**:面板上把总闸从[…]拨到[…](或补上
- **一批出站可能超过主包那 30s 租约**:一行的「等 `notBefore`(封顶 3s)+ 逐段发 +
- **emoji 被硬切成两半**:`splitForSend` 的单行超长硬切按码元 `slice`,落点正好在
- **版本号只留一份真源**:`lib/index.js` 里写死 `'0.1.2'`、package.json 已是 0.1.3
- 测试 13 个文件全过;`npm run check` 0。

## v0.1.2(未发布)· 真机第二轮:她忙着的时候你说的话会没(2026-09-28)

- **入站撞上[…]会被丢掉**:主包在回 503 `agent-busy` 之前会 `relayRollbackInbound`
  **只有值得重试的**才重试(`agent-busy` / `agent-unavailable` / HTTP 5xx),
- **积压没人取**:推送只在新话出现时来 ⇒ 重启前留下的一泡(真机第一轮的 `out_id 102`)
- 小账:`counters.inRetried` / `counters.dup` 都进状态,体检里会写[…]。
- 测试 88 → **94**、`check` 0。

## v0.1.1(未发布)· 真机第一轮:他发的那条消息暴露的三处(2026-09-28)

- **⚠️ 入站全被拒**:信封少了 `sender.isMaster`,主包 `lib/relay.js:341` 那道 `not-master` 门
- **分泡节奏被压平**:出站行带 `notBefore`(这一泡什么时候该发 —— 旧适配器
- **超长回复被截断(真丢话)**:旧适配器是 `split_segments` 之后**分段发**(`main.py:575-584`),
- **同一组后面的泡要有人推**:`nextDueAt`(下一泡到点时刻,`store.js` 里算好给适配器的)
- 体检:NapCat 连接的真实状态认对(`client-connected` 算正常,不是[…];
- 测试 74 → **88**、`check` 0。

## v0.1.0(未发布)· S2-b 落地:装机器 + 契约补 `lease` + 过渡期容错(2026-09-28)

- **⚠️ 契约补 `lease`(补的是一个会让切换**静默失灵**的缺口)**:主包的推送只喊[…]
- **没有连接就不去取行**(`canSend`,新增):过渡期主包那条老路(AstrBot)还在跑,两条路共用同一份队列 ——
- **绑不上端口就退避重试**(15s × 20 ≈ 5 分钟):6199 现在归 AstrBot,所以[…]
- **装机器 `scripts/install.mjs`**(`--check` / `--doctor` / `--remove` / `--profile <名>`):
- **读配置容忍 BOM**:PowerShell 的 `Set-Content -Encoding utf8` 会写 BOM,`JSON.parse` 见 BOM 就抛
- **测试 74 条**(新增 11):装机器在**临时 DSH_HOME 里真装真卸**(三件套/两种半死/坏 profile/BOM);

## v0.1.0(未发布)· S2-b 准备:验收体检 + 真机清单(2026-09-28)

- **一条命令看清通没通**:`node scripts/acceptance.mjs --port <他的端口>`(只读:不发消息、
- **判据与排版是纯函数**(`lib/verdict.js`),有单测(12 条)—— 因为这张表决定[…],
- **插件自己记分段耗时**(`/api/echo-qq/status` 的 `timing`):[…]
- **状态接口**多两项:`accessTokenSet`(只报[…],**不吐口令**)、`timing`。
- **端到端自检抓到一个真 bug**:插件发的是**已算好的摘要**,而脚本头一版只认原始样本 ⇒
- `docs/REAL_MACHINE.md`:他欠的两步(NapCat 反向 WS + 重启一次 `dsh web`)+ 真机这一轮要盯的 8 条。
- **自检留成了永久回归测试**:脚本拆成[…](被 import 时不自动跑),
- **门槛**:单测 42 → **59**;`npm run check` 0;打包纪律门卫 5/5。`scripts/`+`docs/` 不进包。

## v0.1.0(未发布)· S3-b 前半:自报家门 + 配置活视图(2026-09-28)

- **向主包自报家门**(`registerChannel`):总闸开着 + 主包服务在 ⇒ 报上去;任一不成立 ⇒ **撤回**
- **配置改成活视图**:channel 拿到的是 getter 视图,改 `transport` / 主包地址**不用重启**
- **状态接口**多一项 `mouth: { registered, serviceAvailable }` —— 面板/体检一眼看出
- **门槛**:单测 40 → **42**;`npm run check` 0;打包纪律门卫 5/5 照旧。

## v0.1.0(未发布)· S3-a:传输开关 + 打包准备(2026-09-28)

- **传输开关**:新增配置 `transport = auto | service | http`(默认 `auto`)。`auto` = 有服务用服务、
- **主包提供端已上线**(主仓 S3-a):`ctx.provide('echo:relay', …)` 的名字 / 版本 / 字段名与
- **打包准备**:主包地址改**现推**(`resolveMainBaseUrl`:显式配置 → 宿主 `webServer.port` → 空串),
- **门槛**:单测 29 → **40**;`npm run check` 0。

## v0.1.0(未发布)— plan 的 S2-a:骨架

**新插件诞生**:把 QQ 那一层从 `dsh-echo` 主插件里拆出来,做成独立插件。

- 引用/致谢见 `ACKNOWLEDGMENTS.md`
- **接缝 `lib/contract.js`**:渠道服务的**消费端**。主包在(能 `ctx.get('echo:relay')` 到)就走**服务注入**,
- **自带一页**:`/echo-qq/`,走宿主 `webServer` 前缀路由,每请求现读文件(改页面刷新即见效)。
- **验收**:29 项单测(`node --test`;含**真开 WebSocketServer、真连 ws 的收发回归**)、
- **本版不装进任何 profile**:只落在源码区 `~/.dsh/plugins/dsh-echo-qq`。主包与 AstrBot 一切照旧,

### 还没做的(别当已完成)

| 项 | 计划在哪一步 |
|---|---|
| 真机收发(反连 NapCat、发一条真消息)、带图入站、工具收窄的实际拒绝日志 | **S2-b**(要 QQ 小号与端口配合) |
| 装机校验(第二个 profile、`install.mjs` verify 认第二个包、`hygiene` 跨包扫描) | **S2-b**(照 plan §S2 的清单) |
| 主包侧的接缝提供端 `ctx.provide('echo:relay', …)` | **S1**(动主包,需要重启 `dsh web`) |
| 私聊白名单 / 幂等 / 送达 ack / 关怀保鲜期的接管 | **S3**(语义留在主包,这里只搬运) |
| 主包面板撤掉桥那一栏、旧桥封存 `archive/` | **S3** |
