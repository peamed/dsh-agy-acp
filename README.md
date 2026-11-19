# dsh-agy-acp

DeepSeek Harness 插件：把 **Google Antigravity（`agy acp`）** 任务运行为**可观测的后台 job**，权限跟随会话审批，进程带隔离层。

## 长任务的等待体验（v0.4）

agy 任务 10-20 分钟是正常的。v0.4 之前"任务一长就被反馈没返回"的三个成因与对策：

| 成因 | 对策 |
|---|---|
| agy 思考/长工具执行期间 job 环零输出，`job_output` 轮询只见 `(no new output)`，看起来像挂了 | **静默心跳**：子流静默 ≥120s 时生产者向 job 环追加一行 `[agy] alive: no child update for Ns (…); last progress: …`，并刷新 job 行进度。静默变成可见的有界等待 |
| 模型用短等待（默认 30s）反复轮询，第 3 次同参触发 DSH `repeat-tool-reminder`（"try a different approach"），把等待打断 | ① bundle patch 给 `repeat-tool-reminder` 加 `exclude: ['job_output']`（对重复链透明）；② 系统提示改为教模型**一把等到上限**：`job_output(wait: true, timeout_ms: 600000)`（硬上限 10min，`dsh-tool-jobs` 的 `maxWaitTimeoutMs`），并明确"同参重复等待是合法行为，提醒不代表卡死" |
| 模型把"轮询超时/没输出"误判为挂死，提前 kill 接管 | 系统提示明确判定标准：只有输出显示**循环**（连续相同 `[agy:tool]` 行多分钟无进展）或明显跑偏才 kill；静默有心跳兜底 |

提示：`job_output` 的 `wait` 超时不杀任务——返回 running 后重复同样的等待即可。

## 权限分层（对齐官方文档）

官方模型（[Permissions](https://antigravity.google/docs/permissions) / [ACP](https://antigravity.google/docs/ide/extensions/acp/)）：**agy 自己的权限引擎先行**——全局规则（`~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow/deny/ask`，`action(target)` 语法）加上**项目级规则**（交互式 agy 会话里 `/permissions` → Project 作用域，官方支持 Project/Shared/Global 三层）先评估，已 allow/deny 的操作**不会**发 ACP 请求；工作区内文件操作由 agy 隐式放行，沙箱内命令免提示（`toolPermission: proceed-in-sandbox` + `--sandbox`）。

本插件（v0.5）因此只保留一个角色：**桥接兜底**（不可替代）——只接 agy 规则未覆盖的 `session/request_permission`，按**父会话**的 DSH 沙箱模式判定（agy 不知道 DSH 会话边界）+ 项目外路径硬拒绝 + MCP 工具按 `mcpTools` + `deniedCommandPaths` 凭据路径硬拒。**命令的放行/拒绝全部交给 agy 官方权限引擎**：v0.4 之前的三层命令白名单（`safeCommands` / `scriptRunners` / `allowAllCommands`）已在 v0.5 移除，规范做法是把规则写进 agy 的 `permissions.allow/deny`（全局 `settings.json` 或 `/permissions` 的项目作用域）。

推荐布局：

| 层 | 放什么 | 工具 |
|---|---|---|
| agy 全局 `settings.json` | 机器级命令 allow/deny、`.git/` 与凭据路径 deny（官方 `action(target)` 语法） | 手编或交互式 `/permissions` |
| agy 项目作用域 | 某项目特有的规则 | 交互式 agy 会话 `/permissions` → Project |
| 插件桥接 | 只随父会话沙箱模式走；不配置任何命令白名单 | 插件 config（`permission`/`mcpTools`/`deniedCommandPaths`） |

### 实测要点（2026-11-18，agy 1.5.10）

ACP 模式下的权限行为与 App 文档有出入，逐条实测如下，配置前务必知道：

| 事实 | 含义 |
|---|---|
| **沙箱内命令完全免提示**，读类命令（`whoami`/`stat`/`ls`）无需任何 allow 规则 | agy 自带很宽的系统白名单；不给它们配 allow 也不会弹窗 |
| 需要写宿主文件的命令会带 **`BypassSandbox: true`** 发请求——这是"跳出沙箱"，走的是**逃逸审批通道** | `command(名字)` 形式的 allow 规则**对逃逸通道无效**；`touch`/`mkdir` 即便写进 allow 也照样弹 |
| `command(*)` 通配 allow **能**压掉逃逸请求（实测 `touch`/`echo`/`ls` 零请求） | 但它等于**取消所有命令审批**——等于上一版插件的全放行，不建议 |
| `unsandboxed(...)` 规则仅企业版生效，非企业账户被忽略 | 本机账户属于被忽略的一类，别指望它 |
| `deny` 压过一切（Deny > Ask > Allow），实测 deny `command(hostname)` 后立即静默拦截 | 想减免审批又保底线时，用 `command(*)` + 精准 deny 组合，而不是逐条 allow |
| **探测环境会被污染**：若 agy 子进程写不了 `~/.gemini`（例如在别的文件沙箱里跑），它的规则与沙箱会静默退化，命令全部弹窗 | 2026-11-16 那条"permissions.allow 在 acp 模式无效"的记录就是这种假象；排查时必须用完整权限跑 |

结论：想让"读/查类命令"不再弹窗，agy 本来就不弹；会让 agy 弹窗的是**写宿主文件**的动，而这类要么逐条 allow（对逃逸通道无效）、要么全放行。**推荐保持默认**：沙箱内命令免提示，出沙箱动作经桥接由父会话裁决——这正是当前推荐布局。

## 设计取舍（v0.3，纯 job 模式）

实测结论：对 agy 这类一次性外部 agent，subagent seam 的治理红利（可发现性、树状态、可续聊）全部落空——外部孩子在子代理面板是静态卡片、不能追问、完成信号与 job 通知重复。因此 v0.3 回退为**纯 job 模式**，只保留实测有效的增强：

| 能力 | 实现 |
|---|---|
| 知道在执行 | 工具调用立即返回 job id；job 存在即在飞 |
| 实时过程 | `job_output` 增量读取：`[agy:tool]` / `[agy:plan]` / `[agy:permission]` 标记 + 回答原文流 |
| 完成通知 | job 结算后自动送达 owner agent |
| 取消 | `job_kill` → ACP `session/cancel` → stdin EOF → terminate 阶梯（SIGTERM→SIGKILL） |
| 超时兜底 | `timeout_ms` 参数 |
| 权限治理 | `permission: ask` —— 项目内的**文件类**请求按父会话的 DSH 沙箱模式判定（`workspace-write`/`danger-full-access` 放行、`read-only` 拒绝）；**MCP 工具调用**（`call_mcp_tool`）按插件的 `mcpTools` 判定（默认 `allow`）；**命令类**请求仍桥接进会话审批瀑布流由用户裁决；项目外路径直接拒绝；模式不可解析时退回人工（fail closed） |
| 进程隔离 | `isolation: agy-sandbox`（默认，agy 原生 `--sandbox`）或 `bwrap`（根只读 + 仅项目目录可写 + /tmp 私有 tmpfs；代价：agy 的 shell 通道不可用）或 `off` |
| 路径边界 | `withinRoot` 用 `realpath` 解析物理路径，防符号链接穿透（软链指向 `~/.ssh` 等会被拒绝） |

### 经 agy 专家审核后的关键修正（2026-11-16）

- **命令弹窗卡点的真正原因**：`--sandbox` 只打开沙箱，`toolPermission` 默认 `request-review` 导致每条命令仍强制审批。官方正解是 `"toolPermission": "proceed-in-sandbox"` + `enableTerminalSandbox: true`（写入 `~/.gemini/antigravity-cli/settings.json`）：沙箱内命令免审批，出沙箱动作仍发审批经本插件桥接。实测 `prompts=0`。注意 `--mode=auto` 是主命令 flag，`agy acp` 不支持。
- **无效的伪配置**：`allowNonWorkspaceAccess` 不是官方文档中的字段（三份官方文档零命中），已从配置语义中剔除；跨工作区写入应使用 `permissions.allow: ["write_file(/path)"]`。
- **待办（P1）**：在 settings.json 的 `permissions.deny` 加入 `write_file(.git/)` 与凭据路径，防工作区内免审批改动版本历史/敏感文件。

## 用法

```
agy(task: string, timeout_ms?: number) → { job_id, cwd, permission, isolation }
agy_send(session_id: string, message: string, timeout_ms?: number) → { mode, job_id, cwd, permission, isolation }
```

- `task`：完整独立的任务指令（Antigravity 看不到 DSH 会话内容，需要的上下文都写进 task）。插件默认会在首个 prompt 前加一段 `taskPrefix`（建议优先用内置文件工具，因为项目内文件操作零审批、shell 命令可能卡在交互审批）；把 `taskPrefix` 设为 `''` 即完全原样透传
- 返回后 `job_output(job_id)` 看实时进度，`job_kill(job_id)` 取消
- **重要**：task 里建议要求 agy 优先使用内置文件工具（read_file/write_file）而非 shell 命令——项目内文件操作零审批，shell 命令每条都会触发交互式审批（系统提示已让模型自动带上这条要求）

### 补充信息（agy_send）

第一次任务成功建立会话后，job 输出里有一行：

```
[agy] session ready (session: <session-id>, cwd: /path/to/project)
```

把 `<session-id>` 交给 `agy_send` 就能给**同一段 agy 对话**补发消息。它按会话**当前状态**自动选路：

| 会话状态 | 投递方式 | 返回 |
|---|---|---|
| **仍在运行** | 走活连接（同一条 `agy acp` 的第二次 `session/prompt`），agy 把消息并入当前这一轮 | `mode: "injected"`，`job_id` 是**正在跑的那个任务** |
| **已结算** | 新起 `agy acp` + `session/resume({ sessionId, cwd })` + `session/prompt` | `mode: "resumed"`，`job_id` 是**新任务** |

要点：

- **注入不保活**：活连接只在任务运行期间存在，`finally` 里即注销；会话结束后自动改走 resume，不需要 idle 回收。
- **注入的答复会晚到**：实测 agy 把追加入参并进当前轮继续干活，但**不会为注入请求单独发响应**——原请求先返回 `end_turn`（此时文本为 0 字符），答复要再过几秒才流式到达。所以任务结算后会保留进程最多 `sendDrainMs`（默认 30 秒）继续收流，否则答案会随进程一起销毁。输出里的标记是 `[agy:send] queued` → 收尾时的 `[agy:send] folded in (no separate response)`。
- **收尾按"静默"判决，不是固定等待**：结算后至少等 `sendDrainMinMs`（默认 15 秒，给答复起步的时间），之后只要流还在继续就接着收，**静默满 20 秒**才结束；`sendDrainMs`（默认 120 秒）是硬上限，`job_kill` / `timeout_ms` 随时可以中断。
- 两个参数都可调：`sendDrainMinMs` 调大更保守，`sendDrainMs` 调小则更快释放进程。
- **注入的答复不分账**：agy 会把追加消息并进当前轮，返回值只表示"已投递到连接"，不表示"这是它的回答"。读 job 输出时应视为**一条连续的流**。
- **`timeout_ms` 只对 resume 生效**：注入沿用运行中任务自己的截止时间。
- **`cwd` 必须与会话建立时一致**（协议要求），不一致直接报错，不会静默接错。
- **resume 可失败**：agy 丢弃了会话（或 host 重启后插件不记得）时，`session/resume` 失败会回退建新会话，输出里写明 `resume failed (...); starting a new session`。
- **两者都复用 agy 自己的对话历史**，不是 DSH 的上下文——新背景仍要写进 message。

并发注入依赖 agy 的实现行为（实测它接受并合并）。ACP 规范没有定义并发 `session/prompt` 的语义，若未来 agy 改为拒绝，注入会退化为在 job 输出里写 `[agy:send] delivery failed (...)`，任务本身不受影响。

## 配置（插件 row config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `agy` | 每次运行 spawn 的可执行文件 |
| `args` | `["acp"]` | 命令参数 |
| `permission` | `ask` | `ask`：项目内文件类按 DSH 沙箱模式自动判定，命令类仍需人工审批；`allow` 全放行；`reject` 全拒 |
| `mcpTools` | `allow` | MCP 服务器工具调用（`call_mcp_tool`）的处置：`allow` 直接放行 / `ask` 转人工审批 / `deny` 拒绝 |
| `taskPrefix` | 见下方（**默认开启**） | 前置到**每条新任务/恢复任务**首个 prompt 之前的一段开场白。默认值为：`Work with your built-in file tools (read_file, write_file, list_directory, search) instead of shell commands wherever they can do the job. In-project file operations need no approval, but a shell command may pause for interactive approval that a background run cannot answer, so prefer the file tools and keep shell commands to the minimum the task actually requires.` 设成 `''` 即恢复严格原样透传。已存在的同前缀不会重复添加。注入到**运行中**会话的消息（`agy_send` 走活连接）不经过这里。 |
| `deniedCommandPaths` | `~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.git-credentials, ~/.npmrc, ~/.dsh/.env, ~/.gemini/antigravity-cli/settings.json, /etc/shadow, /etc/sudoers` | 到达桥接的命令里出现这些路径即**直接拒绝**，优先级高于一切（含 `permission: allow`）。日志记 `denied path: ~/.ssh`；边界感知，`src/.ssh-helper.ts` 不会误伤。空数组关闭。命令放行本身不在此层配置——写进 agy 的 `permissions.allow/deny` |
| `isolation` | `agy-sandbox` | `agy-sandbox`（agy 原生 `--sandbox`）/ `bwrap`（更强但 agy 的 shell 通道不可用）/ `off` |
| `model` | `''`（跟随 agy） | 会话模型，握手后经 ACP `session/set_config_option` 应用。填 **基础 id**（如 `gemini-3.8-flash`），**不要**填 `...-high` 这种带档位的 id——那是 `models.availableModels` 的写法，强度请放 `thoughtLevel`。填了账号没有的模型会**直接失败**（不静默回退） |
| `thoughtLevel` | `''`（跟随 agy） | 思考强度：`low` / `medium` / `high`（账号支持时还有 `extra` / `max`）。模型没有思考档位时（如 `claude-sonnet-4-6`）会**跳过并报告**，不静默忽略 |
| `mode` | `''`（跟随 agy） | 执行模式：`default` / `accept-edits` / `auto` / `plan`，经 ACP `session/set_mode` 应用 |
| `env` | `{}` | 额外注入子进程的环境变量（如 `GEMINI_API_KEY`） |
| `askTimeoutMs` | 600000 | 审批等待上限，超时自动拒绝 |
| `disposeEofGraceMs` | 6000 | stdin EOF 后的退出窗口 |
| `disposeGraceMs` | 3000 | SIGTERM→SIGKILL 宽限 |

## 前提

- `agy` CLI 已安装且登录过一次（缓存凭据复用；或经 `env` 配置 `GEMINI_API_KEY`）
- profile 含 `tools` / `jobs` / `subprocess` / `workingDirectory` / `systemPrompt` seam（dsh-base 默认全有）

### agy 侧权限配置（重要）

`~/.gemini/antigravity-cli/settings.json` 决定 agy 是否发权限请求（实测，acp 模式下生效的键）：

- **`"toolPermission": "always-proceed"` 会让所有工具调用跳过询问**——审批桥接永远不触发，务必移除（当前已移除，备份 `settings.json.bak.v3-20261116-214953`）；
- `allowNonWorkspaceAccess` 与 `permissions.allow` 命令白名单在 acp 模式下**实测无效**（三种配置位置均验证），不必配置；
- 收紧后的默认规则：工作区外的 File 写入、命令执行 → 发权限请求 → 桥接裁决；项目内 File 操作自洽放行；/tmp 等临时区写入由 agy 惯例放行（无 bwrap 时会落到宿主 /tmp）。

## 空答复会被判为失败

agy 有时以 `end_turn` 结束却**一个字都没输出**——常见于工具调用被拒之后，或中途注入把当前轮结束后新轮被 teardown 切断。这种情况下如果报「成功」，上游只会看到一条空结果。

插件现在会把它改判为失败，并给出可 grep 的原因：

```
[agy] failed: no-answer-text — the run ended without any answer text
[agy] failed: injected-message-ended-turn — the run ended without any answer text
[agy] hint: a message sent while the run was in flight ends the current turn; the follow-up work was cut off here. Send the next message with agy_send on the same session, or wait for settlement before sending.
```

同时把收尾的静默判定从 5 秒放宽到 **20 秒**：模型在两次工具调用之间思考时常有 5-15 秒的静默，旧阈值会把「正在思考」误判成「已结束」。

## 禁止路径优先（deny 高于一切）

到达桥接的命令请求里，少数绝不能碰的路径被直接拒绝：

```
[agy:permission] cat ~/.ssh/id_rsa → denied (denied path: ~/.ssh)
```

- 判定发生在**所有其他分支之前**，包括 `permission: allow`。
- `~` 按 `process.env.HOME` 展开；同时匹配 `~/.ssh` 与 `/home/u/.ssh` 两种写法。
- **边界感知**：marker 后面必须是分隔符，所以 `src/.ssh-helper.ts`、`npm install ssh2` 不会被误判。
- 局限要说清楚：它只看命令行**字面**。`$HOME/.s""sh`、或用脚本自己打开该文件，仍可能绕过。要真边界只能上 bwrap。
- 注意这层只覆盖**到达桥接的**请求：agy 自己权限规则已放行的命令不会发 ACP 请求，桥接无从拦截——所以凭据路径的 deny 也应写进 agy 的 `permissions.deny`（全局层），双层都要有。

## 命令到底由谁放行（v0.5 起）

插件不再有命令白名单。到达桥接的命令请求只有两条出路：agy 官方规则没覆盖到 → 转人工审批；想免人工 → 写进 agy 的 `permissions.allow`（全局 `settings.json` 或 `/permissions` 项目作用域，`action(target)` 语法，如 `command(git)`、`command(regex:npm run (build|lint|test))`）。沙箱内命令本来就不提示（`toolPermission: proceed-in-sandbox`）。

**只靠解析命令行做不到"工作区内命令全放行"。** 一条命令不是路径受限的：`python3 a.py` 里 `a.py` 可能在项目内，但它随时能读写 `~/.ssh`；`npm install` 必须写 `~/.npm`；`git push` 碰的是网络。所以"看起来在项目内"和"实际只会动项目内"是两件事。真正能强制边界的只有**文件系统级沙箱**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **agy 官方规则 + 沙箱**（规范路径） | `permissions.allow/deny` + `toolPermission: proceed-in-sandbox` | 沙箱内免提示；沙箱外按规则或问人 |
| **bwrap 强制** | `isolation: bwrap`，根只读 + 仅工作区可写 | 文件系统级真边界；但 agy 的 shell 通道会因写不了 `bin/agentapi` 而失效（需要额外给 `bin/`、`scratch/` 挂 tmpfs，即之前评估过的 P2），且 HOME 缓存目录会 `EROFS` |

## 可重试的后端拒绝

agy 有两类东西会走**答复通道**（ACP 只有 `agent_message_chunk` 这一个下行口）：

**1. 重试通知（不是答复）。** 遇到 503 容量不足、429、流中断时，agy 在进程内按指数退避重试，每次往流里写一行：

```
⚠ API error (attempt 3): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server
```

CLI 模式这些行只进日志文件，终端只显示最终结果；ACP 模式下它们就是普通 chunk。插件现在把它们**分流**出去，不混进答复：

```
[agy:retry] attempt 3: UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server
```

- 答复长度只统计**答复本身**，重试行不计入（此前 5 次重试会把「一句 OK」撑到 600 字符，直接把下面的拒绝判定撑失效）。
- 通知行前导的 `\n` 属通知自身，会被丢掉；答复里的 Markdown 段落空行保留。
- 重试后仍拿到答复 = **成功**，`detail` 记为 `stop reason: end_turn (N retry notices)`，不再误判成失败。

**2. 终端拒绝（真的没答复）。** 拒绝会以普通文本结束本轮，插件改判为**可重试失败**：

```
[agy] failed: retryable backend-capacity (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)
[agy] hint: retry the same task; if it repeats, check the Antigravity proxy exit node or quota
```

- job 结算为 `failed`，`detail` 形如 `retryable: backend-capacity` / `retryable: backend-unavailable` / `retryable: backend-quota`。
- 判定顺序：**先剥掉重试通知，再看答复本身**。有答复 → 整条答复很短（≤250 字符）且命中拒绝特征才算拒绝；无答复 → 通知里出现拒绝特征即判拒绝（多条通知累加超过 250 字符也照样能认出来）。
- 所以「重试后成功」与「重试到放弃」是两种不同结果，不再取决于重试了几次。
- 上游模型看到 `retryable:` 会重试同一任务一次；再次出现则上报并指向代理出口，而不是无限重试。

> 容量 503 与出口地区有关：`No capacity available` 是 Google 侧的真实容量波动，与 ACP 无关（CLI 同样会撞上，只是被重试藏住了）。等一会儿或换出口节点通常就好。

## 模型与思考强度透传（v0.7）

`agy acp` 在 `session/new`（以及 `session/resume`）里以 `configOptions` 暴露两个选择器，另有一个 `modes` 块。**客户端不发请求它们就不生效**——v0.7 之前插件完全没有透传，跑的一直是 agy 自己 `settings.json` 的设置。

实测（agy 1.5.10，`session/new` 返回）：

```json
"configOptions": [
  { "id": "model",         "category": "model",         "type": "select",
    "currentValue": "gemini-3.8-flash",
    "options": ["gemini-3.8-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"] },
  { "id": "thought_level", "category": "thought_level", "type": "select",
    "currentValue": "high", "options": ["low", "medium", "high"] },
  { "id": "mode",          "category": "mode",          "type": "select", "options": ["default", ...] }
]
```

用法（插件默认，或单次覆盖）：

```yaml
- id: agy-acp
  config:
    model: gemini-3.8-flash
    thoughtLevel: high
    mode: plan
```

单次任务覆盖：`agy` 工具入参 `model` / `thought_level` / `mode`，优先级高于插件配置。

### 四个必须知道的实测坑

1. **`model` 的值是"基础名"，不是 `availableModels` 的 id。** `configOptions.model.options` 只有 `gemini-3.8-flash`；`models.availableModels` 里才是 `gemini-3.8-flash-high`。把带档位的 id 传给 `model`，agy 会接受但**只把 `thought_level` 改掉**，`config.model` 仍停在基础名。
2. **必须先切模型，再决定强度。** 切到 `claude-sonnet-4-6` 后 `thought_level` 会**从选项里消失**，此时再发 `thought_level` 会被拒：`Thinking level "high" is not offered for model "Claude Sonnet 4.6 (Thinking)"`。所以强度是**延迟应用**的——先发模型切换，用**它返回的** `configOptions` 判断还剩哪些档位。
3. **`session/set_mode` 返回空对象 `{}`**，不回显状态；而 `configOptions` 里那份 mode 在设置后仍是旧值。因此实际生效的 mode 由插件自己记录。
4. **`models.currentModelId` 在改过配置后会变成 `undefined`**，别拿它判断是否生效；唯一可信的回显是 `configOptions[].currentValue`。

运行时会打印一行生效状态，不开盲盒：

```
[agy:config] model=gemini-3.8-flash thinking=high mode=plan
[agy:config] thinking level "high" not applied (the selected model exposes no thought_level)
```

失败语义：账号没有的模型 / 档位 / 模式 → job 结算为 `failed`，`detail` 形如
`agy session config rejected: Model "x" is not offered for this account; offered: gemini-3.8-flash (Gemini 3.8 Flash), …`
**不会**静默降级成默认值，也不会冒充"agy 没装好"。

## 测试（`test/`）

一条命令跑完：

```bash
node test/all.mjs          # 纯单测，秒级、离线、确定性
node test/all.mjs --e2e    # 追加真实 agy 的端到端（需登录态 + 网络，数分钟）
node test/all.mjs --list   # 列出三层各自包含哪些文件
node test/all.mjs --only=backend,session-config   # 只跑指定文件
```

三层不是随意划分的：

| 层 | 内容 | 为什么单独一层 |
|---|---|---|
| **unit**（默认） | `backend` / `commands` / `drain` / `policy` / `report` / `session-config` / `probe-failure-modes`（stub 驱动） | 纯函数与 stub 驱动的结算逻辑，秒级、离线、确定性。合入前必须全绿 |
| **e2e**（`--e2e`） | `probe-config-e2e` / `probe-retry-e2e` | 驱动**真实插件 + 真实 agy**。要登录态和网络，分钟级，且可能撞上模型端 503（探针本身容忍重试）。**只有这层能发现 tool schema 不合法、tool 返回值不是无损 JSON 这类问题**——单测完全看不见 |
| **probes**（从不自动跑） | 其余 `probe-*.mjs` / `smoke.mjs` / `task-prefix.mjs` | 一次性调查脚本，问的是已经回答过的问题（规则文件是否注入、沙箱行为、命令跑在哪个模型上……）。保留可查，但不适合当回归套件 |

这套分层是被真事逼出来的：v0.7 开发中，`session_config` 缺 `additionalProperties: false` 会让 `defineTool` 直接抛 `UNSUPPORTED_SCHEMA`（插件加载失败），而 `session_config` 带 `undefined` 会让 DSH 报 `value is not lossless JSON`——两个都只在 e2e 层暴露，单测全绿。

## 已知边界

- 每次调用 = 全新 `agy acp` 进程 + 新 ACP 会话（无会话复用/续聊）
- thought 流不透传；只镜像 committed 文本、工具调用与计划
- 子进程经 subprocess seam 启动（父环境凭据被净化）；agy 自身的文件/命令操作由它的权限系统 + 上述策略管
- `isolation: agy-sandbox` 不做文件系统级硬隔离（/tmp 写入会落到宿主）；需要硬隔离用 `bwrap`（接受 shell 通道不可用）
