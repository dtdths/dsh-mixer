# 新建会话不视为「离开调音台」

调音台里有三个「新建会话」入口：插件顶栏 `会话` 浮层底部的按钮、宿主 56px 折叠轨道上的新建按钮（`SidebarRoot` 头部那个按钮在窄态仍渲染，只换成图标）、以及宿主的 `session.new` 快捷键（Web 绑 `primary+alt+N`）。三处最终都落到 `ctx.uiWorkspace.startSession()`，而它除了建会话还会 `openWorkspace()` → `replaceMain(…, 'reveal')` → `ctx.layout.selectPanel(null)`（`ui-workspace/src/client/navigation.ts:433`）：调音台被整棵卸载，用户看到的是常规视图；同时宿主的 reveal 会把新会话 retain 成 `mainView`。

调音台的立身之本就是「同时看多个会话」，所以在它里面「新建」的语义是**添加一格**，而不是「离开调音台去看它」。据此分两条路：

- **插件自己的入口不走宿主 navigation**：改用 `ctx.sessions.create({ workspaceId })` 自建、自己以 `mixerChannel` retain（ADR-0001）、插到 `channels` 第 0 位。它不触发任何宿主导航，因此既不会切面板，也不会把新会话写成 `mainView`。
- **宿主入口拦不住，改为窄条件重新断言**：`activePanelId` 从 `mixer` 变为 `null`、且在调音台仍是当前面板期间出现的新会话里有一个**正成为宿主 `mainView` 引用**（reveal 就是这么标记它的，读它不写它，ADR-0001）时，才重新 `selectPanel('mixer')` 并把该会话插到第 0 位；**绝不做无条件抢回**。面板变空这一半单独不够（点侧栏会话行走的是同一条 reveal + `selectPanel(null)`）；"出现新 id"这一半单独也不够（后台智能体、别的窗口、本插件自己 `create` 的会话都会冒新 id）。

## Consequences

- 重新断言意味着调音台**整棵重挂**。三件事必须一并处理：① 每格滚动位置回到顶部 —— 不可修，作为已知代价接受；② `×` 移出的集合（`hidden`）必须移出组件 state 到插件作用域，否则会全部弹回；③ 重挂后所有格子的 composer 都会自动聚焦、最后挂载者赢，必须显式把焦点补到新格。
- 宿主 `reuseOrCreateBlank` 复用已有空白会话时**没有新 id 出现**，窄条件会漏 —— v1 接受，记为已知边界。
- 「切换到此工作区」失去意义并被删除：它调 `openWorkspace()`，走的是同一条 reveal → `selectPanel(null)`，在调音台里同样等于「离开」。工作区在 `会话` 浮层左列只承担「新建落点」一件事。
- 调音台仍然不写 `mainView`（ADR-0001 不变）：自建路径完全不碰它；宿主入口那条由宿主自己写。

## Considered Options

- **继续调 `startSession` + 无条件抢回面板**：会把「点侧栏会话行主动离开」也吃掉，调音台变成逃不出去的页。
- **只修插件自己的入口**：以前提「轨道丢掉了新建会话」成立为前提；该前提被证伪（轨道保留新建按钮，快捷键也走同一路径），只修一个入口等于没修。
- **不处理**：需求2 不成立。
