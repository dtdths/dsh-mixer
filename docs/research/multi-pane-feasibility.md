# 多面板并排可行性调研（dsh-mixer）

调研日期：2026-10-14
调研对象：DSH 源码 checkout `/Users/user/Documents/code/deepseek-harness/`（`packages/<group>/<name>/src`），
以及已安装的 web profile `/Users/user/.dsh/profiles/web`。
结论全部来自源码阅读；凡属推断的地方都单独标注。

## 一句话结论

**能真并排。** DSH 客户端从底层就是「一个 Session 一个 `SessionReference` + 一个 `SessionProvider` 作用域」的多实例模型
（`ui-subagent` 的派生子会话面板和 `ui-sidebar-right` 的右侧栏会话视图就是这么干的），会话列表、消息流、输入框、工具审批卡片
全部按 Session 作用域寻址；因此一屏挂 N 个各自可输入、可点审批的会话面板是成立的。
唯一需要自己补的，是「谁是当前会话」这个单值约定（`retainedBy.mainView`）和亮灯信号的多路读取——
它们都不阻止并排，但都要求 mixer 使用**自己的** Session 引用来源，而不是复用 `mainView`。

---

## 问题 1：会话列表与「打开中的会话」由谁持有

### 结论

**可行（信号齐备，无需 Host 改动）。** 全量会话列表来自 Client Service `ctx.sessions.list`
（`ISessions.list`，Host 目录的镜像）；「当前打开/活动会话」**不是**一个独立的 store，而是从
`SessionSummary.retainedBy.mainView > 0` **推导**出来的约定（没有「打开集合」这个对象）。
调音台要展示的候选集合 = `sessions.list` 的全部非归档会话；要「只展示当前打开的」，就自己 retain 出来的集合说了算。

### 证据

1. 会话列表 Service 与接口（`file:line`）：

`/Users/user/Documents/code/deepseek-harness/packages/api/session-controller/src/client/contract/sessions.ts:48-51`（`ISessions.list`，完整面见同文件 `:48-163`）
```ts
/** The sessions-service face injected as `ctx.sessions`. */
export interface ISessions {
  /** Host catalog and local reference-source counts; navigation belongs to view owners. */
  readonly list: ObservableSnapshot<SessionListState>
```

2. 列表快照结构（ids / byId / phase / projectionsBySession）：

`.../packages/api/session-controller/src/client/sessions/service.ts:54`
```ts
export interface SessionListState {
  /** Host list order; every id has a matching byId row in the same snapshot. */
  ids: SessionId[]
  byId: Record<SessionId, SessionSummary>
  phase: SessionListPhase
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>
}
```

3. 「当前会话」= `retainedBy.mainView > 0` 的推导约定（三处等价实现）：

`.../packages/client/ui-workspace/src/client/tree.ts:38`
```ts
function mainSessionId(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}
```
`.../packages/client/ui-session/src/client/index.ts:437-444`（`publishMain()`，main binding 的选择逻辑）
```ts
const currentIsMain = currentId !== undefined
  && (this.sessions.retainInfo(currentId).getSnapshot().retainedBy.mainView ?? 0) > 0
const nextId = currentIsMain
  ? currentId
  : Object.values(byId).find(candidate => (candidate.retainedBy.mainView ?? 0) > 0)?.id
```

4. 「打开会话」这个动作本身就是一次 `mainView` retain：

`.../packages/client/ui-workspace/src/client/navigation.ts:404-433`
```ts
private replaceMain(target, signal, panel, beforeOpen?) {
  ...
  const reference = this.sessions.retain(target, { source: 'mainView' })   // :411
  this.mainReference = reference                                          // :431
  previous?.release()                                                     // :432
}
```

5. Shell 消费该约定的地方（说明 mainView 是全局单值的公共约定，混用会被这些地方读到）：
`.../packages/client/ui-layout/src/client/DocumentTitle.tsx:21`、
`.../packages/client/ui-workspace/src/client/shortcuts.ts:74`、
`.../packages/client/ui-open-in-app/src/client/index.ts:59`、
`.../packages/extensions/ui-cordis/src/client/CordisPanel.tsx:129`。

6. 引用来源（`source`）是**可扩展的声明合并点**，插件可以声明自己的来源：

`.../packages/api/session-controller/src/client/index.ts:79-88`
```ts
/** Consumer-owned reference labels; extend this map through the package's canonical /client entry. */
export interface SessionReferenceSourceMap {
  controllerOperation: unknown
  gateway: unknown
}
export type SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>
```
现成先例：`.../packages/client/ui-sidebar-right/src/client/session-view.ts:8-11`
```ts
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { sidebarView: unknown }
}
```
（`ui-session` 自己声明了 `mainView: unknown`，见 `.../ui-session/src/client/index.ts:182-185`。）

### 对 dsh-mixer 的影响

- 「哪些会话进调音台」有三条可选路：①`sessions.list.ids` 全量非归档；②`retainedBy.mainView > 0`（当前打开的那些，但只有一个）；
  ③mixer 自己的 `ChannelSet` store + 用户手动 add/mute。**推荐 ③**，并把「已打开会话」当初始候选。
- mixer retain 时**必须用自己声明的 source**（如 `declare module ... { interface SessionReferenceSourceMap { mixerChannel: unknown } }`），
  **不要**复用 `mainView`：一旦 mixer retain 了 N 个会话且 source=`mainView`，`DocumentTitle`、侧栏高亮、
  `ui-workspace` 的快捷键目标都会随机命中其中一个（它们用 `.find()` 取第一个），常规形态的「当前会话」语义立刻被污染。
- 数据读取用标准钩子 `useSessions`（root 作用域全局可用），定义见
  `.../packages/client/ui-session/src/client/index.ts:155-161`（`GlobalStandardProps`）。

---

## 问题 2：【生死题】多面板能否真并排

### 结论

**可行（真并排，证据充分）。** 客户端不存在「整个客户端只有一个活动会话」的硬约束：
`SessionBinding` 是对象级、可并发持有的；`SessionProvider` 显式接收一个 `SessionReference` 就能为子树建立独立作用域；
`ui-subagent` 与 `ui-sidebar-right` 都已经在**同一页面同时**挂载多个不同 Session 的子树。
「一格一个独立可用的输入框 + 独立对话记录 + 可点的审批卡片」全部成立，因为输入框、审批卡片、消息视图都是
**session 作用域**的 slot/factory，按当前 `SessionProvider` 的 binding 取数据。
唯一不能做的是「同一个会话在两格里各有一份独立草稿」——输入草稿按 `sessionId` 归一，两格同会话会共享草稿（见下「注意」）。

### 证据

**A. 会话引用可并发、可独立持有（不是全局单例）**

`.../packages/api/session-controller/src/client/contract/sessions.ts:25-72`
```ts
export interface SessionReference extends Disposable {
  readonly sessionId: SessionId
  /** Shared binding; access fails after reference release or generation disposal. */
  readonly binding: SessionBinding
  /** This reference's cancellable wait for the shared initial `Session.open()` attempt to settle. */
  readonly ready: Promise<SessionBinding>
  release(): void
}
export interface SessionRetainOptions { readonly source: SessionReferenceSource; readonly signal?: AbortSignal }
export interface ISessions {
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference
  using<T>(target, options, operation): Promise<T>
  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo>
  binding(id: SessionId): SessionBinding | undefined
  ...
}
```
`SessionBinding`（对象级，多个引用共享同一 binding，历史只开一次）：
`.../packages/api/session-controller/src/client/sessions/service.ts:98`
```ts
export interface SessionBinding {
  readonly sessionId: SessionId
  readonly session: SessionFace
  /** Contiguous event window reserved for Conversation assembly. */
  readonly eventSource: SessionEventSource
  readonly ctx: AgentContext
}
```

**B. 并发多实例是**被文档明确保证**的设计**

`.../docs/subsystems/web-client.md:60`（Conversation and presentation 章节，原文）：
> `ui-session` installs the Session scope adapter and publishes `useSessions`, `useSessionStatus`,
> `useSessionRetainInfo`, `useSession`, `sessionId`, and `useProjection`.
> **`SessionProvider` inherits an outer binding or binds an explicit `SessionReference`, so concurrent
> subtrees can target different Sessions.**

**C. 渲染层实现：显式 `session` 就换绑定**

`.../packages/client/ui-renderer/src/client/scoped-slots.tsx:510-525`
```tsx
Provider = function ScopeAreaProvider(props: SessionAreaProps): ReactNode {
  const inherited = useScopeBinding()
  const explicit = Object.hasOwn(props, 'session')
  const source = adapter.bindingSource(props.session)     // 显式引用 → 独立 source
  const resolved = useSyncExternalStore(...)
  const binding = explicit ? resolved : inherited
  return <ScopeBindingProvider binding={binding}>{renderArea(binding, props)}</ScopeBindingProvider>
}
```
`ui-session` 侧的 `bindingSource(reference)` 校验并返回该引用的 source：
`.../packages/client/ui-session/src/client/index.ts:346-354`。
`SessionProvider` 的公开契约：`.../packages/client/ui-slots/src/index.ts:344-363`
（`session?: ...` 省略=继承外层；显式传 `undefined`=显式「无会话」）。

**D. 现场先例 1：右侧栏已经在同一页面同时挂多个会话子树**

`.../packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx:17-38`
```tsx
function SessionView({ view, visible, SessionProvider, renderSlot, mountView, ... }) {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  const active = visible && view.selected
  return <div className={css.session} hidden={!active} data-sidebar-right-session={view.sessionId}>
    <SessionProvider session={view.reference}>
      {renderSlot('rightbar.session', { ... })}
    </SessionProvider>
  </div>
}
export function RightbarRoot({ usePanelInfo, useViews, ...props }: RootProps) {
  const views = useViews(value => value)
  return <>{views.map(view => <SessionView key={view.sessionId} {...props} view={view} visible={visible} />)}</>
}
```
其右侧栏 slot 声明是 session 作用域：`.../ui-sidebar-right/src/client/contract/slots.ts:43-50`
```ts
'rightbar.session': { kind: 'single'; scope: 'session'; owner: ... }
```
每个 view 自己持有一个 `SessionReference`：`.../ui-sidebar-right/src/client/session-view.ts:33`
```ts
this.reference = sessions.retain(sessionId, { source: 'sidebarView' })
```

**E. 现场先例 2（最接近 mixer 诉求）：`ui-subagent` 把一个会话内容嵌进侧栏，并复用共享会话 UI**

`.../packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:151-169`
```tsx
export type SidebarChatTabProps =
  PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'sidebar.chat.conversation'>

export function SidebarChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }: SidebarChatTabProps) {
  const { tab } = useTabInfo()
  const resource = useResource<'subagentchat'>(tab.contentId)
  return (
    <div className={css.root} data-sidebar-chat="">
      {resource.value === undefined ? null : (
        <SessionProvider session={resource.value.reference}>
          {renderSlot('sidebar.chat.conversation', {})}
        </SessionProvider>
      )}
    </div>
  )
}
```
同文件 `:125-148` 的 `ConversationSlotPanel` 在 session 作用域里直接渲染**共享的会话内容工厂**：
```tsx
export function ConversationSlotPanel({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
  ...
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
    slots: { views: FixedChatConversationView },
  })
}
```
其 slot 声明 `'sidebar.chat.conversation': { kind: 'single'; scope: 'session' }` 见同文件 `:42`，
注册链见 `:194-201`。

**F. 共享会话内容工厂就是为「多宿主复用」设计的**

`.../packages/client/ui-conversation/src/client/contract/slots.ts:226-247`
```ts
interface SlotFactoryMap {
  /** Reusable Conversation content instantiated by presentation hosts. */
  'conversation.content': {
    scope: 'session-maybe'
    props: ConversationContentInputProps      // { variant: 'main' | 'embedded'; phase; hero }
    children: {
      'conversation.session': { kind: 'single'; scope: 'session' }
      'conversation.composer': { kind: 'chain'; scope: 'session' }
      'conversation.composer.bar': { kind: 'single'; scope: 'session-maybe' }
      'conversation.input.dock': { kind: 'list'; scope: 'session' }
      ...
    }
  }
}
```
`renderFactorySlot` 是**任何** slot 组件都能拿到的框架能力（不限于本包）：
`.../packages/client/ui-slots/src/index.ts:484-496`
```ts
/** Factory rendering capability supplied to every renderer-created Component. */
export interface PropsRenderFactories { renderFactorySlot: RenderFactorySlot }
```
说明（推断，理由如下）：`renderFactorySlot` 的授权对象是**渲染位置**而不是某一个包——`FactoryOutlet` 只检查
`host.factoryOf(name)` 是否已注册、以及调用位置是否在外层 factory 递归里（
`.../ui-renderer/src/client/scoped-slots.tsx:986-996`），没有任何「只有 X 包能实例化 conversation.content」的检查。
`ui-subagent` 已经是跨包实例化它的活例子（证据 E）。

**G. 输入框：按 Session 作用域独立**

`.../packages/client/ui-conversation/src/client/service.ts:1-9, 40-71`（`IConversation` 是 scope-addressed 的，文件头 `:1-9` 是同一段说明）：
```ts
/**
 * Scope-addressed conversation send, cancel, and history orchestration.
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context ...
 */
export interface IConversation {
  readonly input: SessionInputResolver      // per-session input machine registry
  readonly blocks: ComposerBlocks
  send(text: string): Promise<void>
  updateQueue(itemId: MessageId, action: QueueAction): Promise<void>
  cancel(): Promise<void>
  loadOlder(): Promise<void>
}
```
composer 常驻槽是 session/session-maybe 作用域：`.../ui-conversation/src/client/apply.ts:315-316`
（`'conversation.composer': { kind: 'chain', scope: 'session' }`、`'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' }`）。

**H. 审批卡片：链式槽按 session 在当前格渲染**

`.../packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx:32-33, 172-176`
```tsx
const pendingInteraction = useSessionStatus(snapshot =>
  sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction)
...
const composer = renderSlotChain(
  'conversation.composer',
  { sessionId, session, pendingInteraction },
  { fallback: composerBar, fallbackOnly: sessionId === undefined, overlay: true },
)
```
`ui-approval` 往这个链里注册自己的选择器：`.../packages/client/ui-approval/src/client/index.ts:91-104`
```ts
ctx.slots.inject('conversation.composer', () => ctx.slots.register({
  name: 'conversation.composer',
  priority: 1,
  select: ({ pendingInteraction }: ComposerChainProps): PendingApproval | null =>
    pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
  ...
}, ApprovalPanel))
```
`pendingInteraction` 是**按 sessionId 查表**得到的（`snapshot.get(sessionId)`），所以 N 个格各自拿到各自那条。

### 注意（同一会话重复渲染的边界）

- **输入草稿/附件按会话归一**：`ui-conversation` 的输入状态挂在每个会话的输入机上
  （`IConversation.input`，`ui-conversation/src/client/service.ts:41-42`），因此两格渲染**同一个** session 会共享同一份草稿；
  这是合理行为（同一会话不该有两份草稿），但意味着 mixer 的正常形态是「一格一个不同会话」。
- **滚动位置/焦点是组件局部的**（`ConversationContent` 自己持有 `body` ref 和 seat 的 ResizeObserver，
  见 `ConversationContent.tsx:31-67`），多种一棵树就是独立的一份，不会互相串。
- **每个 pane 都会真实 retain 其会话**：`SessionReference.ready` 会触发 `Session.open()`
  （`.../packages/api/session-controller/src/client/sessions/service.ts:289`：`reference.attachOpening(this.manager.get(id).open(), signal)`）。
  这是好事（后台会话的历史与流是活的），但要接受 N 份历史/流的内存与重绘成本，格数要有上限。

### 对 dsh-mixer 的影响

- 每格＝ `SessionProvider session={reference}` → 渲染一个 session 作用域的槽 → 里面
  `renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active' })`。
  直接照抄 `ui-subagent` 的 `SidebarChatTab` + `ConversationSlotPanel` 结构即可（证据 E）。
- **不要**去改 `conversation.content` 工厂，也不要复制 `ui-conversation` 的内部实现；
  混音台只是多宿主之一，`variant: 'embedded'` 就是为这种用法准备的。
- 如果发现 `renderFactorySlot` 在某个渲染位置拿不到（框架 prop 组装的细节），退路是：
  mixer 主面板在自己的 `children` 里声明一个 session 作用域的子槽（如 `'mixer.pane': { kind: 'single'; scope: 'session' }`），
  像 `ui-subagent` 那样用注入的 `SessionProvider` + `renderSlot` 转一层。两条路的产物一致。

---

## 问题 3：「等待用户决策 / 权限申请」的 Client 侧信号

### 结论

**存在，而且是现成的、跨会话可读的。** 信号在 **Client** 侧：`SessionStatus.pendingInteraction`，
由各业务 UI 包（审批/提问/计划评审）通过 `ctx.uiSession.registerPendingInteraction()` 发布，
汇总进按 `SessionId` 索引的 `sessionStatus` 快照，通过全局标准钩子 `useSessionStatus` 读取。
**没有**专门的 Client 事件（不是 `ctx.on('...')`），只有可观察快照的变更订阅——对亮灯来说够用。
但有一个重要的**前置条件**：那条 pending 记录只有在**该会话的 Client 作用域活着、且对应包的监听器在场**时才会出现
（详见下面「关键限制」），所以 mixer 主动 retain 通道会话恰好也是亮灯信号能拿到的前提。

### 证据

1. 状态结构与语义（`SessionStatus` / `SessionStatusSnapshot`）：

`.../packages/client/ui-session/src/client/index.ts:60-85`
```ts
/** Independent UI status facts for one Session identity. */
export interface SessionStatus {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running: boolean | undefined
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction: SessionPendingInteraction | undefined
  /** Whether an observed stop outside the main view still needs acknowledgement. */
  readonly completionUnread: boolean
}
export type SessionStatusSnapshot = ReadonlyMap<SessionId, SessionStatus>
/** Selector hook over the unified Session UI status snapshot. */
export type UseSessionStatus = SnapshotSelectorHook<SessionStatusSnapshot>
```

2. 快照的发布主体与来源（三个域按 precedence 抢占，每会话取最高优先级）：

`.../packages/client/ui-session/src/client/index.ts:450-484`（`publishPendingInteractions`，逐域遍历、
`if (previous === undefined || precedence >= previous.precedence)` 选优）
`.../packages/client/ui-session/src/client/index.ts:520-539`（`publishStatus`，id 集合 = 列表 ∪ running ∪ pending ∪ unread）
`.../packages/client/ui-session/src/client/index.ts:383-410`（`registerPendingInteraction`：注册一个域，返回发布函数）

3. 全局可读性（无需处于该会话作用域）：root 标准源里就装了 `sessionStatus`：

`.../packages/client/ui-session/src/client/index.ts:672-681`
```ts
ctx.slots.provideRoot({
  hooks: {
    sessions: ctx.sessions.list,
    sessionStatus: service.sessionStatus,
  },
  keyedHooks: { sessionRetainInfo: key => ctx.sessions.retainInfo(key as SessionId) },
} satisfies RootStandardSourceContribution)
```
`GlobalStandardProps` 暴露 `useSessionStatus`：同文件 `:155-161`。
（因此 mixer 在**任意**作用域都能一次读全量灯态，`snapshot.get(id)?.pendingInteraction`。）

4. 三种 kind 的产生者：

审批（approval）：
`.../packages/client/ui-approval/src/client/contract/slots.ts:74-108`
```ts
export class PendingApproval {
  readonly kind: 'approval'
  readonly key: string
  readonly toolName: string
  readonly callId: ToolCallId | undefined
  readonly reason: string | undefined
  readonly result: Promise<ApprovalDecision>
  ...
}
```
`.../packages/client/ui-approval/src/client/index.ts:43-58, 88-90, 104-106`
```ts
const sessionId = ctx.sessions.scopeOf(owner)
if (sessionId === undefined) return next()
const pending = new PendingApproval(sessionId, {...})
const remove = registerPendingInteraction(pending, async () => { pending.delegate(); await completed.promise })
...
const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingApproval>(() => 0)
...
ctx.remote.$on('approval/request', function (request, next) {
  return answerApproval(ctx, this, request, next, registerPendingInteraction)
})
```
提问 / 计划评审（question / plan-review）：
`.../packages/client/ui-user-questions/src/client/contract/slots.ts:228`
```ts
readonly kind: 'question' | 'plan-review'
```
同文件 `:284`：`this.kind = planReviewOf(questions) === undefined ? 'question' : 'plan-review'`
（即同一个 `PendingQuestion` 域，按内容判定是普通提问还是计划评审）。
注册：`.../packages/client/ui-user-questions/src/client/index.ts:371-374`（`inject` 面见 `:56`）。

5. 这三种 kind 已经被侧栏当作「等待用户」的上层呈现（可直接复用语义）：

`.../packages/client/ui-workspace/src/client/tree.ts:34-35, 379-388`
```ts
export type SessionPendingInteractionStatus = 'approval' | 'plan-review' | 'question'
...
function visiblePendingKind(kind: string | undefined): SessionPendingInteractionStatus | undefined {
  switch (kind) {
    case 'approval': case 'plan-review': case 'question': return kind
    default: return undefined
  }
}
```
行内文案/态点（`warning` 态就是现成的「亮灯」语汇）：
`.../packages/client/ui-workspace/src/client/rows/Rows.tsx:363-388`
```tsx
case 'approval':  pending = { state: 'warning', label: t('status.waitingApproval'), trailingLabel: t('status.compact.approval') }
case 'plan-review': pending = { state: 'warning', label: t('status.planReview'), ... }
case 'question':  pending = { state: 'warning', label: t('status.waitingAnswer'), ... }
```
`.../packages/client/ui-workspace/README.md` 摘要亦提到 “Pending interactions appear as warning dots”。

6. 被转发到 Client 的 Host 事件里，正好只有这两条是需要用户回答的 waterfall：

`.../packages/api/remotes/src/remote-events.ts:20-48`
```ts
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  ...
  { event: 'user-questions/request', mode: 'waterfall' },
] as const satisfies readonly TypertForwardableEventEntry[]
```
作用域化投递的机制（`docs/subsystems/web-client.md:34`）：
> `ctx.remote.$on()` delivers allowlisted ordinary events to the root Client Context and
> **scoped waterfall events to the resolved Session Context**; a waterfall listener returns a result,
> calls `next()`, or rejects.

### 关键限制（推断 + 证据）

**推断**：Client 侧看不到「Host 正在等审批」这件事本身，只能看到「本 Client 上某个会话的审批监听器接收到了请求」。
理由（代码路径）：
`.../packages/api/gateway/src/client/remote-events.ts:190-210`
```ts
const adapter = this.ownerCtx.typert.contexts.getClient('agent')
let resolved: Context | TypertOwnedValue<Context> | undefined
resolved = adapter?.resolve(frame.agentId)          // 按 agentId 解析 Client 侧会话作用域
...
const target = isTypertOwnedValue(resolved) ? resolved.value : resolved
let outcome: RemoteEventReplyOutcome = { kind: 'next' }
if (target !== undefined) {
  outcome = await this.dispatchWaterfall(target, frame, signal)   // 解析不到就整个跳过
}
```
即：**会话的 Client 作用域解析不到时，waterfall 请求不进任何 Client 监听器**，事件直接按「无人接管」回给 Host
（监听器不存在时 Host waterfall 的默认语义见 `ui-approval` 里 `pending.delegate()` / `next()` 的分支）。
旁证：客户端作用域是随引用生成的（`.../packages/api/session-controller/src/client/scope.ts:44` `createScope(ctx, key)`）。

**这对 mixer 是利好而非风险**：mixer 为了让每格可输入本来就要 retain 每个通道会话，一旦 retain，
Client 作用域与 `ui-approval` / `ui-user-questions` 的监听器就在场，`sessionStatus` 就会亮灯。
反过来，如果某个会话从未被打开/retain，那一格只能是只读快照**且**不会有灯——但 mixer 不会这么做。

**替代/补充信号**（若还要更强的「全局等待」）：`SessionStatus.running` 与 `completionUnread`
（`ui-session/src/client/index.ts:60-68`）分别给出「在跑」和「跑完了但你没看」，可与 pending 一起做三色灯。
`running` 的 Host 来源是转发的 `api-session/status` 事件：`.../ui-session/src/client/index.ts:322-324`、
`.../packages/api/remotes/src/remote-events.ts:27`。

### 对 dsh-mixer 的影响

- 亮灯**不需要**任何新 Host 代码、也不需要订阅自定义事件：一次 `useSessionStatus(s => s)` 就拿到全部通道的灯态；
  建议映射 `approval → 红灯(需要授权)`、`plan-review → 黄灯(等确认)`、`question → 黄灯(等回答)`、`running → 呼吸灯`、
  `completionUnread → 完成未读点`，与侧栏既有 `warning` 语汇保持一致。
- 必须处理「同一时刻只有一条 pendingInteraction 上线」的事实：它是**每会话单值**（按 precedence 选最高），
  所以「同时等 3 个审批」只会显示 1 个。mixer 若要显示计数，得自己再读 `PendingApproval` 的域列表——但那是包内
  私有 registry（`PendingInteractionDomain.values` 是 private），**推断**：只能显示「有/无 + 最高优先级类型」，
  不能显示条数。这一点建议在实现前用运行时打一次点确认。

---

## 问题 4：视图切换挂在哪

> 方法学说明：初版调研时 Client 实时查询超时，问题 4 的槽名与 props 曾取自源码声明。
> 后续已补做运行时核验并**查询成功**：`cordis_inspect_list` 可用，`cordis_inspect_query`
> （platform=client, provider=Slots, method=listSubTree，root=`main`）正常返回。实测结果：
> `main` 为 `kind: keyed` / `scope: root` / `replaceRisk: shadows-shipped-ui`；注册参数只有
> `key`（string，必填）；`keyDomain: "open: any string the owner dispatches (no compile-time key set),
> already taken: conversation"`；已占用的 key 为 `plugins`、`conversation`、`schedules`
> （registrant 均为 `gf`，active 均为 true）。`main` 的 `standardProps` 含 `useSessions`、
> `useSessionStatus`、`useSessionRetainInfo`、`usePanelInfo`、`useResource`——注册到 `main` 的
> 面板**天然**拿得到会话列表与等待态信号，无需自行跨作用域取。`main` 子树含 `main.conversation`
> （single / session-maybe）；共享工厂 `conversation.content` 的用途描述为
> "Reusable Conversation content instantiated by presentation hosts"。
> 运行时树与下方的源码 Slot 声明一致；下文保留源码行号以便复查。

### 结论

**两条都能走，且是互补的，建议同时用：**
① **在现有布局插按钮** → 侧栏全局面板位 `sidebar.panellist`（list，root 作用域），旁边就是
`main`（keyed，root 作用域）——`ui-plugin-manager` 的 Plugins 页就是这条路的标准样板。
② **整屏接管主区域** → 在 `main` 注册一个**新的 key**（如 `'mixer'`），点击侧栏图标时
`ctx.layout.selectPanel('mixer')`，AppFrame 的中间列就整列换成调音台。
不需要（也没有必要）替换 `sidebar` / `rightbar` 这些被声明为 OCCUPIED 的整列槽。
另外还有一块可直接用的「整屏浮层」：`shell.overlay`（list，root 作用域，覆盖整个 frame、点击穿透、条目自行 opt-in 指针事件）。

### 证据

1. 框架根槽声明（谁是 keyed 的全局页面位、谁是整列占用）：

`.../packages/client/ui-layout/src/client/index.ts:64-105`（JSDoc + 声明，`sidebar` 在 `:68`、`main` 在 `:73`、`rightbar` 在 `:87`、`shell.overlay` 在 `:105`）
```ts
/** Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; other keys receive no Session binding. */
'main': { kind: 'keyed'; scope: 'root' }
...
/** The whole left column. OCCUPIED by ui-sidebar's SidebarRoot ... registering here replaces the navigation column outright */
'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
/** The right column: a track the centre makes room for, or nothing. OCCUPIED by the right Sidebar ... */
'rightbar': { kind: 'single'; scope: 'root'; owner: RightbarOwnerProps }
/** Frame-wide floating layer, above every column and outside their scroll containers. ... The layer itself is click-through — entries opt back into pointer events ... */
'shell.overlay': { kind: 'list'; scope: 'root' }
```
同一处 `:178-188` 是 `root` 槽的注册（把上述键声明为 `root` 的 children）。

2. 主区域如何被替换（唯一入口是 `layout.selectPanel`；`main` 是 keyed，按 key 取条目）：

`.../packages/client/ui-layout/src/client/AppFrame.tsx:40-43`
```tsx
function MainPanel({ usePanelInfo, renderSlot }) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}
```
`.../packages/client/ui-layout/src/client/service.ts:72-77`
```ts
selectPanel(panelId: MainPanelId | null): void {
  if (panelId !== null && !this.hasPanel(panelId)) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
  this.panels.selectPanel(panelId)
}
```
`.../packages/client/ui-layout/src/client/index.ts:173-175`（`hasPanel` 的判定 = `main` 里存在同 key 条目）

3. 侧栏按钮/行的挂载点与「整屏切换」的标准样板（`ui-plugin-manager`）：

`.../packages/client/ui-sidebar/src/client/contract/slots.ts:35`（元数据结构在 `:78`）
```ts
/**
 * Global panel icons. Each list id addresses the matching main panel;
 * the sidebar owns the button and resolves its label from list metadata.
 */
'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
```
`.../packages/client/ui-sidebar/src/client/SidebarRoot.tsx:59-81`（行按钮，`aria-current` 标注当前页）：
```tsx
function PanelRow({ id, label, wide, usePanelInfo, selectPanel, renderSlot }) {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <button type="button" className={clsx(css.panelRow, active && css.panelActive)}
      aria-current={active ? 'page' : undefined}
      onClick={() => { selectPanel(id) }}>
      <span className={css.panelGlyph} aria-hidden="true">
        {renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })}
      </span>
      {wide && <span className={clsx(css.panelTitle, css.wide)}>{label}</span>}
    </button>
  )
}
```
`.../packages/client/ui-sidebar/src/client/index.ts:53-63`（面板清单来自 `sidebar.panellist` 条目的 `id/order/label`）、
`:70-73`（`selectPanel` → `ctx.layout.selectPanel(id)`）。

`ui-plugin-manager` 的完整样板（注册 main 的 keyed 条目 + 侧栏图标）：
`.../packages/client/ui-plugin-manager/src/client/index.ts:110-130`
```ts
ctx.slots.inject('main', function* () {
  ...
  yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, store, inject: () => face, children: {...} }, PluginManagerPage)
```
同文件 `:135`（`ctx.layout.selectPanel(PANEL_ID)`）、`:141-147`：
```ts
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: PANEL_ID, order: 0, label: () => t('panel'), locale: NS,
}, PluginsPanelIcon))
```

4. 内置会话页也是同一套（证明「新 key = 与 conversation 并列的整屏页面」）：

`.../packages/client/ui-conversation/src/client/apply.ts:532-538`
```ts
slots.inject('main', function* () {
  yield slots.register({
    name: 'main',
    key: 'conversation',
    children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } },
  }, ConversationPanel)
  ...
```
`.../packages/client/ui-layout/README.md`（Use this package 章节）：
> Global panels occupy the root-scoped `main` keyed slot; `conversation` is the reserved key for the Conversation.
> `ctx.layout.selectPanel(id)` selects a registered panel, and `null` selects the Conversation without changing the current Session.

5. 整屏浮层的先例（若 mixer 想要「不切换也悬浮一屏」）：`shell.overlay` 已被
`ui-settings-account`（`.../packages/client/ui-settings-account/src/client/index.ts:252,277`）与
`ui-sidebar-terminal` 使用。

### 对 dsh-mixer 的影响

- **推荐形态**：注册 `main` 的 keyed 条目 `key: 'mixer'` + `sidebar.panellist` 的 `id: 'mixer'` 图标。
  侧栏出现一个可点的「调音台」行，点一下整屏切换；再点左侧任意会话行（`ui-workspace` 的 `openSession`
  → `selectPanel(null)`，见 `.../ui-workspace/src/client/navigation.ts:401,433`）就切回常规形态。
  「常规 ⇄ 调音台」的切换天然保住常规视图状态：`main` 是 keyed 多条目并存，AppFrame 只换渲染哪个条目，
  React 树按 key 卸载/重挂，会话选择本身由 `mainReference` 持有，不丢。
- **按钮形态的替代**：如果不想占一个整屏页，也可以只在 `shell.overlay` 放一个切换胶囊，
  但注意它是**叠加**层，不能替代主区域，且自身需要 opt-in 指针事件。
- **不要**注册 `sidebar` / `rightbar`（OCCUPIED，注册即替换掉整个导航列/右栏，收益与代价完全不成比例）。
- 图标/文案走 locale + `label: () => t(...)`（样板见 `ui-plugin-manager`），
  `dsh.client.inject` 需要声明对 `@deepseek-ai/dsh-client-ui-renderer`、`@deepseek-ai/dsh-client-ui-sidebar`、
  `@deepseek-ai/dsh-client-ui-layout`、`@deepseek-ai/dsh-client-ui-session`、
  `@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-slots` 的依赖边。

---

## 附：附带确认到的工程事实（对实现有直接影响）

1. **Client half 的加载形式**：`package.json` 里 `dsh.client = { platform: 'web', immediately, inject }`，
   `exports["./client"]` 指向被 serve 的 `client.js`；bundle 是
   `window.__ModuleLoader__.load({ id, factory(require) { ... } })` 的懒 CJS 工厂。
   证据：`.../docs/subsystems/client-modules.md:80-84`；实样
   `.../packages/extensions/ui-cordis/lib/client.js:1-8`。
   `@deepseek-ai/dsh-client-ui-slots` 属于**平台基线模块**，可直接 `require`（不必声明 external）：
   `.../packages/client/web/src/platform.ts:8-14`
   ```ts
   export const PLATFORM_MODULES = [
     'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
     '@deepseek-ai/dsh-client-store',
     '@deepseek-ai/dsh-client-ui-slots',
     '@deepseek-ai/dsh-client-ui-primitives',
     '@deepseek-ai/dsh-client-ui-dockkit',
   ] as const
   ```
   （`conversation.content` 等 SlotMap 声明合并通过 `import type` 引入即可，类型导入会被擦除、不产生运行时依赖。）

2. **类型扩展点齐备**：`SessionReferenceSourceMap`（`.../api/session-controller/src/client/index.ts:79-88`）、
   `SlotScopeTargetMap.session`（`.../client/ui-session/src/client/index.ts:151-154`）、
   `SlotMap` / `SlotFactoryMap`（各包 `declare module '@deepseek-ai/dsh-client-ui-slots'`）都是公开的声明合并面。

3. **不需要 Host 侧改动**：`packages/api/remotes/src/remote-events.ts` 的转发白名单已含
   `approval/request` 与 `user-questions/request`；会话列表/状态/历史都已有现成 Remote 面。
   mixer 的 Host half（`index.js`）可以继续为空。

## 未能完成的验证 / 残留风险

1. **Client 实时树：已补查并证实（原缺口已关闭）**。初版调研时 `cordis_inspect_query` 对 client 的
   `Slots.listSubTree` / `Service.listService` / `Event.listEvents` 全部在 10s 超时（错误原文：
   `Client inspect query Slots.listSubTree timed out after 10000ms. Open or reconnect the Harness page,
   then retry.`）。现已实测成功：`cordis_inspect_list` 可用，`cordis_inspect_query`
   （platform=client, provider=Slots, method=listSubTree，root=`main`）正常返回。核验结果：
   - `main`：`kind: keyed`、`scope: root`、`replaceRisk: shadows-shipped-ui`；注册参数只有
     `key`（string，必填）；`keyDomain: "open: any string the owner dispatches (no compile-time key set),
     already taken: conversation"`；**已占用**（registrant 均为 `gf`，active 均为 true）：
     `plugins`、`conversation`、`schedules`。
   - `main` 的 `standardProps` 含 `useSessions`、`useSessionStatus`、`useSessionRetainInfo`、
     `usePanelInfo`、`useResource`——注册到 `main` 的面板**天然**拿得到会话列表与等待态信号，
     无需自行跨作用域取。
   - `main` 子树含 `main.conversation`（single / session-maybe）；共享工厂 `conversation.content`
     的用途描述为 "Reusable Conversation content instantiated by presentation hosts"。
   因此问题 4 的「整屏替换」路径是**运行时确证**的，不再依赖源码推断；问题 1 的
   `useSessions` root 全局可用也由此确证。源码行号引用予以保留，便于复查。
2. **未实际跑通「两个 pane 同时渲染 conversational content」**：本报告的证据是
   ①框架契约（`SessionProvider` 显式引用换绑定）②两处现场先例（`ui-sidebar-right`、`ui-subagent`）。
   缺一个最小可运行验证：注册一个 mixer 主面板，硬编码两个 sessionId，各包一个
   `SessionProvider` + `renderFactorySlot('conversation.content')`，确认输入框可发送、审批卡可点。
   这是立项前唯一值得先做的 spike（预计半天内可判定）。
3. **亮灯条数**：`SessionStatus.pendingInteraction` 每会话单值（推断理由见问题 3）；
   「本会话同时有 2 个审批」预计只显示 1 个。若要计数需另找面（`PendingInteractionDomain.values` 是 private）。
4. **格数上限**：文中未测性能。每格都是真实 retain（历史 + 流 + 重绘），建议首版硬上限 3–4 格并在
   `docs/adr/` 记一条决策。

## 引用核校记录

- **核校时间**：2026-10-14（本轮，与调研同日）。
- **核校对象**：本文件全部 `路径:行号` / `路径:行号-行号` 形式的代码引用，含正文与表格。
- **核校条数**：67 处带文件路径的引用位点 + 16 处同文件续引（`:NNN`），共 **83 个行号锚点**；
  其中 **23 处**判定为行号/路径漂移并就地修正，**60 处**判定属实（区间可能比被引内容略宽，但覆盖之）。
- **核校方法**：对每一条引用，按路径打开 DSH checkout
  `/Users/user/Documents/code/deepseek-harness/`（源码在 `packages/<group>/<name>/src`）中的源文件，
  用行号定位读取被引行并逐字/逐符号比对引文与描述；缩写路径（`.../`）补全后校验，并用 `glob`
  单独校验文件路径是否存在（据此发现 1 处路径错误）。判定规则：被引内容（引文原句或所述符号的声明）
  实际所在行落于所引区间内 ⇒ **属实**；区间未覆盖被引内容（含越过文件末行）或指向别的文件 ⇒
  **漂移**，就地改写为正确行号，不改引文原话；引文在源码中查无实据 ⇒ **未证实**（保留引用、不补出处）。
- **与结论相关的一处改动**：问题 4 的「方法学说明」与文末「验证缺口」第 1 条原称 Client 实时查询超时、
  结论来自源码推断；现按运行时实测（`cordis_inspect_query` 成功）改写为「运行时确证」。该节判断
  「两条路都能走」未被推翻，反而被运行时数据支持；其余结论一字未改。

### 已修正的引用（旧 → 新）

| # | 引用（报告中的位置） | 旧 | 新 | 说明 |
|---|---|---|---|---|
| 1 | `api/session-controller/src/client/contract/sessions.ts`（`ISessions.list`） | `:32` | `:48-51` | `:32` 是 `SessionReference.release()`；接口在 48 起，`list` 在 51。同句「完整面见 `:37-170`」→ `:48-163`（文件共 163 行） |
| 2 | `packages/client/extensions/ui-cordis/src/client/CordisPanel.tsx` | 路径含 `/client/` | `packages/extensions/ui-cordis/...` | 路径错误；实际文件在 `packages/extensions/ui-cordis/src/client/CordisPanel.tsx`，被引行 129 属实 |
| 3 | `docs/subsystems/web-client.md`（`SessionProvider` 并发子树句） | `:82` | `:60` | 引文原句在 `:60`（已知样例） |
| 4 | `ui-session/src/client/index.ts`（`bindingSource`） | `:335-350` | `:346-354` | `bindingSource()` 定义在 346-354 |
| 5 | `ui-sidebar-right/.../shell/RightbarRoot.tsx` | `:17-39` | `:17-38` | 文件共 38 行，`RightbarRoot` 在 34-38 |
| 6 | `ui-sidebar-right/src/client/session-view.ts`（`retain`） | `:31` | `:33` | `this.reference = sessions.retain(...)` 在 33 |
| 7 | `ui-subagent/.../sidebar-chat/index.tsx`（`SidebarChatTab`） | `:151-167` | `:151-169` | 函数体闭合在 169 |
| 8 | `ui-conversation/src/client/contract/slots.ts`（`conversation.content`） | `:220-241` | `:226-247` | `SlotFactoryMap` 在 226，`conversation.content` 在 228-246 |
| 9 | `ui-slots/src/index.ts`（`PropsRenderFactories`） | `:484-495` | `:484-496` | 接口闭合在 496 |
| 10 | `ui-conversation/src/client/service.ts`（`IConversation`） | `:44-71` | `:1-9, 40-71` | 接口在 40-71；scope-addressing 说明在文件头 1-9 |
| 11 | `ui-conversation/src/client/apply.ts`（composer 槽声明） | `:306-311` | `:315-316` | `'conversation.composer'`/`.bar` 在 315-316 |
| 12 | 问题 2「注意」`service.ts`（`IConversation.input`） | `:48-49` | `ui-conversation/src/client/service.ts:41-42` | `readonly input` 在 41-42 |
| 13 | `ConversationContent.tsx`（body 与 seat ResizeObserver） | `:34-58` | `:31-67` | `body` state 在 31，ResizeObserver 块 52-67 |
| 14 | 问题 2「注意」`service.ts:288-290`（`attachOpening`） | `ui-conversation/.../service.ts:288-290` | `api/session-controller/src/client/sessions/service.ts:289` | 原引用指向 `ui-conversation` 的 service.ts，那里无此代码；该调用实际在 session-controller 的 service.ts:289 |
| 15 | `ui-approval/src/client/index.ts` | `:44-57, 88-90, 105-107` | `:43-58, 88-90, 104-106` | 引文首行在 43，`$on('approval/request')` 在 104-106 |
| 16 | `api/remotes/src/remote-events.ts`（转发白名单） | `:20-49` | `:20-48` | 文件共 48 行 |
| 17 | `api/session-controller/src/client/scope.ts`（`createScope`） | `:47` | `:44` | 函数声明在 44（47 是 `fiber.ctx.extend` 内） |
| 18 | `ui-session/src/client/index.ts`（`api-session/status` 订阅） | `:376-379` | `:322-324` | `$on('api-session/status', ...)` 在 322-324 |
| 19 | `api/remotes/src/remote-events.ts`（`api-session/status`） | `:31` | `:27` | `:31` 是 `credentials/record-updated` |
| 20 | `ui-layout/src/client/index.ts`（`rightbar` 声明） | `rightbar` 在 `:75` | `rightbar` 在 `:87` | `:75` 是 `rightbar` 的 JSDoc，声明在 87 |
| 21 | `ui-sidebar/src/client/SidebarRoot.tsx`（`PanelRow`） | `:59-79` | `:59-81` | 函数体闭合在 81 |
| 22 | `client/web/src/platform.ts`（`PLATFORM_MODULES`） | `:8-13` | `:8-14` | `] as const` 在 14 |
| 23 | `ui-renderer/src/client/scoped-slots.tsx`（`ScopeAreaProvider`） | `:510-524` | `:510-525` | 函数体闭合在 525 |

### 未能证实的引用

**无。** 83 个锚点全部定位到真实文件与真实行。其中 #1/#3/#14 属于「引文为真但落点错误」的漂移
（分别在 `:32`、`:82`、另一个包的 `service.ts`），已按实际位置改正；没有一条被删除，也没有一条被
替它编造出处。另有若干引用判定为「区间覆盖内容、仅宽窄不同」，按最小改动原则保留未动，例如
`ui-session/src/client/index.ts:437-444`（`publishMain` 实际 435-450）、`:450-484`
（`publishPendingInteractions` 实际 461-481）、`:520-539`、`:383-410`、`:672-681`、
`ui-slots/src/index.ts:344-363`、`ui-approval/.../contract/slots.ts:74-108`、
`api/gateway/.../client/remote-events.ts:190-210`、`ui-layout/src/client/index.ts:64-105`、
`ui-sidebar/.../contract/slots.ts:35` 与 `:78` 等。

