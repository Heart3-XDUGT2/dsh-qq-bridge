# Echo QQ Bridge

DSH Echo渠道插件。仓库名`dsh-qq-bridge`，运行包名仍是`dsh-echo-qq`。人格、记忆与会话由[dsh-memory-agent](https://github.com/Heart3-XDUGT2/dsh-memory-agent)提供，不另建陪伴Agent或迁移数据库。

`0.2.0-preview.1`是GitHub预发布候选，非npm发布或真实账号全功能验收承诺。

## 实际能力

- OneBot11反向WebSocket：准入私聊/群聊、群白名单、群醒/闲置休眠、@对象识别、文本回复/回执。
- 可使用NapCat或SnowLuma：反向客户端、Universal、array及匹配的Bearer token。两套桥不可同时向Echo上报；不同实现的消息ID、文件资源和转发ID不保证互通或跨桥去重。
- 图片交主包附件/识图链；合并转发有界展开；文件先感知再按主包权限读取。语音仅记录收到与确有的时长，**无ASR/转写**。
- `echo_qq_file_send({ref})`提交本轮成功展示、工作区`echo-outgoing`内的非空产物，最大8MiB；仅当前真实QQ主人私聊或准入醒群内主人输入。不选择任意收件人，结果未知不自动重发。
- QQ空间依赖独立空间桥与有效授权/Cookie，换OneBot不等于空间自动支持。

`official/`是独立**默认禁用、明确绑定主人、文字C2C**官方桥；不是群/媒体/主动推送的全能替代，开发权限、账号范围和平台接口限制可能阻碍使用。见[官方说明](official/README.md)。任何桥均**没有防封保证**。

## 安装与更新

正式基准Node24。用户先自行安装兼容DSH并创建profile；本仓不自动安装大型宿主、登录QQ或改名单。

```powershell
git clone https://github.com/Heart3-XDUGT2/dsh-qq-bridge.git
cd dsh-qq-bridge
npm ci --legacy-peer-deps --ignore-scripts
npm run check
npm test
node scripts/install.mjs --profile web
node scripts/install.mjs --profile web --check
```

**不能省略安装而只跑`--check`**。脚本支持`--help/--doctor/--remove/--profile`，`DSH_HOME`可显式指向沙盒；无参数安装链接源码并登记bundle/dependency，不创建profile或重启DSH。链接后要保留源码目录。

更新：先保留源码修改，取用户选定发布版本，再运行同样的npm ci、安装和check；业务代码需用户在合适时机重载/正常重启DSH，网页静态资源刷新。不要删除业务数据“升级”。

```powershell
node scripts/install.mjs --profile web --remove
```

卸载仅摘本插件登记/安装位，不删QQ账号、Echo记忆或数据。[安装边界](docs/INSTALLATION.md)。

## 开发与打包

`npm test`为独立单元范围；跨仓/真实宿主集成必须另跑，不能称单元绿即全系统绿。见[测试矩阵](docs/TESTING.md)。`npm run pack:check`生成并核两份tgz，不上传npm/GitHub。

[CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [PRIVACY](PRIVACY.md) · [预发布说明](RELEASE_NOTES.md)。自主代码MIT，第三方权利见[THIRD_PARTY](THIRD_PARTY.md)。
