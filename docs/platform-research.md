# 平台启动与隔离验证

## 当前验证范围

| 项目 | 状态 |
| --- | --- |
| Windows `OpenAI.Codex` `26.1023.6621.0` 的注册包、manifest 和路径发现 | 已在本机只读检查 |
| Windows COM 激活辅助代码 | 已编译检查；本模块实现时未调用激活 |
| Windows 进程归属、启动和清理分支 | 自动化测试；真实应用启动结果以整体验收记录为准 |
| macOS 的应用发现、签名检查、进程解析和启动清理分支 | 自动化测试；尚无 macOS 真机验收 |

此表仅描述 `src/platform.mjs` 的验证范围，不代表已完成速度菜单或真实请求验收。

## Windows

通过当前用户的 `Get-AppxPackage` 查找 `OpenAI.Codex` 和 `OpenAI.CodexBeta`，默认优先 Stable。显式指定路径时，路径必须与当前用户的注册包一致。

应用身份检查包括名称、Publisher、Package Family Name、Package Full Name、版本，以及 `AppxManifest.xml` 的对应字段。主程序必须是 manifest 中声明且位于包内的 `Codex.exe` 或 `ChatGPT.exe`；同时检查 `app.asar` 和 `AppxSignature.p7x` 存在。此检查依赖 Windows 的当前用户包注册信息，不会重新安装、修改或重新签名应用。

常规启动使用 `IApplicationActivationManager` 和注册 AUMID。应用已运行时停止启动流程，提示正常退出应用。启动后检查返回 PID 的程序路径、创建时间和本次调试参数；已有进程或身份无法确认的进程不会被接管。

进程清理只针对本次创建且身份仍一致的 PID，在同一个 PowerShell 辅助进程中重新核对路径、创建时间和完整命令行后调用 `taskkill /PID … /T /F`。不会按程序名批量结束进程。`taskkill` 最终仍按 PID 工作，核对与终止之间存在很窄的 PID 复用竞态；本实现不宣称内核级原子终止保证。

普通用户无法读取某个同名候选进程的路径时，常规启动会停止，避免把未知进程当成可接管的应用。隔离验收允许将未知候选加入启动前 PID 快照，但仍要求启动后产生一个身份可核对的新 PID。

## macOS

默认查找 `/Applications` 和 `~/Applications` 下的 `Codex.app`、`ChatGPT.app`。也可显式指定路径。通过 `plutil -convert json -o -` 读取 `Info.plist`，要求 bundle ID 为 `com.openai.codex`，并从 `CFBundleExecutable` 读取主程序名。

启动前调用 `codesign --verify --deep --strict`，并核对 TeamIdentifier `2DC432GLL2`。TeamIdentifier 来自本次参考的官方客户端启动代码；不符合时停止，不提供绕过签名检查或重签名流程。

macOS 直接启动应用内主程序，使用独立进程组。清理只向本次仍在运行的子进程组发送信号。macOS 入口属于实验支持：自动化测试验证了分支行为，真机上的签名、窗口启动、CDP、速度菜单和请求档位仍需验证。

## 隔离验收的必要条件

当前客户端会在启动时自行设置 Electron `userData`。因此，仅传入 `--user-data-dir` 不足以隔离配置。官方客户端自身的隔离启动代码同时设置了以下参数：

```text
CODEX_HOME=<独立的 Codex 配置目录>
CODEX_ELECTRON_USER_DATA_PATH=<独立的 Electron 用户目录>
--user-data-dir=<同一个独立的 Electron 用户目录>
```

`launchApp()` 的隔离分支要求两个绝对路径，并同时设置这两个环境变量和命令行参数。Codex 配置目录不得复用调用环境正在使用的 `CODEX_HOME`。

Windows 隔离验收直接启动已检查的包内主程序，以便把上述环境变量传给新进程。常规 AUMID 激活由 Windows 执行，不保证继承 PowerShell 辅助进程临时设置的环境变量，因此不应使用它验证独立的 `CODEX_HOME`。

## 来源

- [Veath/codexfast](https://github.com/Veath/codexfast) 和 [Kiana-ZY/codexfast-windows](https://github.com/Kiana-ZY/codexfast-windows)：只读包发现、运行时启动和进程归属检查的参考设计，MIT 许可证。
- 官方 Windows 客户端 `26.1023.6621.0`：只读检查 manifest、bootstrap 的 `CODEX_ELECTRON_USER_DATA_PATH` 分支及内部隔离启动参数；未复制完整客户端资源。
