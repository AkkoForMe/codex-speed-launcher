# Windows 单文件可执行程序

Windows x64 可使用单个 `.exe` 启动 Codex Speed Launcher，无需另装 Node.js，也无需把 `src` 和 `runtime` 文件夹放在旁边。程序继续使用本机已安装的官方 Codex 和已有连接配置。

这是一种控制台启动器。双击 `.exe` 后，它启动 Codex，并保持控制台窗口以维持运行时适配。它当前没有独立设置窗口、托盘菜单、自动更新或安装向导。

## EXE、ZIP 与安装包

| 形式 | 适合的用途 | 当前状态 |
| --- | --- | --- |
| 单文件 `.exe` | 下载后直接运行；通过命令参数检查和诊断 | 已提供 Windows x64 构建脚本 |
| `.zip` | 压缩下载体积，放入教程、许可证或完整源码 | 现有便携包和源码包仍可使用 |
| 安装包／托盘应用 | 开始菜单快捷方式、托盘状态、升级和卸载 | 后续产品形态，当前未实现 |
| macOS `.app`／`.dmg` | 面向 Mac 的常见双击入口和分发方式 | 需要 Mac 构建与真机验收，当前未实现 |

EXE 是程序文件，ZIP 是归档格式，二者可以一起使用。例如，可在发布页同时提供直接下载的 `.exe`，以及装有该 EXE 和说明文档的 ZIP。

## 使用

先按项目 README 配置本机 Codex，确认普通请求可用。关闭正在进行的任务并完全退出 Codex 后，再双击 `codex-speed-launcher-<版本>-windows-x64.exe`。启动器不会自动关闭已运行的官方应用。

也可在 PowerShell 中执行：

```powershell
.\codex-speed-launcher-<版本>-windows-x64.exe inspect --json
.\codex-speed-launcher-<版本>-windows-x64.exe launch
.\codex-speed-launcher-<版本>-windows-x64.exe --licenses
```

`inspect` 只读检查客户端兼容性。`launch` 使用现有配置启动；不带参数时也执行启动。`--licenses` 从 EXE 内输出项目许可证、上游声明、Node.js 许可证及构建工具声明，单独分享 EXE 时这些内容仍可访问。

运行期间保留控制台窗口。等待当前任务完成并正常退出 Codex，启动器随后结束。`Ctrl+C` 用于关闭本次由启动器启动的应用；不要在尚未保存的工作期间使用。

## 构建

构建主机当前要求 Windows x64，运行构建脚本需要 Node.js 22 或更新版本。构建不需要管理员权限、全局安装包或 Windows SDK。

```console
node --test
node scripts/build-executable.mjs --out artifacts/executable-candidate
```

已有同名 EXE 时默认停止，确认替换构建产物后增加 `--force`。`--cache <目录>` 指定构建工具缓存，`--node-cache <目录>` 指定 Node.js 归档缓存。

构建过程如下：

1. 验证固定 Node.js `24.22.2` Windows x64 归档的 SHA-256。
2. 验证固定 esbuild `0.28.2` 和 postject `1.0.0-alpha.6` 归档的 SHA-512。
3. 用 esbuild 把启动器源码合并为 CommonJS，再由相同版本 Node.js 生成 SEA 数据。
4. 复制官方 Node.js 可执行文件，仅清除副本中已无法保留的 Authenticode 表，再用 postject 注入程序和许可证。
5. 对新 EXE 运行版本、许可证和有效／无效 ESM 语法检查；通过后写入输出目录。

下载与临时文件保存在 `.cache/`；用户运行 EXE 时不下载上述构建工具。构建没有打包 Codex 应用文件，也没有改写已安装 Codex 的资源或签名。

输出包括 EXE、对应的 `.sha256`、构建收据 `.build.json` 和可单独查看的 `THIRD_PARTY_LICENSES.txt`。收据记录运行时与工具版本、下载地址、固定哈希及最终文件哈希。

SEA 数据使用构建目录中的相对文件名，避免把维护者的绝对源码路径写进 EXE。构建脚本还会扫描最终文件中的当前源码目录、临时构建目录和用户目录，检查 UTF-8／UTF-16 及两种路径分隔符形式；命中时停止输出。

## 签名与平台限制

当前生成的 EXE **未经过代码签名**，不会继承原始 Node.js 文件的发行者身份。首次下载运行时，Windows 可能显示来源或信誉提示。发布者应提供可信下载渠道和 SHA-256；不要把未签名文件描述为已签名应用。

后续可以在注入完成后对最终 EXE 签名。代码签名、安装包和托盘界面是独立工作，打成 EXE 不会自动提供这些能力。

Node.js `24.22.2` 的 SEA 文档将该功能标为「Active development」，并说明 macOS x64 尚未纳入支持测试。当前构建脚本只生成 Windows x64 EXE；macOS 继续使用既有实验便携包。Mac 的 `.app`／`.dmg` 还需要真机上的签名、启动与原生菜单验证。

## 依据

- [Node.js 24.22.2 SEA 官方文档](https://nodejs.org/docs/v24.22.2/api/single-executable-applications.html)：SEA、CommonJS 入口、资源注入、固定启动参数及平台限制。
- [esbuild 官方文档](https://esbuild.github.io/getting-started/#bundling-for-node)：Node.js 源码合并与构建平台。
- [nodejs/postject](https://github.com/nodejs/postject)：将只读资源注入 PE 的官方工具项目与许可证。
- [Microsoft SignTool 文档](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)：Windows 文件签名的后续独立步骤。
