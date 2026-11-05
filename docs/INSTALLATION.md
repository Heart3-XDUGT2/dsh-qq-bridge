# 安装边界

Node24；npm ci使用`--legacy-peer-deps --ignore-scripts`按锁安装ws和小型测试依赖，避免peer自动拉大型DSH树。生产可加`--omit=dev`；测试需要dev依赖。运行时宿主服务ctx注入，用户自行准备DSH。

先创建目标profile，再运行`node scripts/install.mjs --profile web`，然后`--check`。`--check`只校验；`--doctor`诊断；`--remove`卸载。更新用重跑安装，没有`--upgrade`。profile仅字母数字/下划线/连字符。DSH_HOME默认用户主目录下`.dsh`，沙盒显式覆盖。

安装会改目标profile package.json中自己的bundle/link dependency，并创建源码链接（Windows junction）；旧插件副本安装位可能被替换，不清业务数据。勿移走源码留下悬空bundle。脚本不自动启动/重启DSH。

显式DSH_HOME本身先解析为真实边界；profile/node_modules祖先链接、异常profile文件、源码与安装槽互包含会被拒绝，不会借祖先junction递归删除边界外内容。安装槽本身作为正常源码链接时，卸载只摘链接，不递归进源码。这些检查不承诺抵御本机特权进程在检查后同时恶意替换路径。

OneBot反向WS应连接实际配置host/port（默认以lib/config.js为准），两端token仅本机保存，先核白名单。SnowLuma关闭不需要的默认server避免与NapCat冲突；切桥时仅一套连接。不要把合成QQ号或token当真实配置。

官方桥可从根仓运行`node official/scripts/install.mjs --profile web`及`--check`登记独立包，bundle仍enabled:false。官方owner-setup配对是用户显式网络/凭据操作，不属于测试或自动安装；参见official/README.md。
