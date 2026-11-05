# 官方桥第三方边界

自主代码随根项目MIT并带LICENSE；腾讯、QQ客户端、DSH及外部实现的商标/代码/API权利不因本项目MIT而重授权。本目录不捆绑NapCat/SnowLuma/QQ二进制。

生产用Node内置fetch/WebSocket及DSH注入；测试用Cordis/ws，其许可随各自包保留。OneBot改编来源仍见根THIRD_PARTY.md。平台开发权限和服务条款不可由软件许可绕过。

## 历史协议审查来源与原许可记录（保留）

# 来源与许可

访问日期均为 2026-10-29。原型没有复制或打包腾讯 SDK/DSH 插件代码，也未安装这些包。传输实现按官方公开协议独立编写；不执行下载的源码/安装脚本。

核查过可独立复用的 @tencent-connect/qqbot-nodejs 1.0.5：npm 版本元数据中的 gitHead 为 429a0f1b798f3b0fcef3679e207dbc0469a1df2d，Node >=20，ESM，生产依赖 ws ^8.21.0。固定提交的 protocol 子入口确有 GatewayConnection、TokenManager、ApiClient 等接口，不要求 DSH Agent。没有用 README 猜接口。

- https://registry.npmjs.org/@tencent-connect%2fqqbot-nodejs/1.0.5
- https://raw.githubusercontent.com/tencent-connect/qqbot-nodejs/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/index.ts
- https://raw.githubusercontent.com/tencent-connect/qqbot-nodejs/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/index.ts
- https://raw.githubusercontent.com/tencent-connect/qqbot-nodejs/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/gateway/gateway-connection.ts
- https://raw.githubusercontent.com/tencent-connect/qqbot-nodejs/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/LICENSE

另核查 tencent-connect/dsh-qqbot HEAD README/package.json（版本字段0.5.4）与 LICENSE，均为 MIT；原版插件按 QQ 对端另建 Agent，不直接复用为 Echo 内核。此 HEAD 未固定提交，不能当成 npm 最新版本证明。

- https://bot.q.qq.com/wiki/agent-qqbot/
- https://raw.githubusercontent.com/tencent-connect/dsh-qqbot/HEAD/README.md
- https://raw.githubusercontent.com/tencent-connect/dsh-qqbot/HEAD/package.json
- https://raw.githubusercontent.com/tencent-connect/dsh-qqbot/HEAD/LICENSE

历史设计引用另在主项目文档；本发布仓实际能力与生命周期以official/README.md和当前源码为准。旧轮次未安装依赖的陈述仅指历史阶段，043公开测试依赖已按锁准备。

以下保留所读 SDK MIT 原文供后续复用时审查，不表示本轮已打包 SDK：

> MIT License
>
> Copyright (c) 2026 Tencent
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

所读 DSH 插件许可证同为该 MIT 许可文本，版权行为 Copyright (c) 2026 Tencent Connect；后续如复制其实现，需随副本保留对应完整版权与许可声明。
