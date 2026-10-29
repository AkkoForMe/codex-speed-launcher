# Ultrafast 兼容性研究

2026-10-29 检查 Windows Codex `26.1023.6621.0` 和随附执行程序 `0.165.0-alpha.1.2`。当前发布版仍只开放 Standard／Fast；本文记录 Ultrafast 的可行性和未完成事项，不表示桌面入口已经支持 Ultrafast。

## 已确认的请求语义

OpenAI API 的 Ultrafast 使用原模型 `gpt-6.1-sol` 或 `gpt-6-astra`，请求字段为 `service_tier: "ultrafast"`。官方文档区分 API 可用性与订阅方案资格，并建议频繁调用工具的应用复用 WebSocket，以减少连接开销。[API Ultrafast 文档](https://developers.openai.com/api/docs/guides/ultrafast-mode)、[Codex 速度说明](https://learn.chatgpt.com/docs/agent-configuration/speed)。

| 选择或参数 | 当前执行程序发出的请求 |
| --- | --- |
| Standard／`default` | 不发送加速档位 |
| Fast／`priority` | `service_tier: "priority"` |
| `fast` 别名 | 规范化为 `service_tier: "priority"` |
| Ultrafast／`ultrafast` | 仅当模型目录声明此档位时保留 `service_tier: "ultrafast"` |

模型名称后缀不是服务档位。本次实验始终保留原模型名，没有创建 `-fast`、`-priority` 或 `-ultrafast` 模型别名。

## 当前客户端的两个限制

客户端已有 Ultrafast 标签、图标、多档菜单和请求解析代码。API Key 接入首先受速度权限入口限制；当前启动器只对该分支返回 Fast 能力，仍明确返回 `ultrafast: false`。托管登录继续使用自身权限响应。

第二个限制在执行程序的模型目录。随附的 `gpt-6.1-sol` 和 `gpt-6-astra` 条目都只声明 `service_tiers: [{ id: "priority", ... }]`，`additional_speed_tiers` 也只有 `fast`。生成的协议将 `additionalSpeedTiers` 标记为已弃用，实际能力使用 `serviceTiers`。因此，只显示 Ultrafast 菜单或只增加旧字段，不能证明请求已选择 Ultrafast。

API Key 是否能够使用某一档位，还取决于实际模型、供应商和上游权限。客户端可见状态不等于上游已经接受或实际提供该档位。

## 本地执行程序实验

使用新生成的配置、虚拟 Key 和本机回环模拟接口。未使用真实凭据，未请求真实模型，未启动或操作桌面窗口，未调用 Windows 沙盒配置接口。每种条件都对两个原模型执行 Standard → Fast → Ultrafast → `fast` 别名 → Standard，共 60 次本地响应。

| 条件 | Ultrafast 的实际出站字段 | 结果 |
| --- | --- | --- |
| 原始随附目录，启用 `ultrafast_mode` | 无 | 静默回到 Standard |
| 仅补 `additional_speed_tiers` | 无 | 旧字段不足以生效 |
| 仅给原模型的 `service_tiers` 增加 `id: "ultrafast"` | `ultrafast` | 传递成功 |
| 两个目录字段同时增加 | `ultrafast` | 传递成功 |
| 只在 `thread/start.config` 指定目录覆盖 | 无 | 执行程序启动后无法这样更换目录 |
| 增加 `service_tiers`，关闭 `ultrafast_mode` | 无 | 功能开关也必须启用 |

成功条件使用官方 `model_catalog_json` 配置入口、启用 `features.ultrafast_mode`，并且只写入生成的测试目录。两个条件缺一时，执行程序都会省略 Ultrafast 字段。原模型、Fast 映射和 Standard 恢复均通过。该结果证明当前执行程序能够传递 Ultrafast；模拟接口立即返回固定答案，不能据此推断真实速度或供应商可用性。

另已验证独立执行程序能够通过本机 WebSocket 启动、完成初始化并返回包含 Ultrafast 的模型目录。未将桌面应用切换到该连接，也未完成桌面 Ultrafast 菜单验收。

## 后续实现的最小范围

建议作为显式实验选项设计，默认启动流程保持现状。允许的模型先限于官方文档列出的两个精确 ID。

1. 从当前生效目录生成临时能力覆盖，保留现有条目，仅给受支持模型的 `service_tiers` 数组增加 `id: "ultrafast"`。不覆盖用户自己的模型目录。
2. 在本次执行程序启动时通过 `-c model_catalog_json=...` 加载临时目录，并通过 `-c features.ultrafast_mode=true` 启用功能，保留原 `CODEX_HOME`、连接配置和历史。只在 `thread/start` 加配置已证实无效。
3. 实验模式对 API Key 的两个速度权限入口同时开放 Ultrafast，再沿用原生菜单和请求解析；托管登录保留自身限制。
4. 在隔离桌面中验证 Standard → Fast → Ultrafast → Standard，核对同一模型、同一 Key、同一聊天和四次实际出站字段，再测试退出恢复。

当前启动器只处理渲染资源，没有已验证的通用入口把额外 `-c` 参数传给桌面内部启动的执行程序。客户端存在外部本机执行服务连接入口，但接入它需要另行管理进程、连接认证、重启和失败清理。此项尚未完成，不能仅添加一个可见开关后作为桌面 Ultrafast 支持发布。

## Fast 体感差异的判断

现有测试确认的是客户端发出了 `priority`。要判断真实效果，还需要核对网关最终发出的档位以及上游实际返回的档位。网关规则可能过滤、改写或拒绝参数，上游也可能降级。

延迟应分别记录首个 token 时间、生成速率和请求总耗时，在相同模型、推理强度、输出长度及连接条件下交错比较多轮。一次短回复不足以区分生成加速、网络连接开销、排队和工具执行。本次未执行真实付费速度测试。
