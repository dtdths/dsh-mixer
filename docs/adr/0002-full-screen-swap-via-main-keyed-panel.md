# 整屏替换走 main 的 keyed 面板，不用 rightbar / shell.overlay

调音台形态是「整屏替换常规会话视图」，需要一个能接管中央区域的挂点。候选是 `main`（keyed/root）、`sidebar` 与 `rightbar`（两者都是 OCCUPIED，注册即替换整列）、以及 `shell.overlay`（整屏浮层）。选 `main` + `ctx.layout.selectPanel('mixer')`：它本来就是「按侧栏条目切换中央面板」的既有机制，内置的 Plugins / Schedules 页走的是同一模式；切回常规只需 `selectPanel('conversation')`，或点左侧会话行（那会 `selectPanel(null)`），因此常规态会话状态天然不丢。`rightbar` / `sidebar` 会破坏宿主的列布局；`shell.overlay` 是浮层，点击穿透语义与本需求不符。

## Consequences

- 必须用**自己的** key，不能占用 `conversation`（那是内置会话面板的键，注册即替换它）。
- 顶栏工具区的切换按钮只负责调用 `selectPanel`，不承担视图渲染。
