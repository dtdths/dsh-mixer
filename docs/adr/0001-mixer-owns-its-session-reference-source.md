# 调音台自持 Session 引用来源，不复用 mainView

调音台要在同一页面同时挂 N 个会话，每个通道都要独立 retain 自己的会话。DSH 的「当前会话」不是一个 store，而是从 `SessionSummary.retainedBy.mainView > 0` 推导出来的单值约定，文档标题、侧栏高亮与快捷键都依赖它，且实现是 `.find()` 取第一个。若调音台复用 `mainView` 作为自己的引用来源，这些「当前会话」的消费者会解析到调音台里任意一格，语义被污染；并发通道之间也会互相踩。因此调音台通过 `SessionReferenceSourceMap` 的声明合并新增自己的来源（`mixerChannel`），每个通道以该来源 retain，并且只**读**由 `mainView` 派生的集合来决定显示哪些通道、绝不写。先例：`ui-sidebar-right` 的 `sidebarView` 就是这么做的。

## Considered Options

- **复用 `mainView`**：实现最少，但会污染「当前会话」的全部三个消费者，且多格之间互相干扰。
- **不 retain、只订阅**：拿不到等待态信号（信号只对已 retain 的会话产生），「亮灯」这个核心功能直接不成立。
