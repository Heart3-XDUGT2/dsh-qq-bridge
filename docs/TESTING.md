# 测试范围

基准Node24。`npm ci --legacy-peer-deps --ignore-scripts`不自动安装宿主peer。runner先preload全新临时数据目录，每次把文件选择矩阵和TAP保存到`.scratch/test-runs/`。

`npm test`枚举根test非跨仓文件，以及official明确六文件delivery/ledger/transport/plugin/inbound-recovery/gateway单元组；包含假回环WS/Cordis生命周期。根test显式读memory源码的文件及official其余真实codec/宿主/恢复测试归integration。`test:all`选所有文件，不以skip掩盖缺依赖。

```powershell
# 两个干净克隆同父目录，保留准确目录名
git clone https://github.com/Heart3-XDUGT2/dsh-memory-agent.git
git clone https://github.com/Heart3-XDUGT2/dsh-qq-bridge.git
cd dsh-qq-bridge
npm ci --legacy-peer-deps --ignore-scripts
npm test
cd ../dsh-memory-agent
npm ci --ignore-scripts
cd ../dsh-qq-bridge
npm run test:prepare-cli
npm run test:integration
npm run test:all
```

官方tests直接引用`../../../dsh-memory-agent`真实源码，legacy接缝引用本仓根lib；不拷假主包。memory锁显式准备公开0.2.0-rc.2测试模块及Cordis4.0.4，不安装整CLI。

两个仓的安装参数不同：QQ的小锁用legacy避免宿主peer自动安装；memory锁含必要宿主peer，必须普通npm ci，不能照抄QQ的legacy参数而省略dsh-scope等实际运行依赖。

`test:prepare-cli`仅从固定公开npm registry取得`@deepseek-ai/dsh@0.2.0-rc.2`源码包，核固定SHA512完整性，再拒绝绝对路径、穿越、软/硬链接和不唯一源码，仅解包package.json及profile-boot源码。不会安装CLI运行依赖。shutdown测试执行该发行包的**原始控制块**，不是CLI完整启动或plugin管理验收，也不回退私人安装目录。源码结构变化明确失败，不退成自编算法；准备失败则集成失败。

准备/打包的npm子进程清理继承的npm_config变量（大小写无关）、NODE_OPTIONS/NODE_PATH与数据目录覆盖，使用新临时目录中的空user/global npmrc及独立cache；不依赖用户npm凭据文件。安装边界与混合大小写环境负控是默认单元的一部分。官方doctor只检查自身登记/声明依赖，不读取OneBot配置或要求ws。

Windows本地卷进程/恢复测试必须在Windows运行；Linux不跳过后冒称同覆盖。单元不代表AgentLoop贯穿，集成也不等于真实QQ权限/模型/送达验收。所有账号/内容是合成，网络仅本机假端点。

跨仓checkout的默认GITHUB_TOKEN不能读另一私仓；公开前经理本地干净沙盒验证，不往workflow塞PAT。公开后CI必须实际运行通过；没有成功run不得声称线上CI绿。
