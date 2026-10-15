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

**交付形态**：只装 Client half，从本仓库目录安装（`install_bundle` → profile 里的 `link:`），不发布 npm。

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
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-commands"
      ]
    }
  }
}
```

`dsh.client.inject` 是**加载顺序边**，不是服务注入。建议同时声明 `-ui-renderer` / `-ui-sidebar` / `-ui-session` / `-ui-slots`（调研报告的建议），使注册顺序稳定。

## 3. 挂载点

| 用途 | 扩展点 | 关键约束 |
| --- | --- | --- |
| 整屏调音台视图 | `main`（keyed / root） | 用**自己的** key `mixer`；**不可**占用 `conversation`（会替换内置会话面板）。已占用键：`plugins` / `conversation` / `schedules` |
| 视图切换按钮 | `conversation.session.header.utilities`（list / session） | 必须 `order < -10` 才能排在「打开目录」(`open-in-app`, order `-10`) 左侧 |
| `/mixer` 指令 | `ctx.commandUi.register()`（Client 自有命令） | 必须经 `ctx.inject(['commandUi'], scope => …)`，**绝不** `if (ctx.commandUi)`（见 §8） |
| 工作区切换 / 新建会话 | `ctx.uiWorkspace.openWorkspace(id)` / `startSession(id)` | — |
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
- 选择**持久化**：正式实现走框架的 store 持久化约定（`StoreSpec.persist`）；原型用命名空间键 `dsh.mixer-spike.v1`（仿 `ui-sidebar-right` 的 `dsh.sidebar-right.v1`）。解析必须防御式：损坏数据回落默认，且**未动过的默认值不写入**。
- 首次进入默认：取会话列表最前若干（原型取 3）。空面板比一个可用起点更差，且用户可立刻改。
- 自动移除：已选通道的会话在左侧被归档（`WorkspacesSnapshot.archivedSessionIds`）或不再属于宿主列表（`list.ids`）时，从调音台移除。**两道护栏**：`list.ids` 为空（列表未就绪）时**不修剪**，否则冷启动会清空面板。
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
- **空闲档不画点**（用户 2026-10-15 决定，看过后选的）：全档对齐会让每个格子头部常驻一个灰点，实测判定为噪声。因此 **idle 是本插件唯一一处与侧栏的有意偏差**：其余四档必须与侧栏一致，空闲的格子**什么都不显示**。状态判断本身**不简化** —— 诊断读数仍打印 `状态=idle`（对应 `SHOW_IDLE_DOT = false` 这个常量），所以粘贴回来的读数不会退化成"没有状态"。
- **怎么远程核对**：真实模式每格的诊断行已加 `状态=running`、`状态=running+subagents`、`状态=completed`… 这类读数（对应头部的 `data-mixer-state`），用户刷新后可直接粘贴回来，不必开 devtools。**凡是原型条模拟开关造出来的状态，读数与 tooltip 都带「（模拟）」后缀** —— 首轮真实读数就出现「`状态=running` 与 `running=false` 并列」这种自相矛盾的行，根因是「模拟执行中」给第一格打了演示转圈、而旧读数只打真实摘要标志；现已分开打印（`状态=…（模拟）· 摘要running=…`）。**核对真实状态前，先关掉底部「模拟等待态」「模拟执行中」两个开关。**
- ⚠️ **`completionUnread` 的语义陷阱**：它由 `ui-session` 内部的 `isMain()`（即 `retainedBy.mainView > 0`）或下一轮 `running === true` 清除（`ui-session/src/client/index.ts:485-505`）。本插件的通道用**自己的** `mixerChannel` 引用来源（§4.2、ADR-0001），**不是** `mainView`，所以"在调音台里盯着这一格看"**不会**把绿点清掉，它要等该会话下一轮跑起来才灭。两选一（见 §9）：接受这个语义（绿点 = "跑完了一轮、你还没把它切回主视图"，对调音台其实合理），或本插件自己维护一份 seen 集合、只在插件内算未读。**v1 取前者**。

### 4.4 会话内容渲染

```js
renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, options?)
```

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

### 5.2 统一顶栏

顶栏**只承载折叠轨道丢掉的那部分**（见 §7.2）：`调音台` 标签 │ 工作区下拉 │ 等待汇总 │ 已移出提示 │ 常规视图。

- 工作区下拉是二级结构：一级 = 工作区（含「当前」标记与路径），二级 = 该工作区会话的复选框（即通道选择器）+「切换到此工作区」+「在此新建会话」。
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
- **关闭 `×`**：把该格移出调音台（保留 retain，顶栏汇总可放回）。
- **拖动头部排序**：通道头部 `draggable`，拖动即重排。从头部自带的控件（标签、`×`）起拖必须拒绝（`event.target.closest('button')`），否则点按钮会变成拖拽。
- **从左侧栏拖入**：拖一个会话行到通道区，按落点插入对应位置。侧栏展开时才可用（调音台会折叠它，需手动展开）。
- **放置指示**：拖动经过时在插入位置画一条 2px 的 `state-business-primary` 竖线。

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

## 6. 验证清单（装完怎么确认生效）

1. **安装**：`plugin_manager` → `install_bundle`，target = 本包目录；确认返回 `application: applied` 且 `warnings` 为空。
2. **冷启动**（关键，别用热重载代替）：**硬刷新**页面，确认**没有** `Failed to load plugins` / `web boot: N entry did not activate`。任何 `apply()` 改动都必须重做这一步。
3. **入口**：会话头「打开目录」左侧出现切换按钮；在 composer 里敲 `/mixer` 也能进入。
4. **并排**：每格渲染出官方 composer 与完整对话记录（不是空白，也不是只读快照）。
5. **独立**：两格的输入框草稿互不干扰（同一会话放进两格会共享草稿，这是契约）。
6. **等待态**：制造一次需要授权/确认的操作，对应通道应出现 V2 标记，且顶栏汇总计数 +1。三种 kind（审批 / 计划确认 / 提问）都要出标记；域注册的其它 kind **不应**出标记（§4.3b 白名单）。
7. **状态四档对齐侧栏 + 空闲无标记**（用户 2026-10-15 新增）：同一会话在左侧会话行与调音台格子里同时可见时，逐档核对一致 —— 等待（琥珀 + 竖条）、执行中（转圈）、子代理运行中（**第二个**转圈点）、已完成未读（绿点）；**空闲时格子头部不出现任何标记**（§4.3b 的唯一有意偏差，侧栏那边是灰点）。绿点的清除时机按 §4.3b 的说明核对（本插件不负责清除，下一轮 `running` 才灭）。
8. **持久化**：改动下拉里的勾选 → 刷新 → 选择仍在；拖动分界线改宽度 → 刷新 → **每格相对宽比不变**（§4.1 / §5.4）。
9. **归档联动**：把某个已选通道的会话在左侧归档 → 它应从调音台消失（且期间列表未就绪时不会误清空面板），其宽度权重一并清掉。
10. **退出**：点「常规视图」或左侧会话行 → 回到常规，滚动位置与草稿仍在；侧栏恢复原状。
11. **迁移后重跑**：以上 1–10 条在**根包**上全部重跑一遍，不能把 `spike/` 的通过当继承（§9 末条）。

## 7. 宿主限制与规避（必读）

### 7.1 侧栏无法归零

`computeColumns` 在侧栏为 0 时仍取 `SIDEBAR_COLLAPSED = 56`，所以"隐藏侧栏"实际是留一条 56px 轨道。**已定：接受轨道**，不改宿主（接管 `sidebar` 槽位会连带移除 `sidebar.settings` 座位，设置入口会一起消失）。

**另需注意**：没有任何公开 API 能读到折叠状态（`PanelInfo` 只有 `activePanelId`），`ctx.layout.toggleSidebar()` 是**盲切换**。原型因此读宿主 frame 上的 `data-sidebar-collapsed` 属性来判断 —— 这是**临时代码**。正式实现需要一个 layout 的读/写 API，否则每次进出都可能反向切换。

### 7.2 顶栏不重复轨道里的入口

折叠后的 56px 轨道**仍保留**：品牌标、面板图标（含插件、自动化任务）、**设置齿轮**（`ui-settings-general/chrome.tsx` 窄态渲染 `IconSettingsOutlineMedium`）。真正丢掉的是 `sidebar.workspaces` 整区（工作区切换 / 新建会话 / 会话浏览）。所以顶栏**只放**工作区下拉、等待汇总、常规视图；品牌 / 插件 / 任务 / 设置一律不重复。

### 7.3 原版会话头挂载不了 → 精简头

标题面包屑之外的四项（智能体团队、当前模式、用 xx 打开、下载日志）由 `conversation.session.header.actions` / `.utilities` 承载，而这些槽被 `ui-conversation` 的条目**独占声明**；插件在自己的条目里再声明同名子槽会**直接抛错**（`slot "x" is already declared`，`packages/client/ui-slots/src/index.ts:1245`）。全客户端只有一个可复用工厂，且**刻意不含 header**。

**已定：接受精简头**（面包屑 + 视图标签 + 等待/执行指示 + 关闭），不做重实现、不等上游。若日后要完整头部，正解是上游提供可复用的"会话壳"工厂。

## 8. 实现红线

- **绝不写 `if (ctx.someService)`**：Cordis 中对未注入服务的读取是**抛错**，不是 `undefined` → 守卫不生效 → 条目 `FAILED` → 宿主判定整个 Web 启动失败。用 `ctx.inject([...], cb)` 或把服务写进模块的 `inject`。
- **冷启动 ≠ 热重载**：HMR 重载时所有服务都已就位，带 bug 的代码看起来完全正常。任何 `apply()` 改动都要走冷启动验证（`node spike/boot-check.mjs` + 硬刷新）。
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

**排查手法（已内置）**：真实模式每格诊断行打印 `轮次导航 rail=/标记=/轮次=/宽=Npx（<560 才隐藏）/band=`。判据：**轮次≥2 且 宽≥560 且 rail=0 → 真异常**（此时先看是否被覆盖规则命中）；**宽<560 → 预期隐藏**。

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
| 6 | 本轮改动**先不提交**，等用户验完真实状态再一次性提交 | 交接约定 |

### 9.1 仍开放

- **钉住视图不写会话记忆**（§4.4 边界）：要"点了就记住"，需上游暴露 store 或 `selectView` 动作。
- **真实格内点审批卡未端到端实测**：机制上是官方 composer 按当前会话的 `pendingInteraction` 渲染，但尚未用真实审批点过。
- **侧栏折叠状态需 layout API**（§7.1）。
- **`completionUnread` 绿点在本插件里不会被"看过"清除**（§4.3b 语义陷阱）：v1 接受该语义；若日后不可接受，备选是插件自持一份 seen 集合、只在插件内算未读。
- **UI 文案 locale 服务**：二期再查宿主 locale 服务的用法（宿主文案表如 `ui-workspace/src/client/locales.ts` 是 per-package 的）。
- **spike → 正式包的迁移**：`spike/` 是一次性原型（分支 `spike/mixer-two-pane`），实现时把其中验证过的机制搬进根包，然后用 `install_bundle` 装根包、卸掉 `dsh-mixer-spike`。**迁移后 §6 的清单必须重跑**（第 4 轮就是"热重载正常、冷启动炸整页"）。
- 更远的增强想法集中在 [issue #12](https://github.com/dtdths/dsh-mixer/issues/12)（`needs-triage`：通道间跳转 / solo 快捷键、solo/mute 持久化、多条待审批计数需上游、跨 workspace 混排…）。

## 10. 原型资产

- 分支：`spike/mixer-two-pane`（一次性，main 保持干净）
- 包：`spike/`（`dsh-mixer-spike`，profile 里以 `link:` 指向它）
- 常驻守卫：`node spike/boot-check.mjs`（真实 Cordis Context 冷启动 + 自带对照项）
- 变体：原型条可切 V1/V2/V3（V2 已选定）、三档内容模式（模拟 / 真实·默认 / 真实·标签）
