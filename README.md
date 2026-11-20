# Codex Speed Launcher

独立的 Codex 桌面速度启动工具，让 API Key 和自定义 Responses 接入使用原生速度菜单。兼容 Sub2API 等支持 Responses 和服务档位透传的中转，继续使用已有的地址、Key 和模型。

项目采用 MIT 许可证，源码不依赖 Sub2API。启动器在本次运行中适配客户端；退出后可恢复官方快捷方式启动。

## 下载

当前预发布版为 [v0.2.2](https://github.com/AkkoForMe/codex-speed-launcher/releases/tag/v0.2.2)。

- [Windows x64 单文件 EXE](https://github.com/AkkoForMe/codex-speed-launcher/releases/download/v0.2.2/codex-speed-launcher-0.2.2-windows-x64.exe)
- [Apple 芯片 Mac 应用](https://github.com/AkkoForMe/codex-speed-launcher/releases/download/v0.2.2/codex-speed-launcher-0.2.2-darwin-arm64-app.zip)
- [Intel Mac 应用](https://github.com/AkkoForMe/codex-speed-launcher/releases/download/v0.2.2/codex-speed-launcher-0.2.2-darwin-x64-app.zip)

[下载校验值](https://github.com/AkkoForMe/codex-speed-launcher/releases/download/v0.2.2/SHA256SUMS.txt) · [所有版本](https://github.com/AkkoForMe/codex-speed-launcher/releases) · [问题反馈](https://github.com/AkkoForMe/codex-speed-launcher/issues)

Windows Codex `26.1117.3838.0` 需要启动器 v0.2.3，可[从源码构建 Windows EXE](docs/executable-distribution.md)。

## 当前验证范围

| 平台 | 状态 |
| --- | --- |
| Windows x64 | `26.1023.6621.0`、`26.1106.6628.0` 和 `26.1111.2228.0` 通过 Standard → Fast → Standard 隔离验证。`26.1111.2228.0` 另已验证 GPT‑6.2 Astra 和 GPT‑6.2 Sol 的 Ultrafast 请求。 |
| Windows x64（v0.2.3） | `26.1117.3838.0` 通过 Standard → Fast → Standard 隔离验证。 |
| macOS Apple 芯片／Intel | 已核验 `26.1111.21308` 的官方 Mac 归档。两种架构的最终 `.app` 均通过 GitHub Actions 的 AppKit 小窗模拟验收。官方 Codex 的原生速度菜单与出站请求待实机验收。 |

Codex 更新后，启动器会重新检查资源和补丁位置。检查失败时停止启动，不应把未知版本当作已支持版本。

测试使用本地模拟接口，确认菜单和请求参数一致；真实中转及上游的速度、可用性和费用仍需在使用者环境核对。详细范围见 [验收记录](docs/validation.md)。

## 使用前

1. 安装官方 Codex 桌面应用。
2. 配置自己的中转地址、Key 和模型，先确认普通模式可以正常请求。
3. 确认中转和上游支持所选速度档位。中转需要保留 `service_tier` 参数；过滤规则会让客户端开关无法传递到上游。

速度档位的可用性和计费由实际使用的中转及上游决定。

## 显示 Ultrafast

打开启动器小窗时，「显示 Ultrafast」默认关闭。勾选后启动或重启 Codex，再在原生速度菜单手动选择 Ultrafast。已验收的简体中文菜单显示「超快」。

使用 API Key 或自定义供应商时，当前模型目录需要声明 `ultrafast` 档位。缺少该选项时，检查当前供应商的 `model_catalog_url` 和模型目录。见 [简约小窗](docs/compact-window.md)。

## Windows

Windows「简约小窗」显示兼容性状态、Codex 版本和配置模型，提供启动、重启与退出操作。源码或便携包可运行 `node src/cli.mjs gui`。见 [简约小窗](docs/compact-window.md)。

推荐使用单文件 `codex-speed-launcher-<版本>-windows-x64.exe`。双击 EXE 会打开简约小窗；先等待兼容性检查完成，再保存工作并按小窗提示启动 Codex。无需安装 Node.js。

```powershell
.\codex-speed-launcher-<版本>-windows-x64.exe inspect | Out-String
```

当前 EXE 为未签名的 Windows 图形子系统程序；小窗使用系统自带 WPF。下载前核对发布来源和 SHA-256；托盘和安装向导暂未实现。构建与使用方式见 [单文件 EXE](docs/executable-distribution.md)。

需要在 PowerShell 执行只读检查时，使用管道等待并读取输出：`codex-speed-launcher-<版本>-windows-x64.exe inspect --json | Out-String`。需要长驻控制台会话时，使用源码或便携包的 `launch` 入口。

需要保留源码、文档和运行时目录时，可使用便携 ZIP：

1. 解压完整的 `codex-speed-launcher-<版本>-win-x64.zip`，保留 `runtime`、`src` 等目录。
2. 双击 `inspect-windows.cmd`。这一步只读检查，不会关闭正在运行的 Codex。
3. 检查通过后，保存工作并完全退出 Codex，包括后台窗口。
4. 双击 `launch-windows.cmd`。需要选择 Ultrafast 时，从 PowerShell 运行 `.\launch-windows.cmd --ultrafast`。
5. 保持启动器窗口运行，在 Codex 的原生速度菜单中选择档位。

便携包已附带固定版本的 Node.js，无需安装 npm 依赖。重新使用时，从 `launch-windows.cmd` 启动。

## macOS

推荐下载 Apple 芯片版 `darwin-arm64-app.zip` 或 Intel 版 `darwin-x64-app.zip`。解压后，将 `Codex Speed Launcher.app` 放到「应用程序」或其他固定目录，再双击打开。无需安装 Node.js，也无需保持终端窗口运行。支持 macOS 13.5 或更新版本。

小窗与 Windows 提供相同的信息和操作。重启和退出只管理本工具启动的 Codex，操作前会确认。已有其他入口启动的 Codex 需要先自行正常退出。

当前 Mac 应用使用 ad-hoc 签名校验包完整性，没有 Developer ID 签名或 Apple 公证。首次打开若被系统阻止，先核对下载来源和 SHA-256，再在 Finder 使用「打开」或系统「隐私与安全性」提供的打开操作；不要关闭系统安全保护。小窗行为和验证边界见 [Mac 简约小窗](docs/macos-window.md)。

### 备用脚本包

Apple 芯片使用 `darwin-arm64.zip`，Intel Mac 使用 `darwin-x64.zip`；它们保留原有终端入口供排错。

备用脚本包通过终端启动，不包含图形小窗；需要小窗时下载上方带 `-app.zip` 后缀的应用包。发布流程会在 Apple 芯片与 Intel 架构的 macOS 运行器上核对脚本包完整性、执行权限、自带运行时与脚本入口；这不代表已完成真实 Codex 桌面的菜单和请求验收。

1. 解压完整的包。
2. 双击 `inspect-macos.command`，先检查本机应用是否兼容。
3. 检查通过后，保存工作并完全退出 Codex。
4. 双击 `launch-macos.command`。需要选择 Ultrafast 时，从终端运行 `./launch-macos.command --ultrafast`。保持终端窗口运行。
5. 在原生速度菜单切换档位，用新请求验证结果。

如果 `.command` 没有可执行权限，在包目录执行 `chmod +x ./*.command ./runtime/node`。如果 macOS 阻止打开下载文件，先核对来源和 SHA-256，再通过系统提供的打开方式处理；启动器不会修改系统安全设置。

## 如何确认生效

在同一模型和同一 Key 下，逐个档位发送一条小请求。

1. 选择 Standard，发送一条小请求。
2. 选择 Fast，发送另一条小请求。
3. 如果菜单提供 Ultrafast，切到 Ultrafast 并发送一条请求。
4. 切回 Standard 并发送一条请求。
5. 在中转的用量或费用详情中核对档位，并在有权限时核对上游返回的档位。

Fast 对应 `service_tier: "priority"`，Ultrafast 对应 `service_tier: "ultrafast"`。服务端可能拒绝或降级，实际档位以服务端记录为准。

Fast 图标和请求参数均不能证明整段任务一定更快。推理、工具执行、网络和中转等待都会影响耗时。比较速度时，保持模型、推理强度、输入长度和输出要求一致，交错执行多轮，记录首字时间、总耗时、输出 token 数和上游实际档位；仅靠短回答的体感难以判断差异。详见 [速度验证](docs/speed-verification.md)。

## 恢复普通启动

正常退出 Codex，等待启动器结束，再从官方快捷方式打开 Codex。运行时适配随进程退出而消失；无需重装应用或还原 `app.asar`。原有连接信息继续保留。

保持启动器运行，直到 Codex 正常退出。`Ctrl+C` 会结束这次由启动器打开的 Codex，操作前先等待正在进行的回答完成。如果启动器窗口被意外关闭或进程被强制结束，先保存工作、完全退出仍打开的 Codex，再重新运行启动入口；不要根据残留图标判断本轮适配仍然有效。

如果启动器报告不兼容，保存检查输出并停止使用本包，等待对应版本适配。不要反复强行启动，也不要把私钥、Key、`auth.json` 或完整会话记录放进反馈。

## 开发与分发

源码运行需要 Node.js 22 或更新版本：

```console
node src/cli.mjs inspect
node src/cli.mjs launch
node src/cli.mjs verify --artifacts artifacts
node --test
```

`verify` 用独立配置和测试 Key 向本地模拟接口发请求，检查 Standard → Fast → Standard。Windows 会先只读检查沙盒是否就绪。未就绪时，先完成官方 Codex 的正常设置，再运行桌面验证。

使用自己的包路径时，可传入 `--app <路径>`；结构化检查结果可使用 `inspect --json`。

分发包仅包含启动器、文档、许可证和经过校验的 Node.js 运行时，不包含 Codex 程序、个人配置或会话。生成方式见 [分发说明](docs/distribution.md)，参考来源见 [第三方说明](THIRD_PARTY_NOTICES.md)。

开源仓库与 Release 的组织方式见 [开源与发布](docs/open-source-release.md)。模型目录和客户端档位的验证细节见 [Ultrafast 研究](docs/ultrafast-research.md)。
