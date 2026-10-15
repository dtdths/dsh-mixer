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
