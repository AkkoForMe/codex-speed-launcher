# Mac 简约小窗

Mac 应用与 Windows 小窗展示相同的状态信息和按钮，界面使用系统 AppKit，应用包附带 Node.js 后台。双击 `.app` 即可打开，无需安装 Node.js、npm 或 Electron。

## 使用

1. 在 [v0.2.4 发布页](https://github.com/AkkoForMe/codex-speed-launcher/releases/tag/v0.2.4) 选择与 Mac 芯片匹配的包。Apple 芯片选择 `darwin-arm64-app.zip`，Intel 选择 `darwin-x64-app.zip`。解压完整的 `.app`。
2. 将应用放到固定目录，再双击打开。首次打开若触发系统下载检查，核对来源和 SHA-256 后使用 macOS 提供的打开方式。
3. 等待只读兼容性检查完成。小窗显示 Codex 版本和配置模型；已有 Codex 进程时，先保存工作并正常退出，再点刷新。
4. 「显示 Ultrafast」可勾选时，勾选后启动或重启 Codex。开关置灰时，查看下方提示。切换供应商或 Key 后，点「刷新状态」。
5. 点「启动 Codex」，随后在原生菜单中选择当前模型支持的档位。

「配置模型」来自当前 `CODEX_HOME/config.toml`，没有设置时读取用户目录 `.codex/config.toml`，不代表当前聊天实际选择。小窗不显示 Key、供应商地址或聊天内容。

## 重启与退出

只有本工具启动的 Codex 可以通过小窗重启。重启、退出和关闭小窗前，先等待任务结束并保存工作；确认后请求 Codex 正常退出。正常退出超时会保留会话和窗口，提示手动处理，不会为了普通重启而强制结束其他进程。

原生界面通过带随机认证凭据的回环连接读取本次后台的状态。关闭或崩溃的清理遵循进程归属规则，只处理本工具启动的进程。

## 验证范围

v0.2.4 的 Apple 芯片版和 Intel 版分别在对应架构的 GitHub Actions 运行器上构建。两份应用包均通过签名完整性、文件清单、内置运行时和小窗模拟检查。小窗验收覆盖 Ultrafast 置灰提示、刷新后可勾选、启动、重启和正常退出。[构建与验收记录](https://github.com/AkkoForMe/codex-speed-launcher/actions/runs/44866697341)

官方 Codex 的原生速度菜单和出站档位仍待 Mac 实机核对。

应用包使用 ad-hoc 签名，尚未使用 Developer ID 证书签名或 Apple 公证，不会修改系统安全设置。
