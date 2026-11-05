# 第三方代码与许可

本插件的 `lib/onebot.js` **不是从零写的** —— 它整块借自一个 MIT 许可的第三方 DSH 插件,
并按我们的架构做了删改。这份文件是出处与许可的正式记录(答辩、审计、日后跟进上游都用它)。

## `lib/onebot.js`

| 项 | 值 |
|---|---|
| 上游项目 | `dsh-qq-onebot-bridge` **v0.5.7** |
| 上游仓库 | https://github.com/cheesehaqi/dsh-qq-onebot-bridge |
| 借用文件 | `lib/onebot.js`(593 行 / 27.8 KB;只依赖 `node:events` 与 `ws`) |
| 许可 | MIT |
| 版权行 | `Copyright (c) 2026 dsh-qq-onebot-bridge contributors` |
| 我们改了什么 | 逐条写在该文件的**文件头「改动清单」**里;摘要见 `CHANGELOG.md` |

MIT 全文(必须随代码一起保留):

```text
MIT License

Copyright (c) 2026 dsh-qq-onebot-bridge contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> MIT 只要求"保留版权声明与许可全文",并不要求我们开源自己的改动。我们仍然把改动逐条写明,
> 理由是答辩与审计都要能准确回答:**哪些是现成的、哪些是我们写的**。
> 除 `lib/onebot.js` 外,本插件其余文件(**接缝 `lib/contract.js`、页面、测试、配置**)都是我们自己写的。

## 发布依赖

ws 8.22.1：MIT，https://github.com/websockets/ws 。开发测试Cordis 4.0.4及其锁定依赖保持原MIT许可；本项目不重新授权DSH宿主或腾讯/QQ客户端。official自主代码MIT，其API使用仍受平台权限和条款约束。
