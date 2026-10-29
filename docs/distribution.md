# 分发包生成与校验

分发包面向已安装官方 Codex、已配置中转连接的使用者。项目自身没有 npm 运行依赖，便携包附带 Node.js `24.22.2` LTS。该版本发布于 2026 年 10 月 28 日，并作为本次交付的固定构建输入；后续更新需要重新核对官方来源和哈希。

## 构建

在项目目录运行：

```console
node --test
node scripts/package.mjs --target all --source
```

输出目录默认为 `dist/`：

| 文件 | 用途 |
| --- | --- |
| `codex-speed-launcher-<版本>-win-x64.zip` | Windows x64 便携包 |
| `codex-speed-launcher-<版本>-darwin-arm64.zip` | Apple 芯片 Mac 实验包 |
| `codex-speed-launcher-<版本>-darwin-x64.zip` | Intel Mac 实验包 |
| `codex-speed-launcher-<版本>-source.zip` | 源码与验证用文件，不附带运行时 |
| `SHA256SUMS.txt` | 当前版本已生成 ZIP 的 SHA-256 |

Windows 单文件 EXE 由 `node scripts/build-executable.mjs` 单独构建，输出到同一 `dist/`。它内嵌运行时与许可证，详见 [EXE 构建说明](executable-distribution.md)。Release 工作流会对全部附件重新生成统一的 SHA-256 清单。

只生成 Windows 包：

```console
node scripts/package.mjs --target win-x64
```

只生成源码包，不下载运行时：

```console
node scripts/package.mjs --source-only
```

先查看文件清单，不下载、不写入分发包：

```console
node scripts/package.mjs --target all --source --plan
```

在源码尚未冻结时，可单独下载并校验运行时，不生成分发包：

```console
node scripts/package.mjs --target all --download-only
```

可使用 `--out <目录>` 指定输出目录，使用 `--cache <目录>` 指定下载缓存。已有同名输出时默认停止；确认覆盖本次构建产物后，增加 `--force`。

## 下载校验

首次构建从 [Node.js 官方发布目录](https://nodejs.org/dist/v24.22.2/)下载对应平台的归档，并读取同目录的 `SHASUMS256.txt`。打包脚本同时核对项目内固定的 SHA-256 和下载内容；不一致时停止，不执行下载的文件。之后复用本地缓存时仍重新计算 SHA-256。版本与发布时间见 [Node.js 24.22.2 官方发布说明](https://nodejs.org/en/blog/release/v24.22.2)。

| 运行时归档 | SHA-256 |
| --- | --- |
| `node-v24.22.2-win-x64.zip` | `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2` |
| `node-v24.22.2-darwin-arm64.tar.gz` | `aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a` |
| `node-v24.22.2-darwin-x64.tar.gz` | `d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52` |

包内仅保留运行时可执行文件及原始 `LICENSE`。缓存位于 `.cache/node/`，不进入分发包。

## 包内容与权限

打包脚本采用文件清单：`src/*.mjs`、Markdown 文档、项目许可证、包元数据、对应平台入口，以及校验后的运行时。源码包另含验证文件和构建脚本。不会扫描并打包用户目录。

每个包的 `package-manifest.json` 保存文件大小、SHA-256、模式位、平台及运行时来源。清单本身不包含自身哈希；整个 ZIP 的哈希保存在外部的 `SHA256SUMS.txt`。这些哈希用于发现下载损坏或文件变更，不能代替可信的发布渠道。

ZIP 中的 `.command` 和 macOS `runtime/node` 写入 Unix `0755` 权限，因此可以在 Windows 上生成保留可执行位的 Mac 包。Mac 解压器仍需正确保留这些权限。此项需要 Mac 真机验收，不能仅凭归档元数据声称可正常双击启动。

包内不包含应用签名、Codex 资源、真实地址与 Key、`config.toml`、`auth.json`、数据库、日志或会话。不要手动把本机 Codex 配置复制进准备分享的目录。

## 验证归档

接收者先计算 ZIP 的 SHA-256，与可信渠道提供的 `SHA256SUMS.txt` 对照。

Windows PowerShell：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\codex-speed-launcher-<版本>-win-x64.zip'
```

macOS：

```bash
shasum -a 256 codex-speed-launcher-<版本>-darwin-arm64.zip
```

维护者可对解压后的包运行文件校验：

```console
node scripts/package.mjs --verify-dir <解压后包含-package-manifest.json-的目录>
```

随后运行包内的只读 `inspect` 入口，再按 README 验证速度菜单和实际请求。发布记录应分别注明源码检查、自动验证、Windows 桌面验收、上游请求验收和 macOS 真机验收，不把一种检查替代另一种。
