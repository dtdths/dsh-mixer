# 多会话 / 多 agent 界面对照调研（dsh-mixer 的定位）

调研日期：2026-10-28
调研对象：本仓库（`README.md` / `docs/spec.md` / issue #1 / 全部 ADR）、DSH 宿主 checkout
`/Users/user/Documents/code/deepseek-harness`（`0.2.1-rc.2` / `687f282`）、npm registry、GitHub、
以及各产品的官方文档 / CHANGELOG。

**证据分级（全文使用）**

- **✅ 已亲自核**：本机直读源码（`path:line`）、npm registry API、GitHub API、或官方文档/CHANGELOG 原文。
- **◐ 二手但有一手 URL**：来自并行调研代理，链接指向官方源，但我没有独立复核。
- **✗ 未能取得一手证据**：网络不可达或只有营销页；不据此下结论。

> 说明：本机访问 `code.claude.com` / `developers.openai.com` 分别被 301 与 403 阻断，故 Claude Code 一侧
> 改用官方仓库的 `CHANGELOG.md`（一手），Codex 一侧只能确认其 README 指向云 agent。

## 一句话结论

**「多会话并排」在 2026 年已经不是空位，连 DSH 生态里都已有至少三个同类插件。** 调音台的差异不在"并排"
这个形式，而在**同时具备两件事**：① 每格是**完整、可继续输入**的真实会话；② 有一个**显式的"谁在等我"队列**
（顶栏「N 个通道在等你」+ 格内亮灯，与宿主左侧会话行同源判据）。就目前掌握的证据，这个交叉点只有
VS Code 的 Agents window 摸到边，而它没有全局队列；生态内的近邻各自只占一半（网格 or 队列）。

## 1. 这个插件做什么 / 解决什么痛点

- **一屏横向并排多个真实会话**：每格（术语：**通道**）是完整对话记录 + 官方输入框，草稿互不干扰
  （`README.md`「它做什么」；`docs/spec.md` §1）。
- **把「谁在等你」变成可见信号**：等待时头部亮琥珀竖条，顶栏汇总「N 个通道在等你」；四档状态（等待 / 执行中 /
  子代理运行中 / 已完成未读）与宿主左侧会话行**同源、同判据、同词汇**（`docs/spec.md` §4.3b）。
- **注意力工具**：solo（其余压成 64px 窄条，§5.7）、移出（`×`，不停止任务，§5.3）、通道间跳转快捷键
  `Cmd/Ctrl+Alt+1..9` / `]` `[`（§5.6）、拖拽排序与拖宽并持久化（§4.1 / §5.4）、归档可撤销（§5.2）。
- **不打断的细节**：新建会话不离开调音台（ADR-0003）、「常规视图」落到当前通道（§5.1，v1.6.0）、
  调音台内点文件链接先切到该格会话再打开（§7.4 / ADR-0004，v1.6.x）。

**痛点原话**（`README.md`「为什么需要它」）：并行推进三四个需求时，切走的那几格若卡在**等待审批 / 等待计划确认 /
有个问题要你回答**，"它们就安静地空等 —— 你不知道，机器也停在那儿"。

**边界**（`docs/spec.md` §1）：只做插件不改宿主；桌面 Web 优先；无 OS 通知；不是任务编排器（不派活、不做 DAG）；
solo / 移出不持久化。

## 2. 宿主 DSH 本来有什么（✅ 源码核对）

| 能力 | 位置 |
| --- | --- |
| 每会话状态 `{running, pendingInteraction, completionUnread}` | `packages/client/ui-session/src/client/index.ts:59-67`，`useSessionStatus` `:70-72` |
| 等待 kind 三种：`approval` / `plan-review` / `question`（可声明合并） | `ui-session/src/client/index.ts:41-57`；`ui-approval/src/client/contract/slots.ts:76`；`ui-user-questions/src/client/contract/slots.ts:228` |
| 侧栏行只认这三种 kind | `ui-workspace/src/client/tree.ts:35,379-389` |
| 行投影 = pending + running + 子代理数 + 已完成未读 | `tree.ts:50-59`；状态点 `ui-primitives/src/StateDot.tsx:9` |
| 工作区分组 / 置顶 / 归档置灰 / 标题+内容搜索 | `tree.ts:432-470`、`:542-560` |
| 子代理**不**进侧栏树，以右栏 chat 标签打开 | `tree.ts:244`；`ui-subagent/src/client/sidebar-chat/index.tsx:155-170` |
| 面板导航 = `sidebar.panellist` → `selectPanel(id)` | `ui-sidebar/src/client/index.ts:70-88` |
| `main` 是 keyed/root，**除保留键外不绑会话**；插件可自行 `SessionProvider` 包子树 | `ui-layout/src/client/index.ts:73`；`ui-slots/src/index.ts:349-366` |
| 宿主自带的 main 占位者只有 3 个（会话 / 插件管理 / 计划），**没有**并排多会话视图 | `extensions/cordis-client-runner/src/client/slot-catalog.ts:2137-2141` |

**推论**：DSH 从底层就支持"一屏多会话"（`SessionProvider` + `renderFactorySlot('conversation.content')`，
`ui-subagent` 已有先例），所以调音台**不需要改宿主**；但也说明"能并排"本身不是门槛。

## 3. DSH 生态里的同类插件（这是最有价值的一节）

**先看时间线（会把结论的语气改掉）**：npm 首版日期 —— `multiple-chat-panels` **2026-08-18**、
`dsh-activity-pane` **2026-08-29**、`dsh-workspace-split` 2026-10-24；本插件建仓 **2026-10-14**（首个提交
`d26c7d2`，✅ `git log --reverse`）。也就是说：**这不是我们开辟的品类，我们是后进者**（同类比我们早约两个月），
`dsh-workspace-split` 则比我们晚 10 天。这决定了定位只能是"在既有品类里做得最完整/最可靠"，而不是"填补空白"。

| 插件 | 形态 | 与调音台的关系 | 证据 |
| --- | --- | --- | --- |
| **`multiple-chat-panels` 0.1.2**（MIT，2026-08-18 首版） | "Mission Control grid"：把多个 agent 会话并排、可交互 | **最接近的同类**；README 仅一句"view and interact with several Agents side by side"，**未提等待信号** | ✅ npm registry（4 个版本，最后更新 2026-09-25）；◐ 其实现方式（`uiConversation.binding` + `shell.overlay`）来自代理 |
| **`dsh-activity-pane` 0.18.0**（MIT，2026-08-29 首版，20 个版本） | 可贴边、可滚动的**活动会话总览窗格**：运行中 / 等你处理 / 已完成 / 出错卡片，点击跳转 | **"谁在等我"这半已被它解决**；但它是**只读窗格，没有每格输入框** | ✅ npm registry（含中文描述原文） |
| **`dsh-workspace-split`**（MIT，2026-10-24 建仓） | "split grid of live sessions, each cell typable" | 同类，但**早期**：2 star、未发布 npm、README 取不到 | ✅ GitHub API（描述/建仓时间/许可） |
| `@nanmicoder/dsh-agent-teams` 0.1.27 | 多 agent 团队协作 + 树形监视 | 邻域但不同问题（团队编排） | ◐ 代理 |
| `dsh-plugin-catalog`（社区目录，7406 条）/ npm `dsh-plugin` 关键词 **10,826 个包** | 分发层 | 说明生态已经很大，不是蓝海 | ✅ npm search API（关键词计数）；◐ 目录条目数 |

宿主侧的分发事实（✅）：上游**没有**官方插件目录；`Discover` 市场默认禁用、只读**用户自己添加的**索引源
（`experimental/plugin-market-bundle/README.md:12`）；安装走 npm / `github:` 源。

## 4. 其他产品（跨出 DSH）

### 4.1 AI 编辑器 / IDE

| 产品 | 同时可见 | 逐会话"需要你" | 一屏并排 | 要点 | 证据 |
| --- | --- | --- | --- | --- | --- |
| **Cursor 3.0 Agents Window + Agent Tabs**（2026-04-02） | ✅ | ◐ | ✅ | 官方原文："view multiple chats at once, **side-by-side or in a grid**"；多 agent 跨本地/worktree/云/SSH | ✅ changelog |
| **VS Code + Copilot Agents window** | ✅ | ✅ | ✅ | "**Arrange parallel sessions in a two-dimensional grid**"；会话列表带状态；"**Approval prompts count as waiting for input**" | ✅ docs |
| Zed Parallel Agents | ✅ | ✅ | ✗ | Threads 侧栏 + 每线程状态；agent 等你时系统通知（`agent.notify_when_agent_waiting`），但一次只显示一个 | ◐ |
| Devin Desktop（原 Windsurf） | ✅ | ✅ | ◐ | "Agent Command Center" 按状态分列、含"needs your attention" + OS 通知 | ◐ |
| JetBrains Air（alpha） | ✅ | ◐ | ◐ | "track unread updates"；云端灰度 | ◐ |

### 4.2 编排类 GUI

| 产品 | 形态 | 与调音台的差别 | 证据 |
| --- | --- | --- | --- |
| Conductor | Mac 应用，一个 workspace 一个 agent，跑 Claude Code/Codex/Cursor/OpenCode | 一屏一 agent，靠切换 | ◐ |
| Vibe Kanban | 任务看板 + 列表，10+ agent CLI | **有队列**（看板列），但一次只有一个对话，不是并排 | ◐ |
| claude-squad | tmux + worktree 的 TUI，会话列表 + 预览/diff | 列表式，非并排 | ◐ |
| Uzi | `uzi ls -w` 带 STATUS 列、自动确认、广播 | 列表式 | ◐ |
| Omnara | 从"手机批准 Claude Code"转为托管 agent 平台 | 关注"远程批准"，非并排 | ◐ |
| Sculptor / Devin 云 / OpenHands Cloud | 多 workspace / 会话列表 + 状态 | 列表或切换式 | ◐ |

### 4.3 CLI agent 本体

| 产品 | 结论 | 证据 |
| --- | --- | --- |
| **Claude Code** | **已经有"两个半边"**：① `claude agents`（agent view，**research preview**）= 全屏**列表**，按 Pinned / **Needs input** / Working / Ready for review / Completed 分组，Space 预览确切问题、Enter 进入；② 任意会话底部常驻 `← N agents` 计数；③ **`claude agents --json`** 直接给 `state`(working/blocked/done/failed/stopped)、`status`(busy/waiting/idle)、**`waitingFor`**("permission prompt"/"input needed"/"sandbox request"/"worker request"/"dialog open") —— 等待检测已经是**机器可读原语**。并排方面：Desktop 的 **Split view 只有 2 格**且无每格角标；唯一真 N 格是实验性的 **agent teams**（tmux/iTerm2 分栏、按 teammate，需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）。云侧 Projects（**public beta**）的 Overview 按 Working / Waiting on you / ready for review 分组，是最接近"跨会话状态板"的东西。 | ◐ 官方域被 DNS 黑洞，来自**同日镜像** `pleaseai/claude-code-docs`（2026-10-28）；`claude agents` / agent view / waiting 计数另有 ✅ 官方 CHANGELOG 原文佐证 |
| **OpenAI Codex** | CLI 仍是"一终端一会话" + `codex resume` / `codex cloud`（浏览活跃/已完成云任务）；IDE 扩展一次一个 chat、**没有网格**；App 已并入 ChatGPT 桌面（2026-07-09），单主窗格 + worktree 并行。等待感知是**外挂**：系统通知可分别开关"完成 / 权限 / 提问"，另有 **Pets 浮窗**（一个头像显示 Running / Needs input / Ready / **Blocked**）与 Codex Micro 硬件的 Agent Keys（最多 6 个会话状态 + 切换）。**没有** N 格并排 + 每格角标。 | ◐ 官方域 403，来自 `learn.chatgpt.com` 镜像；README 指向云 agent 为 ✅ |
| 终端玩法（tmux / ccmux / agent farm） | 原生 tmux 只有窗口标记，**没有语义级"卡在审批"**；ccmux 的卖点恰恰是"jump to the one that needs you" | ◐ |

## 5. 交叉点：谁同时做到「每格完整对话」+「等你队列」

| | 逐会话**完整对话**（可继续输入） | **显式**"谁在等我"队列 | 两者同时 |
| --- | --- | --- | --- |
| dsh-mixer | ✅ | ✅（顶栏汇总 + 格内亮灯 + 点一下全部放回） | **✅** |
| VS Code Agents window | ✅ | ◐（有 waiting 状态与状态列表，**无**全局队列） | 接近 |
| Cursor 3.0 | ✅ | ◐ | 接近 |
| dsh-activity-pane | ✗（只读窗格） | ✅ | 各占一半 |
| multiple-chat-panels / dsh-workspace-split | ✅ | ✗（未见等待信号） | 各占一半 |
| Vibe Kanban / Devin Desktop | ✗ | ✅ | 各占一半 |
| Claude Code（agent view + Desktop split + agent teams） | ◐（列表；Desktop 只 2 格；N 格仅实验性 agent teams/tmux） | ✅（Needs input 分组、`← N agents`、`--json` 的 `waitingFor`） | 接近：两个半边都有，但**不在同一个界面里** |
| tmux 玩法 | ✅ | ✗ | 一半 |

## 6. 结论：护城河在哪，风险在哪

**不是护城河的东西**

- "多会话并排"本身：Cursor 3.0、VS Code、`multiple-chat-panels` 都做了。
- "有等待信号"本身：宿主已有（`pendingInteraction`），`dsh-activity-pane` 已经把它做成独立窗格；
  **Claude Code 更进一步，把等待态做成机器可读原语**（`claude agents --json` 的 `state` / `status` /
  `waitingFor`），所以"检测谁在等你"这件事本身没有任何门槛。

**真正的差异（可守）**

1. **两件事同时做到**：并排的**完整会话**（不是只读卡片）+ **全局等你队列**（不是每格一个角标）。上表里没有第二个产品同时满足。
2. **与宿主同源判据**：灯用的是 `SessionStatus.pendingInteraction` 的同一套 kind 与同一个投影，用户不会遇到"左边亮右边不亮"。
3. **围绕注意力的完整交互**：solo（压窄条但**保留状态点与亮灯**）、移出（不停止任务）、跳转快捷键、拖宽/排序持久化、归档撤销、退出落到当前通道、调音台内点文件链接先切会话再打开 —— 这些是把"并排"变成"能长期干活"的部分，也是**14 轮用户实测反馈**磨出来的（`docs/spec.md` §9.0x）。
4. **工程质量与可维护性**：110 个用例 + 冷启动守卫（防"冷启动炸整页"）+ 宿主契约漂移哨兵 + 100KB 级 spec/ADR。同类插件多在 0.1.x、单文件、无测试。

**风险（诚实说）**

- **我们是后进者**：同品类的两个主要插件都比本仓早约两个月（见 §3 时间线），说明需求是真的，但也说明"先发"这张牌不在我们手里；差异化只能靠"完整 + 可靠 + 细节"，且需要被持续验证。

- **同质化**：`multiple-chat-panels` 已经占住"网格"的心智；`dsh-activity-pane` 占住"注意力列表"。调音台如果只是"又一个网格"，很容易被比较成"功能更多但更重"。
- **护城河靠细节与维护**：1、3、4 条都是"持续磨"才有的，但每一轮都可能被模仿；2 条依赖宿主 API，宿主一改就要跟（已有 host-contract 哨兵兜底）。
- **上游可能自己补**：如果 DSH 官方把"活动总览"或"多会话 grid"做进宿主（它的 slot 体系完全支持），插件价值会被压缩 —— 这正是 ADR-0001 一类"只读宿主、不写宿主"决策的长期风险面。
- **窗口在从两侧收窄**：左边是生态里的同类插件（比我们早两个月），右边是 Claude Code 正在把"列表/队列"（agent view）与"并排"（Desktop split、agent teams 分栏）分别补齐。一旦有人在**同一个界面**里把这两半合上，调音台就只剩"DSH 生态内"这一个差异 —— 而这个差异的价值取决于 DSH 的用户规模。

**如果只给一条行动建议**：把「全局等你队列」做成**可跨视图/跨窗口**的第一公民（比如顶栏常驻 + 快捷键跳"下一个等你"的通道），而不是只做当前屏的汇总 —— 那才是上表里没人守的位置；并让 `dsh-activity-pane` 那类只读窗格成为**互补**而不是对手（它适合"总览"，调音台适合"就在这儿处理"）。

## 附录：关键引文

- Cursor 3.0 changelog（✅ 直取）："Agent Tabs allow you to view multiple chats at once, side-by-side or in a grid."
  <https://cursor.com/changelog/3-0>
- VS Code Agents window 文档（✅ 直取）："Arrange parallel sessions in a two-dimensional grid to monitor progress and
  compare results."；"Approval prompts count as waiting for input and keep the container running."
  <https://code.visualstudio.com/docs/agents/run/agents-window>
- Claude Code 官方 CHANGELOG（✅ 直取）："Fixed some sessions showing as **waiting on you** when the last message only
  mentioned items waiting on you mid-sentence"；"the **count of agents waiting on you** still shows"；"Background
  sessions: … **park a 'needs input' request in the agent view** when no client is attached"。
  <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>
- Claude Code（◐ 同日镜像 + ✅ CHANGELOG 交叉）：agent view 分组 Pinned / Needs input / Working / Ready for
  review / Completed；`claude agents --json` → `state` `status` `waitingFor`；Desktop Split view = 2 格；
  agent teams 分栏需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`。镜像：`pleaseai/claude-code-docs`；
  交叉证据：<https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>（`← N agents`、
  "count of agents waiting on you"、"park a 'needs input' request in the agent view"）。
- Codex（◐ 镜像）：系统通知可分别开关"完成/权限/提问"、Pets 浮窗显示 Running/Needs input/Ready/Blocked、
  Codex Micro Agent Keys 最多 6 个会话。<https://learn.chatgpt.com/docs/codex/notifications>、
  <https://learn.chatgpt.com/docs/pets>
- npm registry（✅ 直取）：`multiple-chat-panels@0.1.2`、`dsh-activity-pane@0.18.0`（含中文描述）、
  `keywords:dsh-plugin` 共 **10,826** 个包。<https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin>

## 未能核实（不据此下结论）

- **Codex 的多会话呈现形态**：官方域 403；本节内容取自 `learn.chatgpt.com` 镜像（2026-07/10），措辞可能与线上不同。
- **Claude Code Desktop 的会话侧栏是否已有逐会话的等待/审批角标**：文档只写了"完成时才发系统通知"，两侧都未证实。
- **`claude agents --json` 的字段是否稳定**（是否标记为 preview API）：镜像文档未说明。
- **`multiple-chat-panels` 是否已有等待信号 / 是否支持每格 composer 之外的注意力交互**：README 仅一句，
  内部实现只有代理的转述。
- **`dsh-workspace-split` 的完整功能**：README 取不到；只有仓库描述与元数据。
- **JetBrains Air / Conductor / Vibe Kanban / claude-squad / Uzi / Omnara / Sculptor / Devin Desktop 的细节**：
  均来自代理的一手 URL，未逐个复核；表中相应单元格标 ◐。
