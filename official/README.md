# Echo 官方 QQ 主人文字私聊

这是 Echo 的受限官方 C2C 文字渠道，运行包名 `dsh-echo-qq-official`。默认 `enabled:false`，只服务一个经本机配对确认的主人，复用原有 Echo Agent 和会话；不另建 Agent、不迁移记忆数据库。

它不是 OneBot 全功能替代：不启用群聊、图片、文件、语音、空间、多气泡或主动推送。实际可用性受腾讯机器人开发资质、账号体验范围、C2C/WS权限与平台配额限制；没有防封或收件人已读保证。官方平台开发说明见 https://bot.q.qq.com/wiki/ 。

Echo 的 `echo_qq_say` 接受正文后，在正常轮结束时合为一条文字；普通助手正文不重复发送。无明确工具回复、来源歧义、取消、异常，或合并内容超过1500 Unicode code points时不提交，不截断后转发，也不转成主动消息。

## 环境与登记

- Node.js 24，使用内置 fetch/WebSocket，无额外生产依赖。
- 兼容DSH及相配的 `dsh-memory-agent` 主包。官方适配器需主包的 `echo:relay.officialOwnerText` 服务；缺能力或主人绑定时保持关闭，不自行连接或新建会话。
- 默认受管日志恢复要求 Windows 本机固定卷；UNC/网络映射盘、未知卷、非Windows环境会保守拒绝，不承诺跨机器锁。

以下命令均在本仓根目录执行。先由用户在DSH创建目标profile并安装主包：

```powershell
npm ci --legacy-peer-deps --ignore-scripts
node official/scripts/install.mjs --profile web
node official/scripts/install.mjs --profile web --check
```

第一条安装依赖，第二条链接并登记官方包，第三条只校验登记。登记不会自动配对、写入凭据、开启机器人或重启DSH，bundle仍默认关闭。`DSH_HOME`可显式指定沙盒或用户选择的位置；链接安装需保留源码目录。

## 配对并由用户启用

1. 在腾讯开发者平台创建/选择机器人，核实自己的账号是否在允许范围、是否有主人C2C/WS权限。把AppID与AppSecret保存在受系统ACL保护的本机凭据JSON，不写进命令行、聊天或issue。合成结构如下：

```json
{"appId":"LOCAL_APP_ID","appSecret":"LOCAL_SECRET"}
```

2. 准备一个尚不存在的授权草稿输出路径，父目录已存在。显式运行配对工具：

```powershell
node official/scripts/owner-setup.mjs --config "<本机凭据JSON绝对路径>" --output "<新授权草稿绝对路径>"
```

该工具会连接所选AppID，属于真实网络操作，不是离线测试。它不连接Echo、不调用模型，也不发送应用回复。在本机终端显示一次性256-bit随机文字，默认有效两分钟；由你本人向机器人发送这段文字。普通来信、昵称、群主身份均不能自动成为主人授权。

3. 发现匹配候选后，工具显示短指纹。核实确为本人刚发的配对消息，再在**本机终端**输入要求的完整 `CONFIRM <指纹>`。错确认、超时、多个不同候选冲突均不写授权；nonce单次使用、过期终止连接。
4. 成功只创建含 `ownerBinding` 的新授权草稿，不含AppSecret，也不写profile或自动启用。用户核对草稿后，在DSH的该插件配置中合入本机凭据和绑定，并指定一个新的绝对stateDir；首次配置仍保持关闭：

```json
{
  "enabled": false,
  "appId": "LOCAL_APP_ID",
  "appSecret": "LOCAL_SECRET",
  "ownerBinding": {
    "appId": "LOCAL_APP_ID",
    "userOpenid": "LOCAL_CONFIRMED_OWNER_OPENID",
    "authorized": true
  },
  "stateDir": "ABSOLUTE_PATH_TO_A_NEW_DIRECTORY"
}
```

stateDir父目录应已存在，目标目录首次必须尚不存在。不要用真实数据目录做测试，不把OneBot的QQ号白名单当官方OpenID绑定。

5. 用户自行确认绑定、平台权限和数据目录后，将 `enabled` 改为 `true` 并在合适时机重载/正常启动DSH。加载当前主包和适配器后，用主人账号发一条普通文字核对。新配置未通过时保持关闭，勿反复删日志或更换目录绕过去重；未知发送结果不要重发。

## 诊断、更新与卸载

```powershell
node official/scripts/install.mjs --profile web --doctor
node official/scripts/install.mjs --profile web --check
node official/scripts/install.mjs --profile web --remove
```

`--doctor`诊断登记/包状态，不代替平台登录或真实发送验收。更新前保留配置和日志，取用户选择的发布版本，在根重新 `npm ci --legacy-peer-deps --ignore-scripts`、安装和check，再由用户安排重载；不要删除stateDir来升级。卸载只摘该包登记/链接，不删除绑定、日志、主包记忆或账户。

如果未连接，先核平台C2C/WS权限、凭据与绑定AppID是否一致、主包服务能力、日志目录/固定卷和安全错误码。不公开密钥、OpenID或日志正文；故障恢复边界见下节。

## 离线测试与打包

在仓库根执行 `npm test` 跑默认独立单元组。完整跨仓验证按 [测试说明](https://github.com/Heart3-XDUGT2/dsh-qq-bridge/blob/main/docs/TESTING.md)准备同父 `dsh-memory-agent`、公开宿主依赖与CLI源码门，再运行 `npm run test:all`。单元、集成和真实平台验证是不同范围；测试总数以所选版本的runner矩阵和实际TAP为准，不使用历史固定数字。

`npm run pack:check`生成两份tgz并核包内安装脚本/许可。官方包默认关闭；打包、源码测试绿色均不等于已登录QQ或用户当前客户端已加载。自主代码MIT，第三方来源与平台权利见 [THIRD_PARTY](THIRD_PARTY.md)、[LICENSE](LICENSE)，隐私规则见 [PRIVACY](https://github.com/Heart3-XDUGT2/dsh-qq-bridge/blob/main/PRIVACY.md)。

## 高级：发送日志与故障恢复

首次指定的新 stateDir 必须为绝对路径，父目录已存在，目标目录尚不存在。后续启动沿用原目录与日志，不另换目录规避去重。首次创建 `.echo-owner-text-mvp` 标记、`.writer-lock` 和 `owner-text.json`，只接受自己的新格式；拒绝 v1 目录、符号链接、不匹配 AppID/主人、损坏数据或任何 `owner-text.pending` 目录项（含悬空链接）。不要把旧文件改名冒充新格式。

每个原 `msg_id`（含全部 `msg_idx`）最多一条成功回复，固定 `msg_seq=1`。额外索引不启动第二次模型工作或取得额度。最早五分钟窗口只收紧；重复事件的受理 receipt、原始消息、固定 Reply/claim、每次 HTTP 尝试及结果都写入同一日志。

每次实际 POST 前同步持久 `sending` 和 dispatch 时间；该时间用于每秒 5 次、每分钟 20 次的账号工程护栏，不能使用等待 token 前的旧预留时间。确定 429 沿原 claim/body/seq 最多总计 3 次。confirmed 后只重试 core 确认；unknown、拒收、过期或撤销不重新发送。

文件写入采用同目录 pending、文件 fsync、rename；目录 fsync 在部分 Windows 文件系统不可用，不承诺物理断电恰好一次。容量上限 8 MiB、2048 个输入/metadata/anchor，达到即关闭，不删去重记录补额度。模式位不能替代 Windows 的本机用户 ACL。

正常退出只有所有活任务与 core drain 完成才释放文件锁，再关闭内核独占；超时或故障仍保守持有。没有活任务的历史 unknown 可以正常关日志。

下一次启动支持受控恢复，不做后台托管：Windows named-pipe独占随原进程死亡释放。默认启动先确认本机固定卷，规范化目录并按统一顺序取得父目录/名称与物理目录身份的排他；只有旧锁能严格识别为本协议、属于同一机器/目录/作用域，且marker、身份、日志、容量及无pending检查通过，才在独占内将旧锁和原日志完整保存到不覆盖的 `recovery-<UUID>` 目录，然后接管。活写方或另一个恢复者不能被抢占。

旧版空锁没有这种所有权证明，需要用户先备份并人工核对迁移方式；不能因新原语空闲就自动清旧锁。未知锁格式、其它机器、UNC/映射网络盘、未知卷及非Windows环境均保守拒绝；这不是分布式锁。启动只短暂读取Windows卷类型/安装标识，本机标识仅作哈希绑定，不打印机器ID、锁token、路径、身份或正文；没有安装依赖、常驻辅助进程或自动重启DSH。

恢复时sending转unknown、旧草稿abandoned、旧claim清除；旧confirmed/unknown不重发，不重放旧模型工作，只服务新来信。备份或校验失败保留现场，以固定中文启动日志和controller安全code/message说明需检查、旧版锁需一次处理或独占未取得。异步初始化期间禁用、服务更换或销毁会关闭迟到资源；未排空前不会提前释放所有权。没有历史授权恢复或旧积压重放命令。
