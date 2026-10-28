# DSH 客户端插件的坑（已验证）

这份文档只记录**踩过的、有证据的**坑。每条都附证据位置与规则。

## 1. 绝不写 `if (ctx.someService)`

**症状**：整个 Harness 页面报 `Failed to load plugins` / `web boot: 1 entry did not activate`，插件条目状态 `failed`。

**原因**：Cordis 里，在**插件 fiber 的作用域**上读取一个该 fiber 没有注入的服务会**抛错**，而不是返回 `undefined`：

```
cannot get property "commandUi" without inject
```

所以 `!== undefined` 这类守卫**根本不会执行到**，`apply()` 直接抛出，fiber 进入 `FAILED`，宿主的启动审计（`packages/client/web/src/boot-client.ts` 的 `assertEntriesActive`）随即判定整个 Web 启动失败。

**证据**：

- 抛错点：`vendor/cordis/src/reflect.ts:144`
- 状态机：`vendor/cordis/src/fiber.ts:147-152`（`PENDING / LOADING / ACTIVE / FAILED / DISPOSED`）
- 首次踩中：`dsh-mixer` 提交 `216c55c`（`/mixer` 指令那次），2026-10-14

**正确写法**：

```js
// 要么声明进模块的 inject 列表（缺服务则条目 pending，插件不激活但不会炸整页）
inject: ['slots', 'sessions', 'layout', 'uiWorkspace', 'commandUi']

// 要么用 ctx.inject 等它（服务永远不来时不触发回调，插件照常激活）
ctx.inject(['commandUi'], (scope) => {
  scope.commandUi.register({ /* ... */ })
})
```

**注意**：`ctx.inject(deps, cb)` 到的服务在回调里用 `scope.commandUi`（回调参数），不要回头再用 `ctx.commandUi`。

**同一个陷阱的第二种形态（2026-10-15 实录，更隐蔽）**：把一条 `inject` **删掉**之后，**晚读**那个服务的 handler 不会在启动时炸 —— Cordis 只在读取真的发生时才抛那句话，于是表现为"某个按钮点了没反应"。

- 经过：第二轮把 `uiWorkspace` 从模块 `inject` 里去掉（当时新建改走 `ctx.sessions.create`，不再需要它），第四轮又加了一个**点击时**才读 `ctx.uiWorkspace.archiveSession` 的归档按钮。冷启动、HMR、全部测试都正常；用户点归档 → 顶栏只出现一句 `归档失败：cannot get property "uiWorkspace" without inject`。
- 两处护栏现在钉住它：
  1. `tests/host-contract.test.mjs` 的 `plugin contract` 用例：静态扫描 `client.js`（先剥注释）里出现的每个 `ctx.<名>`，要求它出现在 `definition.inject` 里，**并且反过来**（名单里不许留没人读的边）。**这条哨兵已验证会真的变红**：把 `uiWorkspace` 从 inject 拿掉，报错文本与线上那句一致。
  2. `boot-check.mjs` 的假 context 必须为 `inject` 里每个服务都 `provide`；少了就对不上，条目停在 `PENDING`，由既有断言报出来。
- 配套纪律：事件处理器里**只** `console.error` 等于"点了没反应"。同步抛错也要变成用户可见的提示（spec §5.2 的归档流程就是这么修的）。

## 2. 冷启动不等于 HMR

在已经启动好的页面上热重载插件时，**所有服务早就到位**，所以带 bug 的代码看起来完全正常。只有当页面**全新加载**、插件在 `commandUi` 之类的服务被 provide 之前 apply 时，才会暴露。

**规则**：任何改动只要碰 `apply()`，就必须做一次"冷启动"验证，而不是在活着的页面上刷一下就算过。

**本仓库的守卫**：

```bash
npm run check        # 语法 + 纯函数测试 + 冷启动
node boot-check.mjs  # 只跑冷启动
```

它把真实的 `client.js` 放进真实的 Cordis Context，按宿主装载路径（`root.inject(def.inject, scope => apply(scope))`）启动，读 fiber 状态；并内置一个**对照项**复现当年的故障模式 —— 对照项若不再失败，脚本会自报"这个检查证明不了任何东西"。它还断言两件**静默失败**的注册事实：`main` 面板声明了 session 作用域的子槽（见下一条）且带着 board store。

原型时期对应的是 `spike/boot-check.mjs`（在 `spike/mixer-two-pane` 分支上）。

## 3. 多会话并排的关键前提：声明一个 session 作用域的子槽

注册到 `main` 的组件想拿到 `SessionProvider`（按格绑定不同会话的必要条件），必须在该条目的 `children` 里声明**至少一个 scope 不是 `root` 的子槽**；否则 `SessionProvider` 根本不会出现在 props 里。

- 判定逻辑：`packages/client/ui-renderer/src/client/scoped-slots.tsx:585-593`（`children` 中存在 `scope !== 'root'` 才注入 `SessionProvider`）
- 内置会话页的写法：`packages/client/ui-conversation/src/client/apply.ts` 的 `children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } }`
- 失败的静默性：少了它**不会报错**，只是每格渲染不出会话内容（第 1 轮原型就是这么空白的）

## 相关设计约束（不属"坑"，但同样实测得来）

- 侧边栏**无法归零**：折叠后仍是 56px 轨道（`packages/client/ui-layout/src/client/columns.ts:19,52-53`）。
- 「等待用户」信号只对**已 retain** 的会话产生（`packages/client/ui-session/src/client/index.ts:59-71`）。

## 4. 复用共享 UI：手写模块怎么 import 别的包

不想重画宿主已有的组件（例如那个"会话在跑"的 loading）时，正路是复用 **共享 primitives**，而不是照着截图仿：

1. 目标组件确实在共享包里 —— 例如 `StateDot` 导出自 `@deepseek-ai/dsh-client-ui-primitives`（`src/StateDot.tsx`），`state: 'ongoing'` 就是左侧栏会话行的 loading，且它**自带** `prefers-reduced-motion` 处理与相位对齐。
2. 在 `package.json` 里声明 **`dsh.client.external`**：

   ```json
   "dsh": { "client": { "external": ["@deepseek-ai/dsh-client-ui-primitives"] } }
   ```

   这是模块表的依赖声明（"an `external` specifier is either the package row it names"）。**不要**把自己的包写进去（`packages/client/modules/src/index.ts:517-522` 会报错）。注意 `inject`（插件激活顺序）与 `external`（模块可用性）是**两个不同的字段**，按需分别声明。
3. 在 factory 里 `require('@deepseek-ai/dsh-client-ui-primitives')`。

**红线**：这个 `require` 必须 try/catch 兜底。模块表解析不到时未捕获的异常会在 factory 里抛出 → 条目 FAILED → 整个 Web 启动失败（与第 1 条同类后果）。降级渲染也要能看。

**反例（别做）**：不要为了摆一个控件去读别的插件的 DOM、样式表或组件源码来估位置；要么走槽位，要么走共享 primitives。

## 5. 给宿主已有控件加样式：找它打在标记上的稳定钩子

真实内容里那些官方控件拿不到 class 时，别去用 CSS module 的哈希类名（`GrXCZa_card` 这种 —— DSH 一重建/升级就失效）。宿主在关键元素上打了 **`data-*` 钩子**，优先用它们，并用本插件自己的属性做作用域前缀：

```css
[data-mixer-pane] [data-composer-card]:focus-within { outline: … }
```

composer 区域的三层钩子，按"越贴目标越好"取用：

| 钩子 | 是什么 |
| --- | --- |
| `data-composer-card` | **输入卡片本身**（带 `border-radius: --dsw-radius-panel`）—— 要圈"输入框"就用它 |
| `data-composer-seat` | 包住整条 composer 带的座位（输入 + 工具栏 + dock，无圆角）—— 圈它会是个难看的大方框 |
| `data-conversation-region="composer"` | 与 seat 同一个元素 |

**搜索陷阱**：这些钩子可能是**无值属性**（`data-composer-card` 后面没有 `=…`），用 `data-[a-z-]*=` 这种正则去 grep 会**全部漏掉**。查宿主钩子时要同时搜 `data-[a-z-]*\b`（无值）与 `data-[a-z-]*=`（有值）。这个坑让我一开始误以为"输入卡片没有稳定属性"，差点退回哈希类名。

**取用原则**：钩子越外层，圈出来的框越大、越不像用户眼里的那个控件。先在浏览器里看一眼要圈的到底是哪一层，再选钩子。

## 6. 复用宿主的拖拽协议，别给别人的 DOM 加属性

宿主已经在关键行上实现了拖拽，**负载就是 SessionId**：

```js
// ui-workspace/src/client/rows/Rows.tsx（侧栏会话行）
draggable={draggable}
onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.id) }}
```

所以插件想"接收一个会话被拖进来"，正确做法是**把自己做成放置目标**（`onDragOver` + `onDrop` 读 `text/plain`），而不是去给侧栏的行挂拖拽属性、或监听它的 DOM。后者既脆弱（别人的 DOM 会变）也违反"不读别的插件 DOM"的原则。

要点：

- `onDragOver` **必须** `preventDefault()`，否则 `drop` 永远不会触发；`types` 里可能有多种格式，按格式名取舍。
- 拖拽过程中**读不到数据**（浏览器安全限制），只有 `drop` 时能 `getData`；所以位置计算与数据读取要分开：`dragover` 只算位置并画指示线，`drop` 才取 id。
- 文本选中拖拽同样是 `text/plain`：**先验证 id 是已知会话**再改状态。
- 落点索引是相对**当前渲染出的格子**算的；若被拖对象本来就在列表里，插入位要按"移除后"修正。

## 7. 宿主会校验你的**每一个**默认键位，包括你没在跑的平台

**症状**：装好插件、`pnpm dsh web` → `Failed to load plugins` / `web boot: 1 entry did not activate` / `dsh-mixer: failed`。控制台里那条错误是 `Reserved shortcut default: mixer.channel.next`。

**原因**：`ShortcutRegistry.register` 的校验**与当前设备无关** —— 它遍历 `desktop`/`web` × `macos`/`windows`/`linux`，对**每个**声明了默认值的 profile 做 `normalizeBinding` → （Web 档）`isWebBindingAllowed` → `bindingIssue`，任一不过就抛错；`register` 又在 `apply()` 里，于是整个条目 FAILED。所以一个只在 Linux Desktop 有问题的默认值，会让 **macOS 上的浏览器**打不开页面。

**证据**：

- 校验循环：`packages/client/shortcuts/src/client/registry.ts` 的 `register()`
- 预订规则：`packages/client/shortcuts/src/configuration.ts` 的 `bindingIssue`（`Ctrl+Alt+方向键` 在 Desktop Linux 下是 `reserved`）
- 首次踩中：`dsh-mixer` 提交 `6d7f728`（通道跳转快捷键那次），2026-10-20

**规则**：

- 默认键位要在**全部五个 profile** 上合法；想只在部分平台绑定，就不声明那个 profile 的键（宿主的 `ui-workspace` 就这么做）。
- **OS 级快捷键宿主规则看不到**：`Cmd+Option+←/→` 在 macOS 是系统媒体键（上一首/下一首），**系统在页面之前收走按键** —— 插件里的 `resolve` 根本不会被调用，用户看到的是"音乐换歌、通道不动"。这类只能靠避开：`dsh-mixer` 实测后把 `next`/`prev` 统一改成 `primary+alt+]` / `[`，并在 `host-contract` 里加了一条守卫（任何 `primary+alt+Arrow*` 默认值直接判红）。
- `boot-check.mjs` / `tests/harness.mjs` 里的假 `register` 收什么都收，"11 条都注册了"证明不了宿主会接受。真判据要跑宿主自己的函数：见 `tests/host-contract.test.mjs` 的 `host registry accepts every shortcut default we register`（直接 `import` checkout 里的 `src/configuration.ts` / `src/binding.ts`，Node ≥ 22.18 原生剥离类型）。

## 8. 右栏只在「没有面板」时才有在屏会话 —— 面板退出要 `selectPanel(null)`

`ui-sidebar-right` 的 `require()` 在 `activePanelId !== null` 时必然抛
`sidebarRight: no session surface is mounted`（`ui-sidebar-right/src/client/service.ts:730`）：它只在
**没有面板**占主列时命名在屏会话（`index.ts:139`）。两个后果都在真机上踩过：

- **面板里嵌会话**（我们的调音台、session-inspector）时，任何走 `ctx.sidebarRight.openResource` 的
  交互（消息里的文件链接、工具行引用、`@` 引用）都会抛错，宿主把它渲染成「无法打开文件」对话框，
  重试同样失败。v1.6 起调音台**自己接管**这一类点击（本节第 9 条 + ADR-0004），但那是绕行，不是根治：要根治仍得改宿主。
- **退出面板的落点写错，就把右栏留在「无在屏会话」状态**：`main` 槽里 `conversation` 是**保留键**，
  `selectPanel('conversation')` 与 `selectPanel(null)` 看起来都回常规视图，但**只有 `null`** 让右栏
  命名会话。v1.5.1 及以前的「常规视图」按钮调的是保留键 → 退出调音台后常规视图里的文件链接全部
  抛 `sidebarRight: no session surface is mounted`，直到点一下左侧会话行或刷新。v1.5.2 改为
  `selectPanel(null)`（与宿主自己的会话行退出同一条路径），`tests/interaction.test.mjs` 钉住参数。
  ADR-0002 里「两条等价」的说法在 §7.4 更正。
- 新增右栏相关服务边时：`sidebarRight` 既要在 `inject`（Cordis 服务名）里，也要在
  `package.json` 的 `dsh.client.inject`（包名）里；`tests/host-face.mjs` 的 `HOST_SERVICES` 会替你把
  两边对齐（`tests/host-contract.test.mjs` 有哨兵）。

## 9. 读 React 内部能拿到宿主处理器 —— 但失效时必须放行

调音台里的文件链接（§7.4 / ADR-0004）只有一条可行的修法：**重放宿主自己那个 `onClick`**。原因是
路径根本不在 DOM 里 —— 工具行链接渲染的是工具摘要（`ToolRow.tsx:211-224` 无 `title`）、markdown 链接的
`title` 在图片预览时被丢掉（`render.tsx:592`）、composer 的 `@` chip 只有 basename；地址是在
`ui-chat/apply.ts:258-263` 的闭包里用 `sessionId` + `cwd` 拼出来的。

拿那个闭包只能靠内部字段：React 18.2 把节点 props 挂在 DOM 节点自己的 `__reactProps$<random>` 上
（`Object.keys(el).find(k => k.startsWith('__reactProps$'))` → `props.onClick`）。三条纪律：

1. **宿主自己从不读 React 内部**（这个 checkout 全仓 0 处），所以这是本仓第一个这样的口子，升级 React
   会静默失效 —— `createChannelDom().hostClickOf()` 是它唯一的拼写处，`tests/seams.test.mjs` 有一条
   「拿不到内部键就返回 `undefined`」的用例。
2. **失效方向必须是「放行原点击」**：拿不到闭包就什么都不做，让宿主自己的处理器照常跑（用户看到原来那个
   带「重试」的对话框）。绝不能变成"吞掉点击然后什么也没发生"—— 那正是本仓反复交学费的那一类症状。
3. **必须配一个"重放前先离开面板"的时序**：`openResource` 要求右栏已命名在屏会话，而那个名字是在
   `selectPanel(null)` 里**同步**写好的（`store` 是 sync-flush），但它要开进去的 per-Session store 在
   **渲染时**才 mint —— 所以同 tick 调用会抛，**下一帧**（`requestAnimationFrame`）才成。

另外：capture 阶段 `stopPropagation()` **确实能**挡住宿主的处理器，因为 React 把 `onClick` 委托在 app
根容器上（`ui-renderer/src/client/index.ts:80`），bubble 阶段根本没机会跑；而 `preventDefault` 对这些
`<button>`（不是 `<a href>`）没有意义。composer 的 `@` chip 不能接管：它只有 basename，且激活走 Lexical
的 `CLICK_COMMAND`，吞掉点击会破坏光标落点。

