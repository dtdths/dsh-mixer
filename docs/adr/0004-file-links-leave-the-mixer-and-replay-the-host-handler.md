# 文件链接由「离开调音台并重放宿主处理器」完成

调音台占着主列时，右栏不认任何「在屏会话」：`ui-sidebar-right` 只在
`activePanelId === null` 时才 `show(selected?.sessionId)`（`ui-sidebar-right/src/client/index.ts:136-140`），
而它的写操作入口先过一个 `require()`，`mounted` 为 `undefined` 就抛
`sidebarRight: no session surface is mounted`（`src/client/service.ts:723-733`）。所以在调音台里点**任何**
文件链接都必弹「无法打开文件」，重试同样失败 —— 这是宿主的设计后果，不是偶发 bug。

插件也**不能**自己把文件打开：地址是在宿主自己的闭包里拼的（`ui-chat/src/client/apply.ts:258-263`：
`cwd` → `fileAddressFor(sessionId, cwd, path)` → `openResource`），而路径从不进 DOM —— 工具行链接渲染的是
工具摘要（`ui-tool/.../ToolRow.tsx:211-224` 无 `title`）、markdown 链接的 `title` 在图片预览时被丢掉
（`ui-primitives/src/markdown/render.tsx:592`）、composer 的 `@` chip 只有 basename。何况「不能改 DSH」是硬约束。

## 决定

把「点文件链接」这条动作**整体挪到常规视图里完成**：

1. 调音台根上挂 **capture 阶段**的 `click`。React 把 `onClick` 委托在 app 根容器上（`ui-renderer/src/client/index.ts:80`
   `createRoot`），所以在 capture 阶段 `stopPropagation()` 就能让宿主自己的处理器完全不跑。
2. 只认**白名单**且必须满足两个前置：目标元素命中 `[class*="fileLink"]` / `[class*="fileMention"]` /
   `[data-ref-chip="file"]`，且在某个 `[data-mixer-pane]` 之内（那个属性的值就是 sessionId，
   `client.js:1623`）；并且元素上挂着 React 的 `onClick`（React 18 把 props 放在节点的 `__reactProps$…` 上）。
3. **任何一个前置不满足 → 什么都不做**，让宿主自己的处理器照常跑：用户看到的是宿主原本那个带「重试」的错误
   对话框。失效方向必须是「看得见的旧行为」，不是「点了没反应」。
4. 前置齐了才吞掉点击：置「用户主动离开」闩 → `ctx.uiWorkspace.openSession(该格会话)` → **跨帧重试**重放
   刚才抓到的那个宿主 `onClick`（`FILE_LINK_REPLAY_FRAMES = 8` 帧封顶）。此时右栏已经命名了在屏会话，
   宿主自己的 `openResource` 成功。重放必须是**重试**、且必须看 promise：宿主的 `openFile` 是 **async**
   （`ui-chat/apply.ts:258-263`），右栏还没接住写入时失败以 **rejected promise** 回来，光 `try/catch`
   拦不住 —— 2026-10-28 的真机实测正是这样丢掉了第一版（切过去了、文件没打开、也没有任何提示）。
   **事件也必须像个事件**：`ReferenceChip` 的 `onClick` 读 `event.detail` 与
   `event.currentTarget.ownerDocument`（`ui-primitives/src/user-text.tsx:52`），假事件要带 `detail: 0`
   和 `currentTarget`/`target`，否则它抛 `Cannot read properties of undefined (reading 'ownerDocument')`
   —— 同样表现为"切了但没打开"（v1.6.0 就是这么坏的，v1.6.1 修）。
5. `sidebarRight` 用 `ctx.get('sidebarRight')` **可选读**，不加 Cordis 边：没装右栏的 profile 直接不接管
   （硬边会让没有该包的 profile 整页启动失败，`web/src/boot-client.ts:80-82`）。
6. **输入框里的 `@` 引用走另一条路（v1.6.1）**：它是 Lexical 的 decorator，没有 React 处理器可重放，完整路径
   只在编辑器节点里。所以它的接管是"**离开，然后在常规视图的输入框里把同一个 chip 重新点一次**"（草稿跟着
   会话走）。两条硬约束都是真机撞出来的：① 必须等调音台真的卸载（`activePanelId === null`）再点，否则那个
   click 会被插件自己的 capture 处理器再吃一次 → 无限递归；② 只认通道之外的 chip，且 `dispatchEvent` 的
   `mousedown`/`mouseup`/`click` 都要 `bubbles: true` 才到得了 Lexical 的根。

## Consequences

- **调音台不再保持**：点一个文件链接就离开调音台，落到该链接所属通道的会话上，文件开在常规视图的右栏。通道集合 /
  solo / 已移出 / 顺序都在插件作用域里（`createViewState`），跨重挂存活，所以再进调音台板子还在；丢的是每格滚动位置
  （§5.1 已知代价），以及常规视图恢复的是宿主上次的滚动位置，未必是你刚看的那条消息。
- **残余失败**：8 帧内重放仍失败时，调音台已经卸载，插件没有任何渲染位置可以报错（只有 `console.error`）——
  用户人在正确的会话上，那个链接还在，再点一次就成。这是本方案接受的最坏情况。
- **依赖 React 内部**：`__reactProps$…` 是 React 18.2 的实现细节，宿主自己全仓 0 处读它。它的失效模式恰好是安全的
  （拿不到就放行），`tests/seams.test.mjs` 用一条「拿不到内部键就返回 undefined」的用例把这个降级钉死。
- **composer 的 `@` chip 不接管**：它只有 basename，且激活走 Lexical 的 `CLICK_COMMAND`，吞掉点击会破坏光标落点。
  这类链接在调音台里仍会报错（未捕获），属于已知边界。
- 「常规视图」按钮与文件链接共用同一个「用户主动离开」闩，因此两者都不会被 §5.1 的 reclaim 弹回调音台（ADR-0003 的
  边界据此收窄）。

## Considered Options

- **从 DOM 拼路径自己开**：工具行链接没有路径属性、图片链接没有 `title`、composer chip 只有 basename —— 覆盖不了
  最常见的「agent 碰了个文件」那一类，等于没解决。
- **只切视图 + 顶栏提示「请再点一次」**：一致但两次点击，而且退出后插件没有渲染位置 —— 宿主根本没有对插件暴露通知
  服务（`notify` 只是 ui-workspace 内部的 `rowToast`）。
- **走 OS 通道在系统默认 App 打开**（`ctx.remote.session.openWorkspacePath`）：不是在 DSH 右栏看，而是弹到别的应用；
  还得多挂 `remote` + `remote.session` 两条服务边。为一个绕限制的补丁加两条边不划算。
- **维持现状**：用户要的正是「点一下能看到文件」。
