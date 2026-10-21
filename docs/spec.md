# dsh-mixer v1 实现 spec

> 这份文档是交接物：照着它可以直接把插件写出来，不需要回头问任何待定项。
> 决策来源见 [GitHub 地图](https://github.com/dtdths/dsh-mixer/issues/1)；词汇见 [`CONTEXT.md`](../CONTEXT.md)；踩过的坑见 [`plugin-gotchas.md`](./plugin-gotchas.md)。

## 1. 目标与范围

**做**：把多个会话并排放在一屏里（每格一个**通道**，各有自己的对话记录与输入框），并在有通道等待用户处理（审批 / 计划确认 / 提问）或正在执行时，把注意力正确地引导过去，使「忘切回去」不再发生。

**本期不做**

- 原版会话头那排控件：智能体团队、当前模式、用 xx 工具打开、下载 session 日志（宿主限制，见 §7）。
- OS 级通知、声音提醒。
- 移动端 / 窄屏适配（桌面 Web 优先）。
- 改造 DSH 本体（所有实现只走插件）。
- 语音 / 多媒体通道。
- **UI 文案接 locale 服务**（用户 2026-10-15 定：留作二期）。本期文案硬编码中文，见 §9。

**交付形态**：只装 Client half，**不发布 npm**（`package.json` 是 `private: true`）。三条安装路径：仓库目录 `link:`（开发、热更新）/ git tag `github:dtdths/dsh-mixer#vN.N.N`（冻结版本）/ `.tgz`（离线）。**当前发布版 `v1.5.0`**（此前 `v1.4.0` / `v1.3.0` / `v1.2.0` / `v1.1.0` / `v1.0.0`）：`main` 与 `feat/mixer-v1` 同点，GitHub Release 里有安装命令与验证过的 DSH runtime 版本；步骤见 `README.md`「安装」「发布」。

## 2. 包结构

```
dsh-mixer/
├── package.json          # name=dsh-mixer；dsh.bundle.patch；dsh.client.platform=web
├── cordis.patch.yml      # - insert: [{ id: dsh-mixer, name: dsh-mixer }]
├── index.js              # Host half：export function apply() {}（保持空）
├── client.js             # Client half：全部 UI 与状态
├── locale/{en,zh}.json   # meta.title / meta.description（+ UI 文案）
└── icon.svg
```

`package.json` 的关键字段：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-shortcuts",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-commands",
        "@deepseek-ai/dsh-client-ui-workspace"
      ]
    }
  }
}
```

`dsh.client.inject` 是**加载顺序边**，不是服务注入。它必须包含插件真正会调用的那些包的客户端半 —— 现在包括 `-ui-workspace`（归档/撤销归档走 `ctx.uiWorkspace.*`）与 `-shortcuts`（通道间跳转走 `ctx.shortcuts.register`）。建议同时声明 `-ui-renderer` / `-ui-sidebar` / `-ui-session` / `-ui-slots`（调研报告的建议），使注册顺序稳定。
⚠️ 与 Cordis 的**服务**注入是两回事：真正的服务边写在模块的 `inject: [...]` 里（见 §8 与 `docs/plugin-gotchas.md` §1）——**删掉一条服务边而 handler 仍晚读那个服务，启动不会报错，只在用户点击时抛** `cannot get property "x" without inject`。

## 3. 挂载点

| 用途 | 扩展点 | 关键约束 |
| --- | --- | --- |
| 整屏调音台视图 | `main`（keyed / root） | 用**自己的** key `mixer`；**不可**占用 `conversation`（会替换内置会话面板）。已占用键：`plugins` / `conversation` / `schedules` |
| 视图切换按钮 | `conversation.session.header.utilities`（list / session） | 必须 `order < -10` 才能排在「打开目录」(`open-in-app`, order `-10`) 左侧 |
| `/mixer` 指令 | `ctx.commandUi.register()`（Client 自有命令） | 必须经 `ctx.inject(['commandUi'], scope => …)`，**绝不** `if (ctx.commandUi)`（见 §8） |
| 新建会话 | `ctx.sessions.create({ workspaceId })` + 自己 retain（**不走** `uiWorkspace.startSession`，见 §5.1 / [ADR-0003](./adr/0003-new-session-does-not-leave-the-mixer.md)） | 不触发宿主导航 |
| 归档会话 | `ctx.uiWorkspace.archiveSession(id)`（与侧边栏行动作同一调用，§5.2） | 正在执行的会话会被宿主拒绝，插件按 `workspace/session-active` 识别后行内确认 |
| ~~切换到此工作区~~ | **已删除**：`openWorkspace(id)` 会 reveal → `selectPanel(null)`，在调音台里等于把用户送出去 | — |
| 跳转插件页 / 任务页 | `ctx.layout.selectPanel('plugins' \| 'schedules')` | — |
| 回到常规视图 | `ctx.layout.selectPanel('conversation')` | 点左侧会话行会 `selectPanel(null)`，同样回到常规 |

**每格的会话作用域**：注册 `main`/`mixer` 时声明一个 session 作用域的子槽，注册组件才会拿到 `SessionProvider`：

```js
children: { 'mixer.channel': { kind: 'single', scope: 'session' } }
```

漏掉这条**不会报错**，只是每格渲染不出会话内容（第 1 轮原型就是这么空白的）。

## 4. 数据与状态

### 4.1 通道集合（自持）

调音台**自持**一组「我关注的通道」，不镜像左侧「已打开的会话」。

- 候选池：左侧工作区的全部会话（`useSessions` 的 `list` + `useWorkspaces` 的 `items[].sessionIds`）。
- 选择**持久化**：走框架的 store 持久化约定 —— `defineStore({ persist: 'dsh.mixer.v1' })`（仿 `ui-sidebar-right` 的 `dsh.sidebar-right.v1`）。handle 在 `apply()` 里创建、随 `main` 面板注册（`store: boardStore`），组件只拿 `useStore` / `actions`，从不接触实例。⚠️ **框架的 rehydrate 是裸 `JSON.parse` + setState、没有形状校验**（`store/src/index.ts` 的 `attachPersistence`），所以"损坏数据回落默认"必须**本插件自己做**：`normalizeBoard()` 逐字段兜底（非字符串/重复 id 丢弃，非有限正数权重丢弃，整体不可用即回落"未选"）。"未动过的默认值不写入"由写入时机满足：rehydrate 的那次 setState 是静默的，派生出来的默认值不产生状态变更。状态形状是 `{ channels: [], weights: {} }`，**空数组即"用户还没选过"**。
- 首次进入默认：取会话列表最前若干（原型取 3）。空面板比一个可用起点更差，且用户可立刻改。
- 自动移除：已选通道的会话在左侧被归档（`WorkspacesSnapshot.archivedSessionIds`）或不再属于宿主列表（`list.ids`）时，从调音台移除。**三道护栏**：`list.ids` 为空（列表未就绪）时**不修剪**，否则冷启动会清空面板；刚**撤销归档**的 id 在快照追上之前豁免（宿主 `archivedSessionIds` 比 `unarchiveSession` 的 promise 慢一拍，不豁免会把刚放回的通道再剪掉，见 §5.2 / `restoredSessions` 句柄）；宽度清理同样豁免这条 id，否则通道回来会掉回默认宽度。
- **新建即置顶**（用户 2026-10-15 决定，需求2）：从调音台发起的新建会话插到 `channels` **第 0 位**。同工作区已有**空白**会话时先循宿主语义：它已在通道里 → 移到第 0 位并聚焦其输入框；不在通道里 → 插到第 0 位；都没有才 `ctx.sessions.create({ workspaceId })`。**只有"在调音台里发起的新建"自动进通道** —— 常规视图里建的会话、子代理会话一律不自动加，否则 `×` 形同虚设、通道会被污染。
- **自己建出来的会话要豁免剪枝**（实现发现的必要护栏）：宿主列表要过一拍才会编目新会话，而"自动移除"按 `list.ids` 剪枝 —— 不豁免的话，新通道刚加上就被自己剪掉。故插件自持一份"本次自己创建的 id"集合（插件作用域，非持久化），`id` 一在 `list.ids` 里出现就毕业出集合（一个 `createdSessions` 句柄：`note` / `forget` / `ids`）。
- 手动 `×` 关闭与"外部归档"语义不同：前者是用户主动不看（保留 retain + 顶栏汇总可放回），后者是会话真的不在了。
- **每通道宽度权重也持久化**（用户 2026-10-15 决定：**要记住**）：`weights: Record<SessionId, number>` 与通道集合写在**同一份持久化状态、同一个键**里。解析要防御式 —— 非有限正数回落 `1`，单个坏值不清空整份；通道被 `×` 移出时**保留**权重（放回来还是原来的比例），会话归档或不再属于宿主列表时**清掉**该键，避免无限增长。

### 4.2 Session 引用（retain）

每个通道用**自己的**引用来源持有会话：

```js
// 类型侧：声明合并扩展来源标签（先例：ui-sidebar-right 的 sidebarView）。
// 只在 TS 构建里有意义；运行时起作用的是下面那个字符串。
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { mixerChannel: unknown }
}

const reference = ctx.sessions.retain(sessionId, { source: 'mixerChannel' })
// 每个会话只铸一次，缓存在 Map 里；重复 retain 会重复计数
```

- **绝不复用 `mainView`**：它会让文档标题、侧栏高亮、快捷键解析到调音台里的任意一格（那三处实现都是 `.find()` 取第一个），见 [ADR-0001](./adr/0001-mixer-owns-its-session-reference-source.md)。调音台只**读**由 `mainView` 派生的集合来填充候选池，绝不写。
- **释放时机**：只在**插件卸载**时统一释放；**离开调音台视图不释放**。等待信号只对已 retain 的会话产生，释放即失去"不看它也知道它在等你"的能力。
- **代价**：这些会话作用域常驻（每格 retain 会触发 `Session.open()`），规模由用户的选择集合决定；溢出策略见 §5.4。

### 4.3 等待与执行状态

```js
const status = useSessionStatus(snapshot => snapshot)   // Map<SessionId, SessionStatus>
const entry = status.get(sessionId)
entry.pendingInteraction   // { kind: 'approval' | 'plan-review' | 'question', key, sessionId } | undefined
entry.running              // boolean | undefined（当前执行/思考）
entry.completionUnread     // boolean
```

契约限制（决定 UI 上限，别试图绕过）：

- 每会话**只保留一条**最高优先级的 `pendingInteraction` → **不能显示条数**，徽标只能是 0/1。
- **无历史**：错过就不是"曾经等待"，只有当下。
- **只有被 retain 的会话才有信号** —— 与 §4.2 的不释放策略互为前提。
- `running` 缺信号时回落 `SessionSummary.running`。

### 4.3b 状态词汇与左侧会话行**一一对应**（用户 2026-10-15 决定）

用户原话：「状态要关联左侧侧边栏里会话的状态。左侧会话是 loading，子栏里这个会话就是 loading；等待同理。」据此把宿主侧栏的**全部**状态档位抄全 —— 经核查**不止 loading / 等待两档，而是 5 档**（其中「子代理」那一档既可单独当主状态，也可与前两档**并列**成第二个点）：

| 优先级 | 判据（逐字对应宿主） | `StateDot` | 侧栏文案 |
| --- | --- | --- | --- |
| 1 | `pendingInteraction.kind` ∈ `approval` / `plan-review` / `question` | `warning`（琥珀） | 等待审批 / 计划待审 / 等待回答 |
| 2 | `running` | `ongoing`（转圈） | 进行中 |
| 3 | `runningSubagentCount > 0` | `ongoing`（**并列的第二个点**） | `{n} 个子智能体运行中` |
| 4 | `completed`（= `completionUnread`） | `done`（绿） | 已完成 |
| 5 | 兜底 | `idle`（灰） | 空闲 |

- **判据出处**（实现时照抄，不要自创）：展示优先级 `pending > running > subagents > completed > idle`，见 `ui-workspace/src/client/rows/Rows.tsx:347-397`；字段派生见 `ui-workspace/src/client/tree.ts:397-418`；点词汇见 `ui-primitives/src/StateDot.tsx:9`。`error` 那一档侧栏会话行**不用**，本插件也不做。
- **子代理第 3 档是叠加的，不是替代**：侧栏在有等待或执行中时仍会**并排**画出子代理那个点（`Rows.tsx:389-393`）。本插件同样在状态点右侧再加一个 `ongoing` 点（`size: 10`），tooltip 用侧栏同款「N 个子智能体运行中」。
- **`visiblePendingKind` 白名单**：宿主只把 `approval` / `plan-review` / `question` 三种作为**可见**等待；其它域注册进来的 kind 会被过滤掉（`tree.ts:379-388`）。本插件必须同样只认这三种，否则会把别人域里的信号误当等待。
- **`running` 的回落**：`status.running ?? summary.running`（状态源尚未建立基线时用列表摘要兜底），与 `tree.ts:410` 一致；不要只看 `useSessionStatus`。
- **子代理计数怎么拿**：`runningSubagentCount` **不在** `useSessionStatus` 里，要从会话列表快照算 —— `list.projectionsBySession[id]?.values.subagentCatalog` 里 `running === true` 的子项个数（`list` 就是 `useSessions(state => state)`，`projectionsBySession` 是 `SessionListState` 的公开字段）。算法照抄 `tree.ts:390-395`，**别自造口径**。
- **渲染分工**（保持已认可的观感，只补档位）：等待档继续用头部左侧 2px `state-warn-primary` 竖条 + tooltip（不换成点）；执行中 / 子代理 / 已完成三档用宿主 `StateDot`，画在面包屑之前。`size: 12`；子代理那个并列点用 `size: 10`（主状态点已在旁边时，它明显是"附加"）。
- **空闲档不画点**（用户 2026-10-15 决定，看过后选的）：全档对齐会让每个格子头部常驻一个灰点，实测判定为噪声。因此 **idle 是本插件唯一一处与侧栏的有意偏差**：其余四档必须与侧栏一致，空闲的格子**什么都不显示**。状态判断本身**不简化** —— `channelState()` 照旧返回 `key: 'idle'`，它同时写在每格根节点的 `data-mixer-state` 上（`SHOW_IDLE_DOT` 只控制画不画那个点）。
- **怎么核对**：正式版**没有诊断行**（那是原型的脚手架，已删）。判据落在两处：① 每格根节点带 `data-mixer-state`（`waiting` / `running` / `subagents` / `running+subagents` / `completed` / `idle`），devtools 里一眼可读；② `channelState` 的优先级与配对由 `tests/seams.test.mjs` 逐档钉住（`npm test`）。原型时期的粘贴式读数与「（模拟）」标注留在 `spike/mixer-two-pane` 分支上。
- ⚠️ **`completionUnread` 的语义陷阱**：它由 `ui-session` 内部的 `isMain()`（即 `retainedBy.mainView > 0`）或下一轮 `running === true` 清除（`ui-session/src/client/index.ts:485-505`）。本插件的通道用**自己的** `mixerChannel` 引用来源（§4.2、ADR-0001），**不是** `mainView`，所以"在调音台里盯着这一格看"**不会**把绿点清掉，它要等该会话下一轮跑起来才灭。两选一（见 §9）：接受这个语义（绿点 = "跑完了一轮、你还没把它切回主视图"，对调音台其实合理），或本插件自己维护一份 seen 集合、只在插件内算未读。**v1 取前者**。

### 4.4 会话内容渲染

```js
/* phase/hero 不再写死：空会话要像常规视图那样居中，靠的正是宿主的 hero 相位。 */
renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, options?)
```

**空会话必须与常规视图同相**（用户 2026-10-15 决定，需求1）：宿主对"没有历史、已 open"的会话自己算 `hero = true` / `phase = 'hero'`（`ui-conversation/.../ConversationMainPanel.tsx:41-43`），并由此得到 `.embeddedBody[data-content-phase='hero'] .scrollBody{justify-content:center}`（`ConversationRoot.module.css:534-538`）——**输入框的竖居中是宿主给的，不是插件画的**。v1 把入参钉成 `{ phase:'active', hero:false }`（`client.js:504`），于是空会话里 `active` 相位的 `.composerSeat{position:sticky;bottom:0}` 在内容比容器短时无处可粘，输入框停在滚动区**顶部**、下面全空——这就是需求1 的根因。

- 判定缝 `heroFor(summary)` 返回 `{ phase, hero }`，判据**照抄宿主**，不另造语义。
- 边界（诚实记录）：宿主还看会话快照的 `openState` / `awaitingFirstTurn`；插件只拿得到列表摘要的 `blank`，故 `hero` 用 `blank === true` 近似。差异只可能在"正在重放、hero/docked 未定"的那一瞬：**摘要已经是 blank 时**插件会先画 hero，而宿主此刻在隐藏 composer（对 blank 会话两者最终一致）；**摘要还没有这一行时**插件按 `active` 处理（`heroFor(undefined)`），宁可先给停靠条也不闪一下 hero。
- 380px 窄格里 hero 的品牌标 + 标题是否太吵，看过真机再决定要不要降级成"只居中 composer"。
- **光学位置再抬一点**（2026-10-15 第三轮，用户反馈「虽居中但整体观感偏下」）：空会话的 hero 栈在宿主几何中心之上再抬 `HERO_LIFT_PX = 48` 的一半，即 24px。实现是一条**注入的作用域规则**给宿主稳定的 `[data-composer-seat]` 加 `margin-bottom: 48px` —— 宿主用 flex 居中，底边距把这一项往上推半个值，且**不动布局数学**；**绝不能用 `transform`**：那会让这个盒子成为宿主那些 `position:fixed` 拾取器的包含块（`ConversationRoot.module.css` 明确写了这条）。规则只在 `[data-mixer-pane]`（以及拖拽替身 `[data-mixer-drag-ghost]`，它克隆 hero 身体，需要同一抬升）+ `[data-content-phase="hero"]` 下生效；值是一个常量，观感不合适直接改它。

- **共享工厂**：`conversation.content` 是宿主为多宿主复用准备的工厂，可直接在每格实例化。
- `options.slots.views` 是**局部组件缝**：它的 `renderSlot` 绑定的是**工厂的子槽**，所以只能渲染 `conversation.session`（官方默认实现 `ConversationSessionView` 就是这么做）。**渲染 `conversation.view` 会抛错**（未声明键）→ 整棵工厂子树被卸载，表现为整格空白。
- **视图切换（对话 / 轨迹）不需要上游**：严格会话体接受 `view` 入参（`viewId = view ?? active?.id`），因此"重新渲染时钉住视图"即可切换，无需写别人的 store：

```js
const Views = (props) => props.renderSlot('conversation.session', { view: pinnedView })
renderFactorySlot('conversation.content', input, { slots: { views: Views } })
```

- 视图清单从注册表读：`ctx.slots.entries('conversation.view').map(e => ({ id: e.options.id, label: e.options.label?.() }))`。
- 已知边界：钉住是**每格本地状态**，不写会话自身的视图记忆 → 离开调音台再回来会回到会话记住的视图。若要"点了就记住"，需上游暴露 store 或一个 `selectView` 动作。

## 5. 交互规格

### 5.1 进入与离开

- 入口：会话头按钮（在「打开目录」左侧）+ `/mixer` 指令。两者都调用 `ctx.layout.selectPanel('mixer')`。
- 离开：「常规视图」按钮或点左侧会话行。
- 进入时把左侧栏折叠（见 §7.1），离开时恢复；**常规视图的状态不丢**（宿主保证）。
- **新建会话不构成"离开"**（用户 2026-10-15 决定，需求2；理由与代价见 [ADR-0003](./adr/0003-new-session-does-not-leave-the-mixer.md)）：
  - 插件自己的新建入口不走宿主 `startSession`，而是 `ctx.sessions.create({ workspaceId })` + 自己 retain（§4.1）→ 不触发任何宿主导航，因此不需要抢面板。
  - 宿主的两个入口（56px 轨道上的新建按钮 / `session.new` 快捷键，Web 绑 `primary+alt`）拦不住，改为**窄条件重新断言**：`shouldReclaimPanel({ leftMixer, activePanelId, revealed })` 为真时才 `selectPanel('mixer')`。条件 —— **调音台刚被置空**（`leftMixer`，2 秒时效窗内）、**面板现在确实是空的**（`activePanelId === null`）、且**宿主 `mainView` 现在指向的那个会话是空白的**（`revealed = { id, blank }`）。命中时把那个会话插到第 0 位。**绝不做无条件抢回**：那会把"点侧栏会话行主动离开"也吃掉。
    - 判据为什么是"空白"而不是"新 id"：宿主 `reuseOrCreateBlank`（navigation.ts:185-198）**会复用已有空白会话**而不是新建，而我们自己的 `＋` 恰好就留下一个空白会话 —— 用"是否出现新 id"判断，会在**最常见的连续第二次新建**上漏掉，用户照样被踢回常规视图（这正是需求2 的原症状）。而"点侧栏会话行"走的是**同一个** `replaceMain(…, 'reveal')` + `selectPanel(null)`，区别正在于它揭示的会话**有历史**。
    - 读 `mainView` 派生的集合是允许的（只读，[ADR-0001](./adr/0001-mixer-owns-its-session-reference-source.md)），写它依然绝对禁止。短暂同时有两个 `mainView` 引用时取**空白的那个**（那是 reveal 的目标）。
    - 已知边界（v1 接受）：**故意**点一个空白会话的侧栏行离开调音台时，判据分辨不出，会被带回调音台（侧栏在调音台里是折叠的，行本身要先手动展开才可点）。
  - 重挂代价（必须一并处理）：① 每格滚动位置回顶 —— 不可修，接受；② 「移出」集合（`×` 移出的通道，代码 `parked`）必须移出组件 state 到**插件作用域**，否则弹回；③ 重挂后每格的 composer 都会自动聚焦、最后挂载者赢，必须显式把焦点补到新格。
  - ⚠️ 「切换到此工作区」**已删除**：它调 `ctx.uiWorkspace.openWorkspace()`，走同一条 reveal → `selectPanel(null)`。工作区在 `会话` 浮层左列只承担"跳到哪个工作区 / 在哪个工作区新建"（§5.2）。

### 5.2 统一顶栏（2026-10-15 第二轮重做：方案 B）

顶栏**只承载折叠轨道丢掉的那部分**（见 §7.2）：`调音台` 标签 │ `会话` 按钮（两栏浮层）│ 等待汇总 │ 已移出提示 │ 常规视图。

- **顶栏不出现具体工作区名**（用户决定）：工作区是"新建落到哪"的实现细节，不是顶栏的主语 —— `调音台` 是总体的。
- **`会话` = 两栏浮层**（用户 2026-10-15 选定方案 B；一次性原型见 `docs/prototype/mixer-topbar.html`）：
  - 左列 = 工作区跳转表，**每行自带该工作区的「＋会话」**（2026-10-20 改定；旧的「底部按钮 + 新建落点选中态」已退休，见 §9.0f）：点行 = 右列滚到该工作区分组；**行 hover** 时出淡底 + 行尾 `＋会话`（`data-mixer-new="<workspaceId>"`，与「归档」同一条"hover 才出场"的规矩），点它 = **就在这个工作区**新建会话（新通道仍插到第 0 位，宿主同工作区已有空白会话时先复用）。hover 底色用 `--dsw-alias-interactive-bg-hover`：`bg-layer-1/2` 在浅色主题里是纯白，用它们画 hover 等于没画（会话行的 hover 底色同批换成这个 token）。**没有**「切换到此工作区」（见 §5.1 末条）。
  - 右列 = 搜索框 + 会话多选（勾选即入/出通道，行上带等待标记与「已移出」态）。底部只有一条提示行，**不再有新建按钮**。
  - 搜索：**本地按标题过滤**（即时、零依赖）。走宿主 `sessions.search` 的全文搜索是二期（§9.1）。
  - 关闭：`Esc`、点浮层外、或再点触发器；触发器要有 `aria-expanded`，面板要有 `role`。
  - devtools 可读的钩子：顶栏 `data-mixer-topbar`、触发器 `data-mixer-sessions`、浮层 `data-mixer-session-panel`（左列 `data-mixer-workspace-column`、每个工作区行 `data-mixer-workspace="<id>"`、hover 时才出现的 `data-mixer-new="<workspaceId>"`；右列 `data-mixer-session-column`、搜索框 `data-mixer-search`、每个会话行 `data-mixer-session="<id>"`、行尾归档 `data-mixer-archive="<id>"`）。

  - **字号与按钮感（2026-10-15 第三轮，浏览器实测）**：顶栏整条 13px、`调音台` 标签 13.5/600、chip 11.5px；**`会话` 触发器静止时就带底色与描边**（此前透明，用户原话「无按钮样式」），打开时底色加深。浮层里：工作区行 / 会话行 / 搜索框 13px，分组标题 12px，左列宽 196、右列宽 344。—— 这与 §5.3 头部「不要再做回 11px 那一档」是同一条纪律：**可读性优先于紧凑**。
  - **左列是跳转表（2026-10-15 第三轮；2026-10-20 起是它唯一的点击行为）**：点左列某个工作区，**右列滚到该工作区的分组**（分组带 `data-mixer-group="<id>"`，用 `scrollIntoView({ block: 'start' })`，宿主/环境缺这个 API 时静默跳过）。

  - **已归档的会话不列出（2026-10-15 第四轮，用户反馈）**：右列按宿主 `WorkspacesSnapshot.archivedSessionIds` 过滤，与侧边栏一致 —— 归档行本来就不可打开，之前留在面板里只会得到一次"点了没反应"。过滤只作用于**列表**，不影响已在通道里的会话（那种情况由 §4.1 的自动移除处理）。
  - **悬停行尾出「归档」（2026-10-15 第四轮，用户要求）**：指针移入某行时行尾出现 `归档` 按钮（`data-mixer-archive="<id>"`，行本身 `data-mixer-session`，选通道的勾选/点击区收在 `data-mixer-pick` 里，所以两个动作不会互相误触）。**按钮样式（2026-10-20 用户反馈「和背景一个颜色」后改）**：行内动作（`归档` / `＋会话`，以及确认行的 `停止并归档`）统一用 `--dsw-alias-button-elevated-fill` 做底 + `--dsw-alias-border-l2` 描边 + `--dsw-alias-label-primary` 文字 + 600 字重 —— 它们浮在 hover 底色上，`bg-layer-1/2` 在浅色主题里是纯白、在深色主题里又比 hover 底色**更暗**，所以旧的 `bg-layer-2` 底会让按钮和行底糊成一块。
    按钮**自己还有两态**（2026-10-20 用户追加要求「区分平常态与按钮 hover 态」）：`:hover` 用宿主的 accent wash `--dsw-alias-interactive-bg-hover-accent`（浅 `rgba(38,49,72,.14)` / 深 24% 白）+ `border-l3`，比行 hover 底明显高一档；`:focus-visible` 用 2px `state-business-primary` 焦点环（与插件其它焦点约定一致）。插件没有样式表、按钮又全是行内样式，而**行内样式表达不了 `:hover`/`:focus-visible`**，所以这两态由一条注入规则承担：`[data-mixer-row-action]:hover{…!important}`（`data-mixer-row-action` 是三个动作按钮的共同钩子）。它调的是**侧边栏行动作用的同一个服务**：`ctx.uiWorkspace.archiveSession(sessionId)`（`navigation.ts:272`）；若该会话正在通道里打开，**无需插件额外操作**——归档落进 `workspaces` 快照后由 §4.1 的自动移除关掉那一格。
  - **归档的每一种失败都必须可见（2026-10-15 第五轮）**：用户报"归档按钮点击无效"，而当时处理器只在 console 里失败（同步抛错连 notice 都不会出）。现在三条路都有出口 —— 同步抛错、promise 拒绝、以及**宿主根本没提供 `archiveSession`** —— 全部落到顶栏提示；调用进行中该行显示 `归档中…` 并禁用。教训写在这里：**事件处理器里只 `console.error` 就等于"点了没反应"**。
  - **正在执行的会话先问一次（2026-10-15 第四轮）**：宿主对"有正在跑的工作"会拒绝归档（`workspace/session-active`）。插件的处理与侧边栏同判据：按**错误名**识别（`WorkspaceArchiveError`，客户端插件包不共享错误类身份，见 ui-workspace `index.ts:326`；纯函数缝 `archiveActivityOf` 钉住），然后在**该行下方**给一条内联确认：「这个会话正在执行，归档会先停止它」+ `停止并归档`（`archiveSession(id, { stopActivity: true })`）+ `取消`。宿主的 toast / 确认弹窗是 ui-workspace 私有的，所以这段 UI 由插件自己画；其它失败一律进顶栏提示（`data-mixer-notice`）。
- **顶栏不加独立的 `＋` 按钮**（用户 2026-10-15 决定，仍有效）：新建始终是 `会话` 浮层里的动作，避免顶栏多一个语义相近的控件。**入口位置**在 2026-10-20 由用户改定：从"浮层底部一个按钮（建到当前落点）"改为"**左列每个工作区行的 hover 动作**（建到该行工作区）"—— 见 §9.0f。
- 触发器的文案是 `会话`，有通道时追加数量（`会话 · 3`）；浮层右列按工作区分组、搜索框是 `type="search"`、底部夹一条 `勾选即加入通道`（搜索时变成 `过滤：<词>`）的提示行——这三处是实现时顺手补的可读性细节，不影响上面任何决定。
- **新建失败要在顶栏可见**（`data-mixer-create-error`）：`ctx.sessions.create` 失败时给一条带原因的提示，绝不静默什么都不发生——宿主的 `startSession` 那条路会经通知服务报错，我们这条路至少不能在界面上无声无息（更完整的通知面见 §9.1）。
- **归档可撤销（2026-10-20，issue #12）**：归档成功（含「停止并归档」）后，顶栏出现一条 chip `已归档「<标题>」撤销`（`data-mixer-undo-archive="<sessionId>"`，撤销按钮 `data-mixer-undo-archive-do`），**6s** 后自动消失 —— 与侧边栏归档 toast 的 `LONG_TOAST_HOLD_MS = 6000` 同一个窗口；同一时刻只保留一条（新的归档替换旧的）。点「撤销」调 `ctx.uiWorkspace.unarchiveSession(sessionId)`（侧边栏 `undoArchive` 用的就是同一个服务方法），成功后**把通道放回原来的位置并恢复原宽度权重**；原本不是通道的会话只恢复归档状态。失败三路（同步抛错 / 拒绝 / 宿主没提供方法）一律进顶栏提示 —— 不许出现"点了没反应的撤销"。常量 `ARCHIVE_UNDO_MS = 6000`。
- 等待汇总：「N 个通道在等你」；被 `×` 移出的通道若有在等的，汇总成「已移出 N 个，其中 M 个在等你」，点击全部放回。

### 5.3 通道（每格）

两行头部 + 内容区：

```
┌ [转圈] 调音台插件 / 子任务        [等你] [×] ┐   ← 第一行
│ [对话] [轨迹]                                │   ← 第二行（视图标签）
├──────────────────────────────────────────────┤
│ 官方 composer + 完整对话记录（共享工厂渲染）    │
└──────────────────────────────────────────────┘
```

- **面包屑**：由 `parentId` 上溯生成（最多 6 级、带环保护）；祖先用次级文字，末级加粗。子会话显示成 `父 / 子`。
  **头部尺寸要求**（用户反馈"太小、标题看不清"）：头部行 `padding: 7px 12px`、字号 `12.5px`；祖先面包屑 `12.5px`，**末级标题 `14px`/600 字重**；视图标签 `12.5px`、`padding: 6px 11px`。不要再做回 11px 那一档。
- **状态标记与左侧会话行一一对应**（用户 2026-10-15 决定，判据表见 **§4.3b**）：四档 —— 等待 / 执行中 / 子代理运行中 / 已完成未读 —— 都必须与左侧会话行**同源、同判据、同词汇**；第五档 idle 是唯一有意偏差（**不画点**，§4.3b）。等待用竖条，其余三档用宿主 `StateDot`，全部画在面包屑之前。**不要另造一套状态语义**（例如自定义颜色、自绘转圈、把"完成"画成别的形状）。
- **执行中 loading**：会话正在执行/思考时，在面包屑**之前**显示指示。**直接复用宿主自己的状态点**，不要自绘：

  ```js
  // package.json: dsh.client.external 声明该包，模块表才会提供它
  const { StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')
  h(StateDot, { state: 'ongoing', size: 12 })
  ```

  `StateDot state="ongoing"` 就是左侧栏会话行用的那个 loading（细轨 + 呼吸弧 + 持续旋转），并且**它已自行处理 `prefers-reduced-motion`**，还会把并发的多个 loader 对齐到同一相位。等待态、完成态也在同一套词汇里（`warning` / `done` / `idle` / `error`），将来要加别的状态标记同样用它。

  `require` **必须 try/catch**：模块表若解析不到该包，未捕获的异常会在 factory 里抛出并让整个条目失败（第 4 轮那类事故）。降级为一个中性小圆点即可，绝不能让视图起不来。
- **等待态（V2，已选变体）**：**只有一个信号** —— 等待的通道在**头部行**左侧一条 2px `state-warn-primary` 竖条（`box-shadow: inset 2px 0 0 0`）。**不要**表面提亮、**不要**标题加重、**不要**胶囊，尤其**不要**把竖条画到整格（会横跨对话区，太抢眼）。等待类型（等待审批 / 等待计划确认 / 等待回答）作为头部行的 **tooltip** 提供，不占像素。
- **输入激活态**：焦点进入该格的**输入框**时，只给**输入卡片本身**加激活描边 —— **不要把描边画在整格上**（"整个会话在发亮"），也**不要画在 composer 外圈那条横带（seat）上**（它横跨输入框 + 工具栏 + dock，且没有圆角，看起来就是个难看的大方框）。**必须用宿主自己的聚焦约定**：`outline: 2px solid var(--dsw-alias-state-business-primary)`（`ui-theme/src/styles/focus.css` 就是用这个颜色与宽度）。**不要**用 `border-l2` 之类的弱边框色 —— 与面板间那 1px 分隔线几乎不可分辨，等于没做。

  实现难点：真实模式下输入框是**官方 composer，拿不到 class**。可行做法是注入一条**作用域规则**，挂在宿主打在**卡片自身**上的稳定属性：

  ```css
  [data-mixer-pane] [data-composer-card]:focus-within {
    outline: 2px solid var(--dsw-alias-state-business-primary);
    outline-offset: 0;   /* 贴着卡片自己的圆角（--dsw-radius-panel）画 */
  }
  ```

  宿主发布的三个钩子，按"越贴目标越好"取用：`data-composer-card`（**输入卡片**，首选）、`data-composer-seat`（包住整条 composer 带的座位）、`data-conversation-region="composer"`（同座位）。**不要**用 CSS module 的哈希类名（如 `GrXCZa_card`）—— DSH 一重建/升级就失效。模拟内容模式则是自己的标记，直接在 composer 容器上按焦点状态加同一条描边即可。

  两条依据：宿主 composer **自己把 outline 关掉了且没有替代反馈**（`InputBar.module.css` 里只有 `outline: none`，没有 `:focus-within`），所以这层反馈必须由插件画；焦点监听只挂内容区（点标签或 `×` 不点亮）。
- **关闭 `×`**：把该格移出调音台（保留 retain，顶栏汇总可放回）。这份"移出集合"**存在插件作用域、不进持久化**：它只属于"这一次坐着"，但必须**跨面板重挂存活**（§5.1 的重挂代价②）。
- **拖动头部排序**：通道头部 `draggable`，拖动即重排。从头部自带的控件（标签、`×`）起拖必须拒绝（`event.target.closest('button')`），否则点按钮会变成拖拽。
- **拖拽虚影＝整通道**（用户 2026-10-15 决定，需求3；**2026-10-20 修正实现**）：
  - **不能把活着的通道元素交给 `setDragImage`**（原实现如此，事后证明只在空会话上成立）。Blink 的快照范围是 `AbsoluteBoundingBoxRectIncludingDescendants()` —— 元素**加全部后代布局盒**的并集，再夹到 `kMaxDimension = 8192px`；hero 相的通道没有溢出内容，并集就是通道本身，所以看上去正常；**有对话的通道**里，滚动区后代的布局盒在几千像素之外，并集被撑到上限，画出来就不再是一个通道（用户实测原话：「只有空对话才有整格虚影，有对话的子栏拖动无虚影」）。`overflow: hidden`、滚动高度、`clip-path` 都救不了：它们只影响绘制，不改布局盒。
  - **现行做法**：`onDragStart` 里同步造一个**同尺寸替身**（`buildDragGhost`）—— `position: fixed` + `left: -10000px`（**必须已入文档**：游离元素没有布局盒，快照会静默退回默认头部图），宽高取通道的 `getBoundingClientRect()`，1px `border-l2`，并剥掉 `data-mixer-head` / `close` / `view*` 钩子；然后 `setDragImage(ghost, offsetX, offsetY)`，偏移仍是**指针在通道内的相对位置**。快照在 dragstart 处理函数返回后**同步**完成（`DragController::StartDrag`），所以替身在下一个 task 移除（`data-mixer-drag-ghost` 是它的 devtools 钩子）。
  - **替身的内容分两段取**（2026-10-20 第八轮，用户要求"空会话保留输入框和 logo、超长通道给骨架"）：
    - **头部两行**（头部行 + 视图标签）永远**真实 `cloneNode(true)`** —— React 把这两行写成内联样式，克隆出来一模一样。
    - **身体**走探针 `bodyFitsCell(body)`：遍历 `[data-mixer-body]` 的后代，只要有一个后代的 `getBoundingClientRect()` 落在通道之外（这就是 Blink 那个并集的判据）就不克隆。**全部在框内 → 克隆真实身体**：空会话因此天然保留 hero（logo + 工作区行）与输入框，短对话保留自己的正文；**有越界 → 画骨架** `buildDragSkeleton`（`data-mixer-drag-skeleton`；细则见下条），因为越界的内容正是毁掉快照的东西。探针在第一个越界后代处提前返回，长对话的代价只是"可见的那几条"；并留 **24px 余量**（宿主的宽度抓手是悬停才可见的 chrome、可能越界几个像素，不该逼出骨架；克隆时这些 `[data-width-handle]` 会从替身里删掉，所以画面仍是精确的通道尺寸）。
  - **骨架长什么样**（2026-10-20 第九、十轮，用户逐轮反馈）：**三个大块**（flex 比例 `3 : 2.2 : 1.6`，宽度 `100% / 86% / 64%`，中间右对齐、下面左对齐）把身体填满；每块内 **12 / 8 / 6 条文字线**（`flex: 0 0 12px` + `gap: 8px` + `justify-content: space-between`）—— 线要够多、铺满块高，不能只在顶部几条；**底部一个 composer 骨架**，尺寸按真实输入卡片来（`min-height: 104px`、输入行 58% 宽 / 12px 高、工具栏排 4 个 chip `54/32/32/22px`）。全部用宿主自己的占位 token：块与线与 chip 用 `--dsw-alias-bg-skeleton` / `--dsw-alias-border-l2`。**不要用 `bg-layer-1/2` 画骨架 —— 浅色主题下它们和 `bg-base` 都是纯白，画出来等于没画**，这正是第一版"只有顶部有"的根因。
  - 代价（HTML5 硬限制）：**长对话的虚影不含正文**（只有骨架 + 真实头部），也不跟手、不能加动效。要"跟手 + 缩放/阴影/正文"只能放弃 HTML5 drag image 改自绘代理 —— 那会让"从侧栏拖入"与本路径观感分叉，**本期不做**。
  - 同一处给原通道打 `data-mixer-dragging="yes"` → `opacity: .4` 做原位占位；**`dragend` 必须清理**（含拖出窗口、按 Esc 取消这些不触发 `drop` 的路径）。
- **从左侧栏拖入**：拖一个会话行到通道区，按落点插入对应位置。侧栏展开时才可用（调音台会折叠它，需手动展开）。这条拖拽由**宿主**发起，虚影仍是浏览器默认（一整行会话）—— 观感差异接受，写在此处以免被当 bug。
- **放置指示 + 让位**（用户 2026-10-15 决定，Q12=b）：拖动经过时，其它通道**实时平移让出与虚影等宽的空槽**，插入位在空槽左缘画 2px 的 `state-business-primary` 竖线。devtools 可读的钩子：源格 `data-mixer-dragging="yes"`、落点元素 `data-mixer-drop-indicator` 且 `data-mixer-drop-slot="yes|no"`（`no` = 侧栏拖入的 2px 细线）。
  实现（**已落地**，与最初设想的 transform 方案不同，这里记实现真值）：空槽就是一个**插在落点位置的 spacer 弹性子元素**（`flex: 0 0 <被拖格宽 + 5>px`，5px 是分界线抓取带），被拖的那一格留在原位、`opacity: .4` 当占位；因为 spacer 是**在流内**的，它后面的格子自然被推开——这就是"让位"，不需要任何 transform，也不会与 flex 顺序打架。**指针数学必须在 `dragstart` 时快照各格矩形**（`drag.rects`），否则 spacer 一插进去、格子位置立刻变化，落点会在相邻两格之间来回抖；外部（侧栏）拖入没有可测的格宽，仍只用 2px 指示线。落点只在 `drop` 时提交（§5.4b）。

### 5.4 布局与溢出

- 每格固定最小宽度 **380px**。通道行用 **flex 轨道**（不是 grid，因为分界线要能拖），单元格 `min-width: 380px`、`flex: <权重> 1 0`。
- **不设格数硬上限**：超出可视宽度就横向滚动，而不是挤窄每格。
- **分界线可拖拽调宽**（用户要求）：N 个通道之间有 **N−1 条 5px 抓取带**，中间画 1px 细线（悬停/拖动时变 `state-business-primary`）。

  实现要点：
  - 宽度以**每通道权重**保存（session 键控，缺省 1），拖拽只调整相邻两格；
  - 拖拽是**按比例**的：`dW = (dx / 内容宽) × 总权重`，且在 `pointerdown` 时快照基准，避免重渲染让分界线追着指针跑；
  - **必须夹紧**：任一侧都不得低于 `MIN_PANE_W`，即 `floor = 总权重 × (380 / 内容宽)`；
  - 抓取带上加 `touch-action: none`，拖动期间给 `body` 设 `user-select: none`（否则会选中对话文字）；
  - 用 `setPointerCapture`，`pointerup` / `pointercancel` 都要收尾并恢复 `user-select`。

  ⚠️ 手工调宽与"最小宽 + 横向滚动"是**互补**的：调宽改的是相对比例，总宽超出时仍然横向滚动。
  ✅ **宽度要记住**（用户 2026-10-15 决定，此前标"待定"的那条）：权重与通道集合写进同一份持久化状态（§4.1），拖完即写；刷新后每格的相对宽比不变。解析防御式、`×` 移出时保留、归档时清理 —— 细则见 §4.1。

### 5.4b 拖放的统一实现

两条拖放需求**共用一条代码路径**，因为宿主的侧栏会话行**本来就把 SessionId 放在标准负载里**：

```js
// ui-workspace/src/client/rows/Rows.tsx:606（宿主自己写的）
e.dataTransfer.setData('text/plain', node.id)   // node.id 就是 SessionId
```

因此调音台只需做**放置目标**，无需（也不该）给别人的 DOM 加拖拽属性：

- 通道区 `onDragOver`：只接受 `types` 含 `text/plain` 的拖动，`preventDefault()` 并设 `dropEffect = 'move'`（**不 preventDefault 就不会触发 drop**）。
- 落点索引：把指针 x 与各格中点比较，取第一个"指针在它左半边"的格；都不满足则插到末尾。
- `onDrop`：读 `getData('text/plain')` 得到 SessionId，然后**移动或插入**：
  - 该 id 已在通道集合里 → 移动（重排）；
  - 不在 → 插入。
  - 索引修正：`index` 是按**当前已渲染的格子**算的，若被拖的格本来就在更前面，插入位要减一。
- **必须拒收非会话负载**：文本选中拖拽也是 `text/plain`，先确认 `summaries[id]` 存在再动通道集合。
- 拖回一个之前被 `×` 关闭的通道，要同时把它从"已移出"集合里去掉。

### 5.5 视觉纪律

- 只用宿主 alias token：`--dsw-alias-bg-base`、`-bg-layer-1/2`、`-border-l1/l2`、`-label-primary/secondary`、`-brand-primary`、`-state-warn-primary` 等。
- **单一强调色锁**：`state-warn-primary` 只用于「等待」语义，绝不装饰性使用。
- **圆角两档锁**：表面直角（0），交互元素胶囊（999）。
- 跟随宿主明暗主题；无 emoji；不引入新图标库（正式实现可用 `@deepseek-ai/dsh-client-ui-primitives` 的图标组件）。
- 动效近零：唯一动画是执行中转圈（**有语义**），且 `prefers-reduced-motion: reduce` 下关闭。

### 5.6 通道间跳转快捷键（2026-10-20 第十三轮）

调音台的价值是"多路并看"，但通道一多，换通道只能靠鼠标点。所以把**跳转**做成快捷键，并且走**宿主自己的快捷键服务**，而不是插件自己监听 `keydown`。

- **注册**：`ctx.effect(() => ctx.shortcuts.register({...}), 'mixer: shortcut …')`，共 **12 条**命令 —— `mixer.channel.1` … `mixer.channel.9`（跳第 N 个通道）、`mixer.channel.next` / `mixer.channel.prev`（上/下一个）与 `mixer.channel.solo`（solo 光标所在通道，§5.7）。走宿主注册表换来三件事：出现在 DSH 的**快捷键设置**里、用户**可改键**、宿主负责与 composer / 其它插件的**冲突仲裁**。
- **默认键位**：`primary+alt+Digit1..9`（跳第 N 个）、`primary+alt+KeyS`（solo，§5.7）与 **`primary+alt+BracketRight/BracketLeft`**（下一个 / 上一个，即 `Cmd/Ctrl+Alt+]` / `[`，**五个 profile 统一**）。`primary+alt` 是宿主自己给"不撞文本编辑"的组合用的（如 `session.new`）。
  **为什么 `next`/`prev` 不用方向键**（2026-10-20 两次实测后定）：两个坑都在**平台层**，不在我们的 handler 里 ——
  1. **宿主校验不分设备**：`register()` 会把全部五个 profile 的默认键位逐一过 `bindingIssue`，而 `Ctrl+Alt+方向键` 在 Desktop Linux 被判 `reserved` → 抛 `Reserved shortcut default: <id>` → 条目在冷启动时 FAILED（整页起不来，已真实踩中一次，见 §9.0h 第 4 行）；
  2. **macOS 的 OS 级抢占**：`Cmd+Option+←/→` 是系统媒体键（上一首 / 下一首），**OS 在页面之前收走按键**（用户实测：按了之后音乐 App 换歌，通道不动）。这类冲突页面侧无解，只能避开。
  方括号两个坑都不占，且各键盘布局都按得到。
- **区域**：`regions: ['page', 'editable']` —— 光标在某个通道的输入框里时也能跳（那正是调音台用户的常态）；`modals: []`。
- **行为**：跳转 = 把目标通道**滚动到可见**（`scrollIntoView({ block: 'nearest', inline: 'nearest' })`）并把焦点交到它的输入框（复用 §5.1③ 的焦点交接机制，含迟到的 composer）。**光标落在草稿末尾**（2026-10-21 用户反馈：跳过去是要接着写，落在开头等于每次都要重新定位）：plain 输入框用 `setSelectionRange(len, len)`（个别 `type` 会抛，包在 try 里、不影响聚焦），宿主的富文本 composer 用 `Range` + `collapse(false)` 折到内容末尾；两种形态都由 `createChannelDom().caretToEnd(field)` 一处处理。`next`/`prev` 从**当前焦点所在通道**出发并**首尾环绕**；焦点不在任何通道时从第一个（next）/最后一个（prev）开始。
- **不用时不吞键**：调音台不是当前面板 → `resolve` 返回 `pass`（不消费按键）；调音台在、但没有第 N 个通道 → `blocked` + 原因（宿主的词汇，不是静默无效）。
- **跨作用域的桥**：快捷键在 `apply` 作用域注册（随插件一次），但它要作用于 React 状态（哪些通道、焦点在哪）。面板在每次渲染时把**实时通道顺序与两个跳转命令** publish 给插件作用域的 `view`（`createViewState().publish`），卸载即清空 —— 键击永远不会作用在过期列表上（§9.0j 的 module）。
- ⚠️ **服务边**：`inject` 增加 `'shortcuts'`，`package.json` 的加载顺序边同步加 `@deepseek-ai/dsh-client-shortcuts`；`boot-check.mjs` 的假 context 必须 `provide('shortcuts')`，并断言 12 条命令都在冷启动时注册成功（缺一条 = 静默少一个快捷键）。
- ⚠️ **假注册表挡不住宿主的校验**：`boot-check.mjs` / `tests/harness.mjs` 的 `register` 收什么都收，所以"12 条都注册了"并不等于"宿主会接受它们"。真判据在 `tests/host-contract.test.mjs` 的 `host registry accepts every shortcut default we register`：从 checkout 里跑宿主自己的 `bindingIssue` / `isWebBindingAllowed` / `resolveShortcutDefault` / `overlappingBindings`，逐个 profile 验证插件的每条默认键位（含我们自己命令之间的撞键）。

### 5.7 solo：只看一个通道（2026-10-20 第十四轮，issue #12）

调音台的常态是并排；solo 是**临时的视觉聚焦**，不是"关掉通道"。

- **形态**（用户 2026-10-20 定）：被 solo 的通道占满剩余宽度，其余通道**压成 64px 窄条**（`SOLO_STRIP_W`）。窄条上保留**状态点**（等待 = 琥珀点、执行中 = 宿主 `StateDot` 转圈、子代理 = 第二个点、已完成 = 绿点）与被截断的标题，悬停出 tooltip 给全名与状态；整条可点、可键盘聚焦（`role="button"`），点一下改成 solo 那一个。
- **窄条怎么和主通道分开**（2026-10-20 用户反馈「缺少明显的分界，几乎找不到」）：
  1. 窄条用自己的**凹陷表面** `--dsw-alias-bg-skeleton`（浅色 4% 墨 / 深色 8% 白）。**不能用 `bg-layer-1/2`** —— 它们在浅色主题里就是纯白，窄条与主通道完全同色；也不能用宿主的 sidebar 填色（`--dsw-specific-sidebar-fill` 浅色下与白只差 6/255）。
  2. 每条窄条右缘一条 `--dsw-alias-border-l2` 的 1px 分界线（用 `box-shadow: inset` 画，不吃 64px 宽度；相邻两条窄条之间正好共享这一条线）。
  3. 标题用 `label-primary`（不是次级灰），保证"能认出是哪个会话"。
  4. 悬停时**保留凹陷表面**并加 2px `state-business-primary` 左缘（与分界线拖拽 hover 同一套强调色）—— 半透明 wash 会把表面洗掉，反而不像可点。
- **状态照旧**：solo 只是视图状态 —— 被压成窄条的通道**照常执行、照常亮灯**，这正是它与 `×` 移出（把通道从屏上拿走）以及将来的 `mute`（不打扰）的区别。窄条用 `data-mixer-strip="<id>"`，等待态另外带 `data-mixer-strip-waiting`。
- **进入 / 退出**（用户定）：通道头部的 `solo` 按钮（solo 中变成 `退出`，`data-mixer-solo="<id>"`）、顶栏的 `solo：<标题> 退出` chip（`data-mixer-solo-bar` / `data-mixer-solo-exit`）、以及快捷键 `mixer.channel.solo`（默认 `primary+alt+KeyS`，作用于**光标所在通道**；光标不在任何通道时 `blocked` + 原因）。
  ⚠️ **不用 `Esc` 退出**：在会话里 `Esc` 是宿主的「停止当前回合」（`ui-conversation/stop-shortcut.ts` 的 fixed input），拿它当退出键会和用户"想停止生成"的动作抢键。
- **布局纪律**：solo 期间**暂停分界线拖拽与头部拖动重排**（64px 的窄条上没有可拖的东西）；宽度权重**一个字节都不写**，所以退出后各通道的相对宽度原样回来（`tests/interaction.test.mjs` 钉住）。
- **自动退出**：被 solo 的通道若被归档或被宿主列表剪掉，solo 立刻失效回到并排 —— 绝不出现"solo 着一个已经不存在的通道"。
- **不持久化**（用户定）：solo 只属于"这一次坐着"。状态放在**插件作用域**（`soloId` / `setSolo` / `clearSolo`），因此跨面板重挂（ADR-0003）存活，但刷新即回到并排 —— 与「移出」同族。`CONTEXT.md` 早已把 solo 定义为"只聚焦某一个通道；其余通道仍在"。

## 6. 验证清单（装完怎么确认生效）

0. **先跑自动化**：`npm run check`（语法 + **96 个用例**：纯函数缝 + 真 store 引擎 + 真 React（静态渲染与 jsdom 交互）+ 侧栏折叠 seam + 措辞对齐 + 宿主契约漂移哨兵 + 冷启动守卫）。这一条绿了再动浏览器 —— 它覆盖的是"冷启动会炸整页"和"注册事实静默丢失"这两类只有跑起来才看得见的问题。
1. **安装**：`plugin_manager` → `install_bundle`，target = **本包根目录**；确认返回 `application: applied` 且 `warnings` 为空。随后**把 `dsh-mixer-spike` 从 profile 卸掉**（否则原型与正式版同时注册 `main` 的 key、会话头按钮和 `/mixer`，行为不可预测）。
   **验收判据（profile 文件）**：`~/.dsh/profiles/web/package.json` 里应当只剩 `"dsh-mixer": "link:/Users/user/Documents/code/d/dsh-mixer"` 这一条 mixer 依赖，且 `dsh.profile.bundles` 里只列 `dsh-mixer`、**不含** `dsh-mixer-spike`（装之前那里写的是 spike）。
2. **冷启动**（关键，别用热重载代替）：**硬刷新**页面，确认**没有** `Failed to load plugins` / `web boot: N entry did not activate`。任何 `apply()` 改动都必须重做这一步。
3. **入口**：会话头「打开目录」左侧出现切换按钮；在 composer 里敲 `/mixer` 也能进入。
4. **并排**：每格渲染出官方 composer 与完整对话记录（不是空白，也不是只读快照）。
   （这一条**只有浏览器能验**：`renderFactorySlot` 的真实产出、官方 composer、焦点描边、
   真实拖放都得在真宿主里看。它的**插件侧前置**已被自动化覆盖：工厂被调用、参数为
   `variant: 'embedded'`、每格一份，见 `tests/render.test.mjs`。）
5. **独立**：两格的输入框草稿互不干扰（同一会话放进两格会共享草稿，这是契约）。（只有浏览器能验。）
6. **等待态**：制造一次需要授权/确认的操作，对应通道应出现 V2 标记，且顶栏汇总计数 +1。三种 kind（审批 / 计划确认 / 提问）都要出标记；域注册的其它 kind **不应**出标记（§4.3b 白名单）。
7. **状态四档对齐侧栏 + 空闲无标记**（用户 2026-10-15 新增）：同一会话在左侧会话行与调音台格子里同时可见时，逐档核对一致 —— 等待（琥珀 + 竖条）、执行中（转圈）、子代理运行中（**第二个**转圈点）、已完成未读（绿点）；**空闲时格子头部不出现任何标记**（§4.3b 的唯一有意偏差，侧栏那边是灰点）。绿点的清除时机按 §4.3b 的说明核对（本插件不负责清除，下一轮 `running` 才灭）。
8. **持久化**：改动下拉里的勾选 → 刷新 → 选择仍在；拖动分界线改宽度 → 刷新 → **每格相对宽比不变**（§4.1 / §5.4）。
9. **归档联动**：把某个已选通道的会话在左侧归档 → 它应从调音台消失（且期间列表未就绪时不会误清空面板），其宽度权重一并清掉。
10. **退出**：点「常规视图」或左侧会话行 → 回到常规，滚动位置与草稿仍在；侧栏恢复原状。
11. **不要继承原型的结论**：这份清单现在跑的**就是根包**（`feat/mixer-v1`）。原型时期的通过记录只说明机制可行，不能当成这十条的验收 —— 尤其第 2 条和"并排/独立"两条。

12. **空会话居中**（需求1）：新建一个还没说话的会话通道 → 输入框**竖居中**，上方是宿主的 hero 标题与工作区行；发出第一条消息后输入框**自动回到底部**停靠，不闪跳。
13. **新建不离开调音台**（需求2）：在 `会话` 浮层左列把指针停在某个工作区行、点它行尾的 `＋会话`；或按 56px 轨道上的新建按钮、按 `Cmd/Ctrl+Alt+N` —— **三个入口都留在调音台**（含宿主**复用已有空白会话**那一路，§5.1），新会话成为**第 0 个通道**且光标在它的输入框里；`×` 移出的通道不因此弹回；每格滚动位置回顶属已知代价（§5.1）。
14. **虚影与让位**（需求3，2026-10-20 第二轮修正后复验）：拖头部时虚影是**整个通道**（不是只有头部），同尺寸、带真实头部与视图标签；**身体**按通道内容分两种 —— **空会话**的虚影保留 hero（logo + 工作区行）与输入框（身体全在框内，直接克隆），**超长对话**的虚影身体是**骨架**（三个大块各带 8–12 条文字线、填满身体 + 底部按真实尺寸画的 composer 轮廓，`data-mixer-drag-skeleton`，不含正文，HTML5 硬限制见 §5.3）；原通道半透明；拖动经过时其它通道让出空槽；拖到窗口外或按 `Esc` 取消后，原通道透明度复原、不留空槽、DOM 里不残留 `[data-mixer-drag-ghost]`。
15. **顶栏 B**（需求4）：顶栏只写 `调音台`，不出现具体工作区名；`会话` 浮层左列点一下只把右列滚到该工作区、**不会离开调音台**；左列每行 hover 出淡底与 `＋会话`，点它在**该工作区**新建且落在第 0 位；右列搜索即时过滤标题；`Esc` 与点外部都能关；勾选即增删通道；右列底部**没有**新建按钮。
16. **空会话的光学位置**（第三轮）：新建的空白通道里，hero（logo + 输入框）看起来在**略高于几何中心**处，而不是「算居中但看着偏下」；不合适就调 `HERO_LIFT_PX` 一个数。
17. **顶栏可读性**（第三轮）：`调音台`、`会话`、`常规视图` 与每格的视图标签都在 13px 档、一眼能读；`会话` 静止时就是一颗有底色有描边的按钮，不是一段文字。
18. **浮层跳转**（第三轮）：`会话` 浮层里会话行与顶栏同档字号；点左列任一工作区，右列会滚到该工作区的分组。
19. **归档过滤**（第四轮）：在侧边栏归档一个会话 → 打开 `会话` 浮层，它**不在列表里**（与侧边栏一致）；若它本来在通道里，该通道同时消失。
20. **面板内归档**（第四轮）：指针移到某会话行 → 行尾出现 `归档` → 点它：安静会话直接归档（侧边栏同一套动作）；**正在执行**的会话先在该行下方问一次，点 `停止并归档` 才动手，点 `取消` 什么都不发生。
21. **归档可撤销**（2026-10-20，issue #12）：归档一个通道 → 顶栏出现 `已归档「…」撤销`；点 `撤销` → 会话回到原工作区、通道回到**原位置**且宽度不变；**6 秒**不点则 chip 自行消失；撤销失败（宿主拒绝/没提供方法）在顶栏有可见提示。
23. **solo**（2026-10-20，§5.7）：点通道头部的 `solo`（或 `Cmd/Ctrl+Alt+S`）→ 该通道占满、其余压成 64px 窄条；窄条**与主通道一眼可分**（凹陷表面 + 1px 分界线 + 主色标题，浅色主题下也看得出来），状态点仍准确；点窄条切到那个通道；顶栏 `solo：… 退出` 或再按一次回到并排，**各通道宽度与 solo 前一致**；solo 期间拖不动分界线也拖不动头部排序；把被 solo 的通道归档 → solo 自动结束；刷新页面 → 回到并排（不持久化）。
25. **格内审批卡（2026-10-21，无头浏览器实测通过）**：在调音台的某一格里让 agent 触发一次授权 → **该格**出现 `[data-approval-key]` 卡（`等待审批` + 理由 + 命令 + `拒绝` / `允许一次`），该格 `data-mixer-state="waiting"`、顶栏汇总 +1，**其它格不受影响**；点 `允许一次` → 卡片消失（实测 ~1.6s）、composer 回来、该格继续执行、顶栏计数归零。

24. **通道间跳转快捷键**（2026-10-20，§5.6）：调音台打开时按 `Cmd/Ctrl+Alt+1..9` → 焦点落到第 N 个通道的输入框、**光标在草稿末尾**（继续写，而不是从头来；越界的通道给提示、不静默）；`Cmd/Ctrl+Alt+]` / `[` 从当前通道出发下/上一个并首尾环绕（**全平台同一套**；不要用 `Cmd+Option+←/→`，那是 macOS 的媒体键）；**调音台没打开时按键不被吞**；在 DSH 的快捷键设置里能看到并改这 12 条命令。

**验收记录（v1，2026-10-15，用户实测）**：在根包（`feat/mixer-v1` @ `5c8314b`，profile `web` 只装 `dsh-mixer`）上完成 —— 硬刷新冷启动**没有** `Failed to load plugins` / `web boot: N entry did not activate`；第 3–10 条逐条通过（含五档状态与左侧会话行逐档一致、持久化、归档联动、退出复原）。

**验收记录（2026-10-20，用户实测，四轮往返）**：§6.16 空会话 hero 的光学位置**确认通过**（用户答「正好」，`HERO_LIFT_PX = 48` 保持不变，不再调整）；§6.14 的**让位**与**「拖动不会被取消」**两条**确认通过**。虚影本身修了三轮并逐轮由用户复验：**整通道替身虚影**「总体效果正常了」→ **空会话身体（hero + 输入框）符合期望** → **长对话骨架**（大块 + 文字线 + composer 轮廓）「还行」。根因（Blink 快照取元素＋后代的布局盒并集，滚动内容把并集撑到 8192px）与修法见 §5.3 与 §9.0c 第 7 行 / §9.0d / §9.0e。

agent 侧可复核的旁证（**只证明注册事实，不替代本清单的观感项**）：`npm run check` = 53/53 + 冷启动守卫 `PASS`；live 页里 `main` 的 `mixer` occupant `active:true`、`conversation.session.header.utilities` 的 `mixer-toggle`（label 调音台，order −20）`active:true`、子槽 `mixer.channel` 已声明。

## 7. 宿主限制与规避（必读）

### 7.1 侧栏无法归零

`computeColumns` 在侧栏为 0 时仍取 `SIDEBAR_COLLAPSED = 56`，所以"隐藏侧栏"实际是留一条 56px 轨道。**已定：接受轨道**，不改宿主（接管 `sidebar` 槽位会连带移除 `sidebar.settings` 座位，设置入口会一起消失）。

**另需注意**：没有任何公开 API 能读到折叠状态（`PanelInfo` 只有 `activePanelId`），`ctx.layout.toggleSidebar()` 是**盲切换**。原型因此读宿主 frame 上的 `data-sidebar-collapsed` 属性来判断 —— 这是**临时代码**。正式实现需要一个 layout 的读/写 API，否则每次进出都可能反向切换。

### 7.2 顶栏不重复轨道里的入口

折叠后的 56px 轨道**仍保留**：品牌标、面板图标（含插件、自动化任务）、**设置齿轮**（`ui-settings-general/chrome.tsx` 窄态渲染 `IconSettingsOutlineMedium`），以及**新建会话按钮**（`SidebarRoot` 头部的那个按钮在两种宽度下都渲染，窄态只是换成图标；非 macOS 桌面时品牌标本身也是新建按钮）。

⚠️ **2026-10-15 更正**：本节原文写"真正丢掉的是 `sidebar.workspaces` 整区（工作区切换 / 新建会话 / 会话浏览）"—— **"新建会话"那半句是错的**，轨道保留了它；真正丢掉的只有**工作区切换与会话浏览**。两个后果：① 顶栏的「＋在此新建会话」与轨道按钮是**重复入口**，属于有意为之（那里是插件的自然路径，见 §5.1）；② 轨道那个按钮是**宿主入口**，按它会把用户送出调音台，必须按 §5.1 的窄条件抢回。所以顶栏**只放** `调音台` 标签、`会话` 浮层、等待汇总、常规视图；品牌 / 插件 / 任务 / 设置一律不重复。

### 7.3 原版会话头挂载不了 → 精简头

标题面包屑之外的四项（智能体团队、当前模式、用 xx 打开、下载日志）由 `conversation.session.header.actions` / `.utilities` 承载，而这些槽被 `ui-conversation` 的条目**独占声明**；插件在自己的条目里再声明同名子槽会**直接抛错**（`slot "x" is already declared`，`packages/client/ui-slots/src/index.ts:1245`）。全客户端只有一个可复用工厂，且**刻意不含 header**。

**已定：接受精简头**（面包屑 + 视图标签 + 等待/执行指示 + 关闭），不做重实现、不等上游。若日后要完整头部，正解是上游提供可复用的"会话壳"工厂。

## 8. 实现红线

- **绝不写 `if (ctx.someService)`**：Cordis 中对未注入服务的读取是**抛错**，不是 `undefined` → 守卫不生效 → 条目 `FAILED` → 宿主判定整个 Web 启动失败。用 `ctx.inject([...], cb)` 或把服务写进模块的 `inject`。
- **冷启动 ≠ 热重载**：HMR 重载时所有服务都已就位，带 bug 的代码看起来完全正常。任何 `apply()` 改动都要走冷启动验证（`npm run check` / `node boot-check.mjs` + 硬刷新）。
- 注册 slot 前确认该键在父条目的 `children` 里被声明过；渲染未声明的键同样抛错。
- 不修改别的条目的 store（本次因此改用"钉住视图"而非写 conversation store）。

## 8.5 轮次导航：宿主按容器宽度隐藏，插件折中降阈值（已定稿）

**现象**：窄通道里看不到对话右侧的轮次导航，把该格拉宽到一定程度才出现。

**根因（确证）**：轮次导航由 `ui-chat` 的 `ChatView` 自己渲染，属于**每个视图实例**，所以每个通道天然各有一份；它消失是宿主的容器查询：

```css
/* ui-chat/src/client/chat/TurnNavigator.module.css:207 */
@container (max-width: 900px) { .frame { display: none } }
```

`.slot` 声明了 `container-type: inline-size`，所以 900px 指的是**该对话容器自身的宽度**。而这个容器（rail 自己的 `.slot`）每侧还带 `calc(var(--dsh-composer-side-clearance) + 16px)` 的内边距；embedded 面板里 clearance 是 **8px**（`ConversationRoot.module.css` 的 `.embeddedBody`），故容器宽 = 面板宽 − 48。**换算下来，宿主实际要求面板约 948px 才显示。**

**决定（用户）**：折中 —— 覆盖宿主阈值，换成插件自定的 **面板 560px**（容器 512px）。既不在极窄格里强塞，也不像宿主那样要到近千像素。
2026-10-15 调整：用户看过 640/592 后要求「**这个值再小一点**」，故从 640 降一档到 **560**。这个数就是 `RAIL_MIN_PANE_W` 一个常量，观感不合适时直接改它（容器阈值自动 −48）。

**实现**：

```css
@container (min-width: 512px) {
  [data-mixer-pane] [class*="_slot"] > [class*="_frame"] { display: block }
}
```

- 只对本插件的格子生效（`[data-mixer-pane]` 前缀）。
- **选择器安全性已核查**：rail 的 `frame` 是它自己 `slot` 的直接子元素（`TurnNavigator.tsx:234/236`），两者同哈希前缀（构建产物里是 `fA77rG_slot` / `fA77rG_frame`）；`ChatView` 的 `.frame` 是**另一个**哈希（`L423fa_frame`）且没有 `_slot` 父级。定向扫描面板子树里的包（ui-conversation / ui-approval / ui-model-selection / session-log-export 无该类名；ui-attachment、ui-user-questions 有 `_frame` 但无 `_slot` 父级）—— **全子树只有 rail 这一个 `_slot > _frame` 组合**。
- 本规则的特异性（3 个属性选择器）高于宿主单类规则，因此**即使宿主的声明在容器查询里也会被覆盖**；低于阈值时本规则不落，宿主的隐藏照旧生效。
- 阈值是**常量**：`RAIL_MIN_PANE_W = 560`，容器阈值由它减去 48 得出（推导见代码注释）。

**排查手法**：原型的诊断行（`轮次导航 rail=/标记=/轮次=/宽=Npx（<560 才隐藏）/band=`）随脚手架一起删了，留在 `spike/mixer-two-pane` 分支上。判据仍然有效，可用 devtools 手测：**轮次≥2 且 宽≥560 且 rail=0 → 真异常**（先看覆盖规则是否命中）；**宽<560 → 预期隐藏**。

## 9. 未决 / 后续

### 9.0 2026-10-15 本轮拍板（用户回答「还有哪些未定」）

| # | 决定 | 落点 |
| --- | --- | --- |
| 1 | 通道宽度**要持久化**（原标"待定"） | §4.1 / §5.4 / §6.8 |
| 2 | 「还有几处纽结」= 用户在**反问 agent 自己有哪些未定**，不是另有一批 UI 问题 | 无新增待办 |
| 3 | 轮次导航阈值**再小一点** → 640 → **560**（容器 512） | §8.5，改 `RAIL_MIN_PANE_W` 一个常量 |
| 4 | 通道状态**逐档对齐左侧会话行**：不止 loading / 等待，共 5 档（子代理那档可并列成第二个点） | §4.3b / §5.3 / §6.7 |
| 4b | 追加决定（看过灰点后）：**空闲档不画点**，为唯一有意偏差；其余四档必须一致 | §4.3b / §6.7 |
| 5 | UI 文案走 locale 服务**留作二期**（本期硬编码中文） | §1「本期不做」 |
| 6 | 本轮改动**先不提交**，等用户验完真实状态再一次性提交 | 交接约定（已于 `3a0ed3b` 提交并推送） |
| 7 | 正式版**另开分支** `feat/mixer-v1`（off main），原型分支原封不动 | §11 |

### 9.0b 2026-10-15 第二轮拍板（UI 需求 1–4）

| # | 决定 | 落点 |
| --- | --- | --- |
| 1 | 空会话通道与常规视图**同相**：动态传 `phase`/`hero`，居中由宿主 hero 给（原本写死 `hero:false` 是需求1 的根因） | §4.4 / §6.12 |
| 2 | 插件新建走 `ctx.sessions.create` + 自己 retain，**不走** `startSession`；新建**不构成离开** | §3 / §5.1 / ADR-0003 / §6.13 |
| 3 | 新会话**置顶**（同工作区已有空白会话则复用）；只有"调音台里发起的新建"自动进通道 | §4.1 / §6.13 |
| 4 | 宿主两个入口（轨道新建按钮 / `Cmd·Ctrl+Alt+N`）用**窄条件抢回面板**；"重挂后滚动位置回顶"为已知代价 | §5.1 / ADR-0003 |
| 5 | 拖拽虚影＝**整格快照**（`setDragImage` 传格根）+ 原格半透明 + 插入线；拖动时其它通道**让位** | §5.3 / §6.14 |
| 6 | 顶栏重做为**方案 B**：`会话` 两栏浮层；顶栏不出现工作区名；左列只定"新建落点"；本地标题搜索；不加独立 `＋`；**删「切换到此工作区」** | §5.2 / §6.15 / 原型 |
| 7 | `docs/prototype/mixer-topbar.html` 是**一次性设计原型**（A/B/C 对照，含空会话 hero 与让位示意），定形态后由 spike 真机版替代 | §10 |
| 8 | 术语定名：`×` 的行为叫**「移出（put away）」**，代码 `parked`、文案仍「已移出」、顶栏钩子仍 `data-mixer-hidden`；`mute` 留给将来"通道还在、只是不打扰" | `CONTEXT.md` / §9.1 |
| 9 | 新增术语**「新建落点」**并明确**废弃"当前工作区"这个说法**（调音台没有这个概念） | `CONTEXT.md` / §5.2 |
| 10 | 抢回判据定为**"宿主 reveal 的会话是空白的"**（而不是"出现了新 id"），这样连"复用已有空白会话"那条宿主入口也覆盖 | §5.1 / ADR-0003 |
| 11 | 新建失败在**顶栏**给一条带原因的提示（`data-mixer-create-error`），打开浮层时清掉 | §5.2 / §9.1 |

### 9.0c 2026-10-15 第三、四轮：浏览器实测反馈

| # | 反馈 | 处置 | 落点 |
| --- | --- | --- | --- |
| 1 | 空会话的 hero 虽居中但整体偏下，向上微调 | 注入作用域规则把 `[data-composer-seat]` 抬 24px（`HERO_LIFT_PX`，用 margin 不用 transform） | §4.4 / §6.16 |
| 2 | 顶栏 `会话`、`调音台`、视图切换按钮字太小，`会话` 没有按钮样式 | 顶栏升到 13px 档（标签 13.5/600、chip 11.5px）；`会话` 静止即带底色描边；每格视图标签 13px | §5.2 / §5.3 / §6.17 |
| 3 | `会话` 两级菜单字偏小；点左列工作区时期望右列滚到对应分组 | 浮层字号升到 13px 档（分组标题 12px、列宽 196/344）；左列兼作跳转表（`data-mixer-group` + `scrollIntoView`） | §5.2 / §6.18 |
| 4 | 已归档的会话仍列在浮层里、点了没反应 | 右列按 `archivedSessionIds` 过滤，与侧边栏一致 | §5.2 / §6.19 |
| 6 | 归档按钮"点击无效"（浏览器实测） | **根因**：第二轮把 `uiWorkspace` 从模块 `inject` 里删了，而第四轮的归档在**点击时**才读 `ctx.uiWorkspace` —— Cordis 抛 `cannot get property "uiWorkspace" without inject`；晚读的 handler 不在启动期暴露，所以冷启动与全部测试都是绿的。**修**：`inject` 加回 `uiWorkspace`（`package.json` 的加载顺序边同步加 `-ui-workspace`），并加静态哨兵钉住"读到的每个 `ctx.<服务>` 都在 inject 里、且名单里不留无人读的边"；同时把静默失败一并堵掉（同步抛错 / 未提供 API / 拒绝 都出顶栏提示，进行中显示 `归档中…`） | §5.2 / §11 / [plugin-gotchas §1](./plugin-gotchas.md) |
| 5 | 悬停会话行时希望有归档按钮，且归档后在通道里打开的那一格要关掉 | 行尾 hover 出 `归档` → `ctx.uiWorkspace.archiveSession`（与侧边栏同一调用）；正在执行则按错误名识别拒绝、行内确认"停止并归档"；通道由 §4.1 自动移除关掉 | §5.2 / §6.20 |

### 9.0d 2026-10-20 第七轮：虚影只对空会话成立

| # | 反馈（浏览器实测） | 处置 | 落点 |
| --- | --- | --- | --- |
| 1 | 「虚影视觉效果很奇怪：只有空对话才有整格虚影，有对话的子栏拖动无虚影」；**让位正常、拖动不会被取消** | **根因**：Blink 的拖影快照取的是「元素 + 全部后代布局盒」的并集（`AbsoluteBoundingBoxRectIncludingDescendants`，`layout_object.cc:2369`），再夹到 `kMaxDimension = 8192px`；hero 相不溢出 → 并集=通道本身；有对话的通道里滚动区后代的布局盒在几千像素外 → 并集触顶，画出来不再是一个通道。**推翻了 §9.0b 第 5 条的实现备注「`setDragImage` 传格根」** —— 那个做法只在空会话成立。`overflow: hidden` 只是绘制裁剪、不改布局盒，所以"临时关掉滚动"救不了。**修**：传**同尺寸离屏替身**（真实头两行 `cloneNode` + 空身体 + 1px `border-l2`），快照完成后下一个 task 移除；代价是虚影不含对话正文（HTML5 无"只截可见部分"） | §5.3 / §6.14 / §11 |
| 2 | §6.16 hero 光学位置：「正好」 | 不改值，`HERO_LIFT_PX = 48` 定稿 | §4.4 / §6.16 |

### 9.0e 2026-10-20 第八轮：虚影身体要"有内容"

| # | 反馈（浏览器实测） | 处置 | 落点 |
| --- | --- | --- | --- |
| 1 | 「身体部分可以有内容子栏保持内容（如空对话保持输入框和 logo）」 | 身体改为**条件克隆**：探针 `bodyFitsCell` 遍历 `[data-mixer-body]` 的后代矩形（Blink 并集的同一条判据），**全部落在通道内就克隆真实身体** —— 空会话因此自带 hero（logo + 工作区行）与输入框，短对话自带正文。hero 抬升规则补上 `[data-mixer-drag-ghost]` 作用域，使克隆的 hero 与真实通道同高 | §5.3 / §4.4 / §6.14 |
| 2 | 「超长的子栏身体可否增加骨架而不是置为空」 | 有后代越界 → `buildDragSkeleton`：胶囊消息条 + composer 轮廓（`data-mixer-drag-skeleton`）。静态、无动画 —— 拖影只有一帧，会"动"的骨架是撒谎。长对话的虚影因此是"有正文"的语义，而不是空白 | §5.3 / §6.14 |
| 3 | 「骨架太少了。只有顶部有」 | **根因**：第一版用 `bg-layer-1`（浅色主题下是纯白）画条与块，等于没画，用户只看见头部两行。改用宿主自己的占位 token `--dsw-alias-bg-skeleton` / `--dsw-alias-border-l2` | §5.3 / §6.14 |
| 4 | 「样式难看。应该底部有输入框的骨架，上面有大块的骨架填充」 | 骨架重做：**三个大块**（`3 : 2.2 : 1.6` 比例、`100% / 86% / 64%` 宽度、带文字线）填满身体 + **底部 composer 骨架**；块用 `box-sizing: border-box`，否则百分比宽度会被 padding 撑出格子 | §5.3 / §6.14 |
| 5 | 「输入框骨架较小」 | composer 骨架按真实卡片尺寸放大：`min-height: 104px`、`padding: 16px`、输入行 12px 高 / 58% 宽、工具栏 4 个 chip（`54/32/32/22px`）× 12px 高，`space-between` 把输入行与工具栏上下分开 | §5.3 / §6.14 |
| 6 | 「对话的大块骨架内容中浅色行骨架较少，多填充一些」 | 每块文字线加到 **12 / 8 / 6 条**（`flex: 0 0 12px`、`gap: 8px`、`space-between`），铺满块高；线宽取自一组不规则值，读起来像正文而不是表格 | §5.3 / §6.14 |

### 9.0f 2026-10-20 第十一轮：新建入口挪到每个工作区行（发布后改动）

| # | 反馈（用户） | 处置 | 落点 |
| --- | --- | --- | --- |
| 1 | 「把『在此新建会话』从右列底部挪到左列每个工作区后面，只有 hover 该工作区才展示（同会话的『归档』），点击后在该工作区新建；后续逻辑不变」 | `＋会话` 变成**左列每行 hover 才出现**的动作（`data-mixer-new="<workspaceId>"`，独立点击区、`stopPropagation`），点击 → 用**该行工作区**走同一条 `sessions.create` / 空白复用 / 置顶 / 光标交接路径。右列底部的按钮删除，底部只留提示行。**推翻了 §5.2 的 2026-10-15 决定「新建仍从 `会话` 浮层底部进入」**（但仍不是顶栏的独立 `＋`），以及 §9.0b 第 6 条的「左列只定新建落点」 | §5.2 / §6.13 / §6.15 |
| 2 | 「左列每个工作区要 hover 态，否则视觉效果不明显」 | **根因**：旧代码的 hover/选中底色用 `bg-layer-1`，而它在浅色主题里是纯白，等于没有。改用宿主的 `--dsw-alias-interactive-bg-hover`（浅 `rgba(38,49,72,.06)` / 深 `rgba(255,255,255,.08)`），**会话行 hover 同批换掉** | §5.2 |
| 3 | 「hover 时，按钮和背景一个颜色，不够明显，能否再亮一些（包括新建会话和归档两个按钮）」 | 行内动作统一换底：`bg-layer-2`（浅色=白、深色=#2c2c2e，都贴着行底）→ **`--dsw-alias-button-elevated-fill`**（浅色=白、深色=#43454a，比 hover 底色亮一档）+ `border-l2` 描边 + `label-primary` 文字 + 600 字重。`＋会话`、`归档`、`停止并归档` 三处同一套 | §5.2 |
| 4 | 「按钮 hover 可以更高亮些吗，区分出按钮平常态（行 hover 时）和按钮 hover 态」 | 注入 `[data-mixer-row-action]` 的两态规则：`:hover` 用 accent wash（浅 14% 墨 / 深 24% 白）+ `border-l3`，与行 hover 底（6% / 8%）拉开；`:focus-visible` 给 2px `state-business-primary` 焦点环。行内样式压不住伪类，所以用注入规则 + `!important` | §5.2 |
| 5 | 追问澄清（用户答 A）：「点行 = 右列滚到该工作区的会话；点『新建会话』= 在此工作区新建」 | **「新建落点」概念退休**：去掉选中高亮、「新建落点」标签与 `landingWorkspace` 纯函数缝（连同镜像宿主 `recentWorkspace` 的推导）。左列点击只剩"跳转右列"一件事。`CONTEXT.md` 移除该术语（"新建落点"不再出现于任何文案与钩子：`data-mixer-landing*` → `data-mixer-workspace*`） | `CONTEXT.md` / §5.2 / §11 |

### 9.0g 2026-10-20 第十二轮：归档可撤销（issue #12 增补）

| # | 来源 | 处置 | 落点 |
| --- | --- | --- | --- |
| 1 | issue #12 增补（2026-10-20 记录）：调音台的归档破坏性且默认无二次确认，误点无处可退；侧边栏有 6s toast + `撤销`，调音台没有对应出口 | 顶栏加一条 6s 的 `已归档「…」撤销` chip，调 `ctx.uiWorkspace.unarchiveSession`（与侧边栏 `undoArchive` 同一服务方法），成功后**放回原位置并恢复原宽度权重**；只保留一条、失败必须可见。配 `restoredSessions` 剪枝豁免（§4.1 第三道护栏）与 `ARCHIVE_UNDO_MS = 6000`（镜像宿主 toast 的 hold） | §4.1 / §5.2 / §6.21 / §11 |

### 9.0h 2026-10-20 第十三轮：通道间跳转快捷键

| # | 来源 | 处置 | 落点 |
| --- | --- | --- | --- |
| 1 | issue #12：快捷键：通道间跳转、solo 当前通道 | 本轮只做**跳转**（用户 2026-10-20 选定范围，solo 留在后续轮）；solo 的形态与出现时机另行确定 | §5.6 / §6.22 |
| 2 | 键位与接入方式 | 走**宿主快捷键服务**（`ctx.shortcuts.register`：可发现 / 用户可改键 / 宿主仲裁冲突），`primary+alt+Digit1..9` 与 `primary+alt+BracketRight/Left`（初版曾是方向键，因 Linux 保留键与 macOS 媒体键两处平台层冲突改为方括号，见第 4/5 行），`regions: ['page','editable']`；不用时不吞键（`pass`），缺通道给 `blocked` + 原因 | §5.6 |
| 3 | 跨作用域 | 快捷键在 `apply` 注册、面板每次渲染 publish `mixerRuntime`（`ids`/`focus`/`step`），卸载清空 —— 键击不会作用在过期通道列表上 | §5.6 / §11 |
| 5 | 修（2026-10-20，浏览器实测）：`Cmd+Option+←/→` **切换了音乐 App 的歌曲**，通道不动 | 该类组合被 **macOS 系统媒体键**在页面之前收走，页面侧无解 —— `next`/`prev` 的默认键位**全平台**改成 `primary+alt+]` / `[`（与 Linux 原方案合并成一套）；并在 `host-contract` 的快捷键用例里加一条**平台习惯守卫**：任何 `primary+alt+Arrow*` 默认值都直接判红（宿主 `bindingIssue` 看不到 OS 级占用） | §5.6 / §6.22 |
| 4 | 修（2026-10-20，同轮冷启动）：装进 profile 后 `pnpm dsh web` 报 `web boot: 1 entry did not activate / dsh-mixer: failed` | `primary+alt+方向键` 在 **Desktop Linux** 被宿主判为 `reserved`，而默认键位要在全部五个 profile 上过检（与当前设备无关）→ `register()` 抛 `Reserved shortcut default`。Linux 改用方括号，其余平台不变；新增宿主侧真检查（跑宿主自己的 `bindingIssue`）钉住这一类 | §5.6 / §6.22 / `tests/host-contract.test.mjs` |

### 9.0i 2026-10-20 第十四轮：solo

| # | 决定（用户 2026-10-20 答 A/A/A/A） | 落点 |
| --- | --- | --- |
| 1 | **窄条 64px**：状态点 + 截断标题（悬停出 tooltip），点窄条切过去 | §5.7 / §6.23 |
| 1b | 追加（同轮浏览器反馈「缺少明显的分界，几乎找不到」）：窄条改用**凹陷表面** + 右缘 1px 分界线 + 主色标题，悬停保留表面并加 2px 强调色左缘 | §5.7 / §6.23 |
| 2 | **进入/退出三处**：通道头部 `solo`/`退出` 按钮、顶栏 `solo：… 退出` chip、快捷键 `Cmd/Ctrl+Alt+S`；**不用 `Esc`**（那是宿主的停止生成键） | §5.7 / §5.6 |
| 3 | **被 solo 的通道消失（归档/剪枝）→ 自动退出 solo**；新建会话照常插到第 0 位且不抢走 solo；solo 期间暂停分界线与头部拖动 | §5.7 |
| 4 | **不持久化**：状态放插件作用域（跨重挂存活、刷新回并排），宽度权重全程不动 | §5.7 |

### 9.0j 2026-10-21 第十五轮：架构评审落地（A–E）

一次 `/improve-codebase-architecture` 走查（`git log` 近 40 次提交定位热点 + 主线与子代理各一遍 + 交叉核对）产出五个候选，用户要求按强度顺序全部落地。原则：**纯重构，行为不变**；单文件约束内做 seam；不碰 ADR-0001–0003。

| # | 候选 | 强度 | 落地（module） | 判据 |
| --- | --- | --- | --- | --- |
| A | 「谁还在板上」没有单一所有者：一条规则拆成 2 个 effect + 3 个豁免集合 + 6 个写入点，两个豁免句柄逐字重复 | Strong | `createChannelLedger()`：豁免记**原因**（born / returned），`survivors` / `staleWeights` 是唯一定义 | §11 缝表 · `seams` 用例 |
| B | 「点了不能没反应」被手抄三遍（各含五种结局） | Strong | `createHostCalls()`：五种结局各一次，调用点只声明特有事实 | §11 · `seams` 用例 |
| C | 6 个握手对象（18 成员、11 prop）+ React 镜像 + ref 缓存 | Strong | `createViewState()`：可订阅，自己发通知；面板 props 25 → 16 | §5.6 / §5.7 / §11 |
| D | 「光标在哪个通道 / 找通道 / 聚焦它」手写三遍，虚影又重推一遍 pane 部件 | Worth exploring | `createChannelDom(doc?)`：`data-mixer-*` 与宿主钩子只在此拼写；`focus()` 的 false 是帧重试信号。**CSS 半边不动**（仍 Speculative） | §11 · `seams` 用例 |
| E | 宿主被建模三次，加一条服务边要改三处且副本之间无哨兵 | Worth exploring | `tests/host-face.mjs`：fixture 共享、断言不共享；`boot-check` 仍走真 Cordis 且保留 control | §11 · `host-contract` 哨兵 |

**同轮追加（用户反馈 2026-10-21）**：跳转 / 新建交接之后**光标落在草稿末尾** —— 由 `createChannelDom().caretToEnd(field)` 处理两种 composer 形态（plain `setSelectionRange` / 富文本 `Range.collapse(false)`），验收写进 §5.6 与 §6.24。

**评审里明确没做的**：不拆 `client.js`（宿主只加载这一个文件）；不给 CSS 注入规则建 adapter（宿主类名/钩子改名仍需人工核对，Speculative）；不把 `host-contract` 的断言搬进 fixture（否则错的假设会同时通过两边）。

### 9.1 仍开放

- **钉住视图不写会话记忆**（§4.4 边界）：要"点了就记住"，需上游暴露 store 或 `selectView` 动作。
- **「从调音台出来后左侧栏仍折叠」只在自动化路径里见过一次**（2026-10-21，无头浏览器归档掉当前会话后落到空白会话）：用户日常使用**从未遇到**，且未能在脚本里稳定复现，暂不当作 bug。若日后复现，先查 §7.1 的折叠探针时序（面板被宿主卸载时 `restore()` 读到的 `data-sidebar-collapsed` 可能还是旧值）。
- ~~真实格内点审批卡未端到端实测~~ —— **2026-10-21 已实测通过**（无头 Chrome + CDP 驱动真实宿主：卡片出现在对应格、其它格无卡、点 `允许一次` 后 ~1.6s 清除并继续执行，见 §6.25）。只测了 `approval` 这一种 kind；`plan-review` / `question` 走同一条 `conversation.composer` overlay 链（`ui-user-questions` 的 `PendingQuestion` 同时承担两者），机制同源但**尚未逐个点过**。
- **侧栏折叠状态需 layout API**（§7.1）。
- **`completionUnread` 绿点在本插件里不会被"看过"清除**（§4.3b 语义陷阱）：v1 接受该语义；若日后不可接受，备选是插件自持一份 seen 集合、只在插件内算未读。
- **UI 文案 locale 服务**：二期再查宿主 locale 服务的用法（宿主文案表如 `ui-workspace/src/client/locales.ts` 是 per-package 的）。
- **spike → 正式包的迁移**：**已完成**（分支 `feat/mixer-v1`，见 §11），并且**已在根包上重跑 §6** —— 2026-10-15 用户实测验收通过（见 §6 验收记录；要防的第 4 轮那个"热重载正常、冷启动炸整页"没有复现）。`spike/` 工作区目录与 profile 里那条 `dsh-mixer-spike` 软链均已清除；原型本体仍在 `spike/mixer-two-pane` 分支上。
- 更远的增强想法集中在 [issue #12](https://github.com/dtdths/dsh-mixer/issues/12)（`needs-triage`：通道间跳转 / solo 快捷键、solo/mute 持久化、多条待审批计数需上游、跨 workspace 混排…）。
- **「移出」与 `mute` 的命名已定**（用户 2026-10-15 决定）：`×` 的行为在术语表里定名为 **「移出（put away）」**，实现叫 `parked`（store 里没有这条状态，只在插件作用域）、UI 文案与顶栏钩子仍叫「已移出」/ `data-mixer-hidden`；**`mute` 一词不用于此事**，保留给将来"通道还在、只是不打扰"的能力（要与 solo 一起定持久化）。理由：`×` 的语义是"从这块屏上拿走"，叫静音反而误导。
- **新建失败的反馈面（已定一半）**：`ctx.sessions.create` 抛错（如 `session/writer-held`、工作区已失效）时，插件在**顶栏**给一条带原因的提示（`data-mixer-create-error`，文案取 `error.message`），并 `console.error` 留档；这样不会变成"点了没反应"。仍开放的是**是否接宿主同一套通知服务**（宿主的 `startSession` 经 notify 报 `createFailed`）——那需要新增一条服务边并核实其行为，留到下一轮。
- **顶栏全文搜索**（二期）：B 的 `会话` 浮层本期只做**本地标题过滤**。走宿主 `ctx.sessions.search` 要过 Host、结果是请求级的（含 loading / 错误 / abort），且标题匹配的会话不在其中 —— 两套结果要合并，属另一个量级的功能。

## 10. 原型资产（`spike/mixer-two-pane` 分支）

- 分支：`spike/mixer-two-pane`（一次性验证用的历史分支，`main` 保持干净）
- 包：`spike/`（`dsh-mixer-spike`）—— **正式版不再依赖它**，安装根包后应把它从 profile 卸掉
- 守卫：`spike/boot-check.mjs`（已被根包 `boot-check.mjs` 取代，见 §11）
- 变体：原型条可切 V1/V2/V3（V2 已选定）、三档内容模式（模拟 / 真实·默认 / 真实·标签）
- 只在这里保留的东西：模拟内容（`MOCK_TASKS` 等）、原型条与变体切换、模拟等待/执行 staging、DOM 诊断探针与诊断行、粘贴式读数与「（模拟）」标注
- 设计原型（一次性，不属于插件）：`docs/prototype/mixer-topbar.html` —— 顶栏 A/B/C 三方案对照，可点击，含空会话 hero 与"让位"静态示意。它**不装进宿主**、不参与 `npm run check`；定形态（方案 B）后由 spike 真机版替代（§9.0b 第 7 条）。

## 11. 正式版实现状态（分支 `feat/mixer-v1`）

**根包 `client.js` 已按 §1–§8 实现完毕**，`spike/` 的机制全部搬入并按 §4 的"三类迁移"处理：脚手架删除、已定稿机制直搬、凑合实现换掉（`localStorage` → store、折叠探针隔离成 seam、诊断删除）。

| 位置 | 内容 |
| --- | --- |
| `client.js` | 单文件 Client half（模块加载器只认这一个文件，所以缝只能是文件内的纯函数） |
| `boot-check.mjs` | 冷启动守卫：真实 Cordis Context + 对照项，并断言 `main` 的 session 子槽与 board store |
| `tests/seams.test.mjs` | `node --test` 覆盖 19 个纯函数缝 / module + 1 张文案表（24 个用例）；`client.js` 的返回值多挂一个 `__test` 字段把这些缝暴露给测试（宿主只读 `inject` / `apply`，其余键被忽略） |
| `tests/render.test.mjs` | 用**宿主的真 React + react-dom/server** 把面板渲染成静态 HTML（10 个用例）：状态标记、面包屑、每格工厂内容、分栏把手、宽度落到 flex、空态、状态回落、**空会话必须拿到 hero 相位**、缺 store 的降级路径。纯函数测试看不见 React 层，靠这一层补 |
| `tests/interaction.test.mjs` | 把面板挂进 **jsdom + react-dom/client**，用真事件驱动（35 个用例）：× 关闭后停靠并可从顶栏放回（且 retain 未释放）、`会话` 浮层勾选写 board 与本地标题过滤、**左列行点击只把右列滚到该工作区、不导航，且行 hover 的「＋会话」在该工作区建会话并落第 0 位**、**新建走 `ctx.sessions.create` 并置顶 + 光标落在新格**、**刚新建完的主动离开不被抢回**、**复用同工作区空白会话**、**宿主入口的窄条件抢回（主动离开不抢）**、`Esc`/再点触发器/点浮层外三种关闭、**顶栏不出现工作区名而面板里出现**、**新建失败在顶栏可见**、**光标交接等迟到的 composer**、**触发器要有按钮样式**、**点左列工作区滚动右列**、**归档会话不在列表里**、**悬停出行尾归档且归档后该格关掉**、**正在执行先问一次再停止并归档**、**归档抛错/缺 API 都要出提示**、**归档进行中显示"归档中…"**、**归档后 6s 可撤销：通道回到原位置 + 原宽度、只保留最新一条、拒绝/缺方法都出提示**、**通道间跳转快捷键：注册 12 条、跳到第 N 个通道并聚焦、未打开时不吞键、越界与无通道给提示、next/prev 首尾环绕**、**solo：进入后其余通道变窄条、点窄条切换、退出后宽度权重不变、被 solo 的通道消失则自动退出、快捷键按光标所在通道 solo（无光标时给提示）**、视图标签经工厂 seam 钉住 view、焦点标记、拖分界线（比例 + 380 夹紧 + 收尾）、头部拖动载荷（含**同尺寸替身虚影**：真实头部克隆、身体按 `bodyFitsCell` 克隆或骨架、离屏、下一个 task 移除，与 `.4` 占位）与「从 × 起拖被拒」、**空会话虚影保留 hero 与 composer**、**越界通道的虚影身体是骨架**、轨道 drop 重排并拒收非会话负载、**拖动时同宽空槽（让位）** |
| `tests/store.test.mjs` | 用**宿主的真 store 引擎**跑持久化（5 个用例）：键名与 root 无后缀、坏数据逐字段兜底、第二个实例恢复、无 localStorage 时的可用性 |
| `tests/sidebar.test.mjs` / `tests/labels.test.mjs` | 折叠幂等（5 个）与措辞对齐宿主字典（5 个） |
| `tests/host-contract.test.mjs` | **宿主契约漂移哨兵**（11 个）：`external` 的名字仍在该 checkout 的平台静态表与 seed 表里、`inject` 每条边都指向真实存在的包、slot 注册仍提供 `store` 与 session 子槽座位、root store 仍以无 key 方式实例化、侧栏行状态的四个事实与三种 kind 仍在、轮次导航仍由容器查询隐藏、归档撤销仍走 `unarchiveSession` 且 toast hold 仍是 6000ms、快捷键注册表 `Shortcuts.register` 的形状与区域仍未变、**每条默认键位都过宿主自己的 `bindingIssue` / 冲突判据（五个 profile 全部）**、**注入名单与 `tests/host-face.mjs` 的 `HOST_SERVICES` 完全一致且 fake 真的提供每个服务**。其中前两条与最后一条是真检查（能真失败），其余是锚点检查（命中 = 机制还在，不等于行为不变） |
| `package.json` | `dsh.client.external` = store + primitives；`inject` = shortcuts / commands / conversation / layout / workspace（Cordis 服务边：slots / sessions / layout / uiWorkspace / shortcuts）；脚本 `test` / `boot-check` / `check` |

**换宿主怎么验**（拉新 DSH 分支、或换一个 checkout 构建运行之后）：

```bash
cd dsh-mixer
DSH_REPO=/新的/checkout 路径 npm run check
```

`tests/` 与 `boot-check.mjs` 都认 `DSH_REPO`（默认 `/Users/user/Documents/code/deepseek-harness`），会把**新 checkout 的真 React / 真 store 引擎 / 真 Cordis / 真侧栏字典**拿回来重跑；`tests/host-contract.test.mjs` 会直接指出**哪一条宿主契约移动了**，而不是等你发现某个状态点不对。

**接线假设（已逐条对着宿主源码核实，不要再靠猜）**：

| 假设 | 证据 |
| --- | --- |
| `external` 里那两个名字在运行时可解析 | 壳层的平台静态表就是 `react` / `react-dom` / `cordis` / `dsh-client-store` / `dsh-client-ui-slots` / `-primitives` / `-dockkit`（`packages/client/web/src/seed.ts:24-39`）；且它们不是 boot row，所以只加"可解析性"、不加图边（`modules/src/index.ts:493-522`） |
| keyed 面板也能拿到 `useStore` / `actions` | 组件注册（非 factory）走 `scoped-slots.tsx:568-572` 的 `host.storeOf(entry, …)`，声明了 store 就注入这两个 prop |
| root 作用域 store 的 persist key **不加后缀** | `registry.ts:605-627`：`scope === 'root'` 时 `handle.create()` 不带 key，只有 session 实例才 `create(key)` |
| factory 声明 `persist` 会抛错，handle 不会 | `registry.ts:650-651`：只有 factory store 的 `spec.persist` 被当成装配错误。本插件传的是 handle，所以安全 |

**内部缝**（React 层只做渲染，判断全在这些纯函数里）：

| 缝 | 职责 |
| --- | --- |
| `channelState({pendingKind, running, subagents, completed})` | 五档优先级与配对（§4.3b），返回 `key` + 点描述 |
| `visiblePendingKind(entry)` | 等待 kind 白名单 |
| `runningSubagentCount(catalog, isRunning)` / `subagentCatalogOf(list, id)` | 子代理计数 |
| `normalizeBoard(raw)` | 持久化坏数据回落（§4.1）；**保留所有合法权重**（× 移出的通道回来还按原比例） |
| `moveChannel(current, id, index)` | 拖放的插入位修正（头部排序 + 侧栏拖入同一条路径） |
| `resizedWeights(drag, clientX)` | 拖宽的比例换算与 380px 夹紧 |
| `crumbsFor(summaries, id)` | 面包屑上溯（6 级上限 + 环保护） |
| `createSidebar(ctx)` | 折叠探针**唯一**所在地（§7.1，含"上游有 API 就换掉"的注释） |
| `createBoardStore()` | `defineStore({persist:'dsh.mixer.v1'})`；store 不可用时退化到内存实现 |
| `heroFor(summary)` | 空会话相位（§4.4，需求1）：返回 `{ phase, hero }`，判据照抄宿主 |
| `blankTargetFor(list, workspace, archivedIds)` | 复用同工作区空白会话的挑选（§4.1，需求2） |
| `shouldReclaimPanel({ leftMixer, activePanelId, revealed })` | 窄条件抢回面板（§5.1 / ADR-0003，需求2）：`revealed = { id, blank }` 来自宿主 `mainView` |
| `archiveActivityOf(reason)` | 宿主"正在执行"拒绝的识别（§5.2，第四轮）：按错误名 `WorkspaceArchiveError` + `workspace/session-active`，与 ui-workspace 同判据 |
| `createChannelLedger()` | **板成员账本**（§4.1 / §9.0j）：`note/forget/reasonOf/graduate/survivors/staleWeights`。「什么算 gone」的唯一定义；豁免记原因（`born` / `returned`）而不是布尔，因为两者毕业时机不同 |
| `createHostCalls({notify, pending})` | **宿主调用结局 runner**（§5.2 / §9.0j）：缺方法 / 同步抛 / 拒绝 / 可确认的拒绝 / 成功，五种结局各一次；返回 `run(spec)`，调用点只声明自己特有的事实 |
| `createViewState()` | **插件作用域视图状态**（§5.6 / §5.7 / §9.0j）：`subscribe/snapshot/setSolo/park/unpark/clearParked/parkedIds/handOff/take/publish/channels/commands`。solo + 移出 + 重挂交接的唯一所有者，自己发通知 |
| `createChannelDom(doc?)` | **通道 DOM adapter**（§9.0j）：`channelOf/caretChannel/paneOf/headOf/tabsOf/bodyOf/scrollerOf/fieldOf/reveal/focus`。`data-mixer-*` 与宿主钩子只在这里拼写；`focus` 返回 false 表示 composer 还没上屏（面板据此帧重试） |

另有四条行为常量，**只在文档与代码注释里约定、不进 `__test`**（它们不是判断，是时序参数，钉一个数字等于写同义反复）：`FOCUS_RETRY_FRAMES = 30`（光标交接等宿主 composer 出现的帧数上限，§5.1③）、`RECLAIM_WINDOW_MS = 2000`（抢回判据的时效窗，§5.1）、`HERO_LIFT_PX = 48`（空会话 hero 的光学上调，§4.4）与 `ARCHIVE_UNDO_MS = 6000`（归档撤销的时效窗，镜像宿主 toast 的 hold，§5.2）。

后 4 条是 2026-10-15 第二轮新增（需求 1 / 2 / 4）。**用例数已落地**：v1 的 53 例 + 第二轮 15 例 = **68 例**全绿（`seams` +4、`render` +1、`interaction` +10）；第三轮再 +1（`interaction` 的「触发器要有按钮样」）；第四轮 +4（`seams` 的 `archiveActivityOf` + `interaction` 的归档过滤 / 悬停归档 / 停止并归档）；第五轮 +2（归档同步抛错 / 未提供 `archiveSession` 都要出提示，以及 `归档中…` 的进行中态）；第六轮 +1（`host-contract` 的 inject 名单哨兵）；第七轮 +1（`interaction` 的「替身虚影同尺寸/带真实头部/下一个 task 撤销」）；第八轮 +2（`interaction` 的「空会话虚影保留 hero 与 composer」「越界通道的虚影身体是骨架」）；第十一轮 **−1**（`landingWorkspace` 缝随「新建落点」退休一并删除，`interaction` 的左列用例原地改写为「跳转 + 行内新建」）；第十二轮 +4（`interaction` 的归档撤销三例：回原位/回宽度、失败与缺方法、只保留最新一条；`host-contract` 的归档撤销锚点）；第十三轮 +4（`interaction` 的通道跳转三例：跳第 N 个并聚焦、不吞键与越界提示、next/prev 首尾环绕；`host-contract` 的快捷键注册表锚点）；同轮修 +1（`host-contract` 的「默认键位过宿主校验」）；第十四轮 +3（`interaction` 的 solo 三例）;**第十五轮（架构评审落地）** +5（`seams` 新增 ledger / runner / view state / DOM adapter 四例 —— 每例把一个 module 的规则一次钉住；`host-contract` 新增 host-face 名单一致性哨兵）；第十六轮 +1（`interaction` 的「空板上新建通道保留可见通道」）= **96 例**。`tests/harness.mjs` 的假宿主已补齐 `ctx.sessions.create` 的记录、`sessions.list` / `layout.panelInfo` 两个可订阅源（含 `setList` / `setPanelInfo` 驱动），并且 `useStore` 改成真的订阅 + 版本号重渲染——原来只读快照，导致"面板自己的写入"在测试里根本不会触发重渲染，`×` 关闭那条用例是靠别的原因才过的。

**验证**：`npm run check`（语法 + **53 个用例** + 冷启动）在本机全绿；**浏览器行为已由用户按 §6 十条在根包上验收通过**（2026-10-15，装根包 + 卸 `dsh-mixer-spike` + 硬刷新；见 §6 验收记录）。
**第二轮（需求 1–4）实现后的验证**：`npm run check` = **76 个用例全绿** + 冷启动 `PASS`（2026-10-15）；**§6 第 12–20 条属观感项，由用户在浏览器里逐条验收** —— 尤其"整格虚影"与"让位"两处只有真拖拽能验。

**第三至六轮（浏览器实测 → 修复）的验收记录（2026-10-15）**：用户在浏览器里逐轮实测并回报。**已确认可用**：§6.17 顶栏可读性、§6.18 浮层跳转、§6.19 归档过滤、§6.20 面板内归档（含"正在执行先问一次"）—— 最后一轮修掉了 `uiWorkspace` 缺失的**服务边**（见 §9.0c 第 6 行），用户复测「正常了」。

**发布 v1.0.0（2026-10-20）**：`package.json` bump 到 `1.0.0`，`main` fast-forward 到与 `feat/mixer-v1` 同点，打 annotated tag **`v1.0.0`**，GitHub Release 附安装命令（`install_bundle target = "github:dtdths/dsh-mixer#v1.0.0"`）与验证过的 DSH runtime 版本（`0.2.1-alpha.1` / checkout `5badb15`）。发版前 `npm run check` = 79 用例 + 冷启动 `PASS`。

**发布 v1.5.1（2026-10-21，空板新建 bug 修复 + 文档 + README 改版）**：`package.json` bump 到 `1.5.1`，`main` fast-forward，tag **`v1.5.1`** + GitHub Release。内容三项：① **修 bug**（`5c0e57f`）—— 空板上点 `＋会话` 会把其它**可见**通道挤掉：`acceptNewChannel` 拿"持久化的板"（可能为空数组）当插入基准，改用 `visibleRef`（看得见的板），回归用例先红后绿验证过（`interaction` 的「空板上新建通道保留可见通道」）；② 文档两条（`2e82168` 格内审批卡 §6.25 端到端实测、`c3b81c9` 侧栏折叠观察记为非 bug）；③ **README 改版**（`98461ce` / `30bb861`）—— 卖点先行 + 一行安装命令 + 上手指南 + 真实宿主截图（`docs/assets/`，含 `PROVENANCE.md`；主图三格同框：空对话 / 等待审批 / 执行中）。`npm run check` = 96 用例 + 冷启动 `PASS`；验证过的 DSH runtime：`0.2.1-rc.2`（checkout `687f282`）。

**发布 v1.5.0（2026-10-21，架构重构 + 光标落末尾）**：`package.json` bump 到 `1.5.0`，`main` fast-forward，tag **`v1.5.0`** + GitHub Release。内容：五个 module 深化（成员账本 / 宿主调用 runner / 插件作用域视图状态 / 通道 DOM adapter / 单一 host fixture，§9.0j）—— **纯重构、行为不变**；外加跳转后光标落在草稿末尾。`npm run check` = 95 用例 + 冷启动 `PASS`，用户浏览器复验归档撤销 / solo / 跳转三条路径与光标位置均通过。

**发布 v1.4.0（2026-10-20，solo）**：`package.json` bump 到 `1.4.0`，`main` fast-forward，tag **`v1.4.0`** + GitHub Release。内容：solo（64px 窄条 + 状态点、三处进出、被 solo 的通道消失则自动退出、不持久化、窄条与主通道的分界）与 `mixer.channel.solo` 快捷键；`npm run check` = 90 用例 + 冷启动 `PASS`，用户浏览器验收通过。

**发布 v1.3.0（2026-10-20，通道间跳转快捷键）**：`package.json` bump 到 `1.3.0`，`main` fast-forward，tag **`v1.3.0`** + GitHub Release。内容：11 条跳转命令走宿主快捷键服务（`primary+alt+1..9` / `primary+alt+]` `[`，可改键）、新服务边 `shortcuts`、以及同轮两次平台层修复（Linux 保留键导致冷启动整页失败、macOS 媒体键抢走方向键）；`npm run check` = 87 用例 + 冷启动 `PASS`，用户浏览器验收通过。

**发布 v1.2.0（2026-10-20，归档可撤销）**：`package.json` bump 到 `1.2.0`，`main` fast-forward，tag **`v1.2.0`** + GitHub Release。内容：顶栏 6s `撤销`（`ARCHIVE_UNDO_MS`）、通道回原位/回宽度、`restoredSessions` 剪枝豁免（§9.0g / §5.2 / §4.1）；`npm run check` = 82 用例 + 冷启动 `PASS`。

**发布 v1.1.0（2026-10-20，发布后一轮交互改版）**：`package.json` bump 到 `1.1.0`，`main` fast-forward 到本点，tag **`v1.1.0`** + GitHub Release。内容：`会话` 浮层的新建入口挪进左列每个工作区行（hover 出 `＋会话`，§9.0f 第 1–2 行）、左列行 hover 与行内动作按钮的平常/hover 两态改用可见 token（§9.0f 第 3–4 行）；`npm run check` = 78 用例 + 冷启动 `PASS`，用户浏览器逐项验收通过。

**第十五轮（2026-10-21，架构评审：五个 module 深化）**：`npm run check` = **95 个用例 + 冷启动 `PASS`**。按评审报告的强度顺序落地 A→E（§9.0j）：成员账本、宿主调用结局 runner、插件作用域视图状态、通道 DOM adapter、单一 host fixture。**纯重构**：行为不变，但把「什么算 gone」「点了不能没反应」「活过重挂的状态」「DOM 词汇」「宿主服务表」各收进一个 module，并各配一条 seam 用例。面板 props 由 25 降到 16（握手类 11 → 2）。**待用户浏览器复验**（尤其归档撤销、solo、通道跳转三条路径）。

**第十四轮（2026-10-20，solo，issue #12）**：`npm run check` = **90 个用例 + 冷启动 `PASS`**（`boot-check` 的快捷键断言同步到 12 条）。窄条 64px + 状态点、三处进出（头部按钮 / 顶栏 chip / `Cmd/Ctrl+Alt+S`）、被 solo 的通道消失则自动退出、不持久化（§5.7 / §9.0i）。**用户浏览器验收通过**；同轮按反馈补了窄条的分界（凹陷表面 + 1px 分界线 + 主色标题，§9.0i 第 1b 行）。

**第十三轮（2026-10-20，通道间跳转快捷键，issue #12）**：`npm run check` = **87 个用例 + 冷启动 `PASS`**（`boot-check` 新增断言：冷启动时 11 条快捷键命令都注册成功）。走宿主快捷键服务（新服务边 `shortcuts`），`primary+alt+数字` 与 `primary+alt+]` / `[`；**用户浏览器验收通过**（数字键与方括号均正常；方向键在 macOS 被媒体键抢走，已改）。
**同轮修（2026-10-20）**：装进 profile 后 `pnpm dsh web` 报 `web boot: 1 entry did not activate / dsh-mixer: failed` —— 方向键默认值在 Desktop Linux 被宿主判为 `reserved`。改键位 + 新增宿主侧的真检查（`npm run check` 变红过一次，确认能拦住同一类回归）；用户复验冷启动正常。随后又发现 `Cmd+Option+←/→` 在 macOS 被系统媒体键抢走，`next`/`prev` 全平台改为方括号并加平台习惯守卫，**用户复验通过**。

**第十二轮（2026-10-20，归档可撤销，issue #12 增补）**：`npm run check` = **82 个用例 + 冷启动 `PASS`**。顶栏 6s 撤销 + 通道回原位/回宽度 + 剪枝豁免（§9.0g），**待用户浏览器验收**。

**第十一轮（2026-10-20，发布后的交互改版）**：`npm run check` = **78 个用例 + 冷启动 `PASS`**（−1 是因为 `landingWorkspace` 缝随「新建落点」一起退休）。改动是「新建入口挪进左列工作区行 + hover 态可见」（§5.2 / §9.0f），**待用户浏览器验收**；验收通过后再决定是否发 v1.1.0。

**第七轮（2026-10-20，虚影根因 + 修法）**：`npm run check` = **77 个用例全绿** + 冷启动 `PASS`。用户已确认 §6.16（hero 光学位置「正好」，`HERO_LIFT_PX` 定稿 48）、以及 §6.14 的**让位**与**「拖动不会被取消」**；虚影按新实现复验通过（「现在虚影总体效果正常了」）。
**第八至十轮（2026-10-20，虚影身体内容化）**：`npm run check` = **79 个用例全绿** + 冷启动 `PASS`。第八轮把替身身体改为「框内克隆 / 越界骨架」，用户确认**空会话虚影符合期望**；第九轮按反馈把骨架重做成「三个大块 + 文字线 + 底部 composer」，并修掉第一版用 `bg-layer-1`（浅色主题下为纯白）导致的"看不见"；第十轮按反馈把 composer 骨架放大、把每块文字线加到 8–12 条铺满。骨架与 composer 的静态复现用本机 headless Chrome 截图自检过（浅/深两套主题）。**用户已在浏览器里逐轮复验并接受**（空会话虚影「符合期望」、长对话骨架「还行」），实现与验收记录一并推送。
