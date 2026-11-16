# dsh-agy-acp

DeepSeek Harness 插件：把 **Google Antigravity（`agy acp`）** 接入子代理树——**既有标准子代理语义，又有实时过程可见性**。

## 架构

自定义 `SubagentProvider`（名为 `agy`）挂进 subagent seam，行为与官方 out-of-process 后端一致（同样的 spawn → initialize → session/new → session/prompt → 结算路径，直接复用 seam 官方助手 `settleRunResult` / `subprocessRunHandle`）。唯一的行为差异：**官方丢弃的 `session/update` 在这里被镜像到一个后台 job**（owner = 委派者会话）。镜像不是新进程/新连接/轮询，只是同一条事件流上的同步内存写入。

```
模型调用 agy(task)                ← 官方 dsh-tool-subagent 委派工具，provider: agy
   │ 立即返回子代理名（进树、catalog 记录）
   ▼
AgyProvider.start(request)
   ├── 镜像 job（owner = 父会话）→ job_list 可见
   ├── spawn agy acp（subprocess seam）→ ACP 握手 → prompt
   ├── 每条 session/update → fold 最终答案 + job 流式镜像
   └── settleRunResult 结算 → 管理器标准完成通知（最终文本 + stop reason）
```

## 模型侧体验

- `agy(task)` → 返回子代理名；`job_list` 里出现 `agy: <任务>` 的镜像 job
- `job_output(job_id)` 实时看 `[agy:tool]` / `[agy:plan]` / `[agy:permission]` 标记与回答流
- 完成时收到标准完成通知（最终答案 + stop reason）
- `interrupt_agent <name>` 中断（树语义）；`job_kill` 杀镜像同样会取消运行
- 系统提示已说明这套观察约定

## 配置（插件 row config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `agy` | 每次运行 spawn 的可执行文件 |
| `args` | `["acp"]` | 命令参数 |
| `permission` | `reject` | 权限请求应答策略：`reject` 全拒；`allow` 选第一个 allow 选项。不会弹给人 |
| `env` | `{}` | 额外注入子进程的环境变量（如 `GEMINI_API_KEY`），叠加在"凭据净化后的父环境"之上 |
| `disposeEofGraceMs` | 6000 | stdin EOF 后等待子进程自行退出的窗口 |
| `disposeGraceMs` | 3000 | 终止升级（SIGTERM→SIGKILL）宽限 |

委派工具行（`tool-subagent-agy`）：`provider: agy`、`toolName: agy`、`maxDepth: provider-managed`。

## 前提

- `agy` CLI 已安装且登录过一次（缓存凭据复用；或经 `env` 配置 `GEMINI_API_KEY`）
- profile 含 `subagents` / `subprocess` / `jobs` / `systemPrompt` seam（dsh-base 默认全有），且 `@deepseek-ai/dsh-tool-subagent` 已加载（base 默认有）

## 已知边界

- ACP 子代理 execute-once：不能对已结束的子代理追问（上游合约限制，官方后端同样如此）
- 镜像 job 与子代理运行同生命周期；owner 会话销毁时镜像被取消，运行本身由树管理
- thought 流不透传；只镜像 committed 文本、工具调用与计划
