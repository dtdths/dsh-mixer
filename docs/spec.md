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

### 5.4 布局与溢出

- 每格固定最小宽度 **380px**；列用 `minmax(380px, 1fr)`（聚焦格 `2.2fr`），网格容器 `overflow-x: auto`。
- **不设格数硬上限**：超出可视宽度就横向滚动，而不是挤窄每格。

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
6. **等待态**：制造一次需要授权/确认的操作，对应通道应出现 V2 标记，且顶栏汇总计数 +1。
7. **执行中**：让某个会话跑一个较长回合，其面包屑前应出现转圈。
8. **持久化**：改动下拉里的勾选 → 刷新 → 选择仍在。
9. **归档联动**：把某个已选通道的会话在左侧归档 → 它应从调音台消失（且期间列表未就绪时不会误清空面板）。
10. **退出**：点「常规视图」或左侧会话行 → 回到常规，滚动位置与草稿仍在；侧栏恢复原状。

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

## 9. 未决 / 后续

- **钉住视图不写会话记忆**（§4.4 边界）：要"点了就记住"，需上游暴露 store 或 `selectView` 动作。
- **真实格内点审批卡未端到端实测**：机制上是官方 composer 按当前会话的 `pendingInteraction` 渲染，但尚未用真实审批点过。
- **侧栏折叠状态需 layout API**（§7.1）。
- **spike → 正式包的迁移**：`spike/` 是一次性原型（分支 `spike/mixer-two-pane`），实现时把其中验证过的机制搬进根包，然后用 `install_bundle` 装根包、卸掉 `dsh-mixer-spike`。

## 10. 原型资产

- 分支：`spike/mixer-two-pane`（一次性，main 保持干净）
- 包：`spike/`（`dsh-mixer-spike`，profile 里以 `link:` 指向它）
- 常驻守卫：`node spike/boot-check.mjs`（真实 Cordis Context 冷启动 + 自带对照项）
- 变体：原型条可切 V1/V2/V3（V2 已选定）、三档内容模式（模拟 / 真实·默认 / 真实·标签）
