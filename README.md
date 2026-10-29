# Codex Speed Launcher

独立的 Codex 桌面速度启动工具，让 API Key 和自定义 Responses 接入使用原生速度菜单。兼容 Sub2API 等支持 Responses 和服务档位透传的中转，继续使用已有的地址、Key 和模型。

项目采用 MIT 许可证，源码不依赖 Sub2API。启动器在本次运行中适配客户端；退出后可恢复官方快捷方式启动。

[下载发行版](https://github.com/AkkoForMe/codex-speed-launcher/releases) · [问题反馈](https://github.com/AkkoForMe/codex-speed-launcher/issues)

## 当前验证范围

| 平台 | 状态 |
| --- | --- |
| Windows x64 | `OpenAI.Codex 26.1023.6621.0` 的隔离桌面与本地模拟请求验收通过，覆盖同一聊天的 Standard → Fast → Standard。 |
| macOS Apple 芯片／Intel | 实验支持，未完成 Mac 真机验收。运行前必须通过本机兼容性检查。 |

Codex 更新后，启动器会重新检查资源和补丁位置。检查失败时停止启动，不应把未知版本当作已支持版本。

测试使用本地模拟接口，确认菜单和请求参数一致；真实中转及上游的速度、可用性和费用仍需在使用者环境核对。详细范围见 [验收记录](docs/validation.md)。

## 使用前

1. 安装官方 Codex 桌面应用。
2. 配置自己的中转地址、Key 和模型，先确认普通模式可以正常请求。
3. 确认中转和上游支持所选速度档位。中转需要保留 `service_tier` 参数；过滤规则会让客户端开关无法传递到上游。

启动器不附带账号或 Key，不会替其他人配置服务器。Fast 的可用性和计费由实际使用的中转及上游决定。

## Windows

推荐使用单文件 `codex-speed-launcher-<版本>-windows-x64.exe`。先用 `inspect` 只读检查，再保存工作、完全退出 Codex，双击 EXE 启动。无需安装 Node.js，运行期间保留启动器的控制台窗口。

```powershell
.\codex-speed-launcher-<版本>-windows-x64.exe inspect
```

当前 EXE 为未签名的控制台程序。下载前核对发布来源和 SHA-256；图形设置、托盘和安装向导暂未实现。构建与使用方式见 [单文件 EXE](docs/executable-distribution.md)。

需要保留源码、文档和运行时目录时，可使用便携 ZIP：

1. 解压完整的 `codex-speed-launcher-<版本>-win-x64.zip`，保留 `runtime`、`src` 等目录。
2. 双击 `inspect-windows.cmd`。这一步只读检查，不会关闭正在运行的 Codex。
3. 检查通过后，保存工作并完全退出 Codex，包括后台窗口。
4. 双击 `launch-windows.cmd`，保持启动器窗口运行。
5. 在 Codex 的原生速度菜单中切换 Standard／Fast，再发一条新请求。

便携包已附带固定版本的 Node.js，无需安装 npm 依赖。重新使用时，从 `launch-windows.cmd` 启动。

## macOS（实验支持）

Apple 芯片使用 `darwin-arm64.zip`，Intel Mac 使用 `darwin-x64.zip`。

1. 解压完整的包。
2. 双击 `inspect-macos.command`，先检查本机应用是否兼容。
3. 检查通过后，保存工作并完全退出 Codex。
4. 双击 `launch-macos.command`，保持打开的终端窗口运行。
5. 在原生速度菜单切换档位，用新请求验证结果。

如果 `.command` 没有可执行权限，在包目录执行 `chmod +x ./*.command ./runtime/node`。如果 macOS 阻止打开下载文件，先核对来源和 SHA-256，再通过系统提供的打开方式处理；启动器不会修改系统安全设置。

## 如何确认生效

看到 Fast 图标只能证明菜单可见。还需要检查一条新请求的实际档位：

1. 选择 Standard，发送一条小请求。
2. 选择 Fast，发送另一条小请求。
3. 在中转的用量或费用详情中查看服务档位，并在有权限时核对上游返回的档位。
4. 再切回 Standard，确认后续请求恢复普通档位。

两次请求继续使用同一 Key 和同一模型。Fast 请求通过 `service_tier` 传递；服务端仍可能拒绝或降级，实际记录才是判断依据。本工具当前只适配 Standard／Fast，不新增 Ultrafast 入口。

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

`verify` 创建独立配置和本地模拟接口，不使用真实 Key 或消耗上游额度。Windows 会先只读检查 sandbox 是否就绪；未就绪时跳过桌面验证，需先完成官方 Codex 的正常设置。

使用自己的包路径时，可传入 `--app <路径>`；结构化检查结果可使用 `inspect --json`。

分发包仅包含启动器、文档、许可证和经过校验的 Node.js 运行时，不包含 Codex 程序、个人配置或会话。生成方式见 [分发说明](docs/distribution.md)，参考来源见 [第三方说明](THIRD_PARTY_NOTICES.md)。

开源仓库与 Release 的组织方式见 [开源与发布](docs/open-source-release.md)，Ultrafast 的当前研究状态见 [Ultrafast 研究](docs/ultrafast-research.md)。
