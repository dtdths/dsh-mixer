# dsh-mixer · 调音台视图

> 一屏横向并列多个独立会话，每格一个通道，等待决策或授权的那一格即时亮灯。
>
> A mixer-style multi-session view for DeepSeek Harness: several independent conversations side by side, each with its own composer and history, with the channels blocked on a decision or a permission request lit up.

## 痛点

在 DSH 里并行推进多个需求时，得在左侧工作区反复切换会话。任务一多，注意力黏在其中一个上，就忘了切回去 —— 其他会话卡在决策确认、权限申请那里，白白空等。

## 期望行为

DSH 原有界面增加一个**视图切换**按钮 / 指令，在「常规形态」与「调音台形态」之间切换：

- **常规形态**：现状不变。
- **调音台形态**：横向同时展示多个会话，每格一个通道，**互相独立**，各有独立输入框与对话记录 —— 相当于把「点左侧任务切换到不同页面」聚合到一屏。
- **等待态可见**：哪个通道卡在决策 / 权限申请，这一格亮灯。

## 术语

| 术语 | 含义 |
| --- | --- |
| 通道 channel | 调音台里的每一格会话面板 |
| 亮灯 waiting | 该通道正在等待你决策 / 授权 |
| solo | 只聚焦某一个通道 |
| mute | 暂时从调音台收起某个通道 |

命名经过、落选方案与理由见 [docs/naming.md](docs/naming.md)。

## 状态

**骨架阶段（scaffold）** —— 目录结构与 bundle 清单已就位，但：

- **尚未实现任何视图逻辑**；
- **尚未安装到任何 profile**（也未在任何会话里启用）;
- `client.js` 是一个**不渲染任何内容**的占位模块，扩展点待定，见 [docs/open-questions.md](docs/open-questions.md)。

## 结构

```
dsh-mixer/
├── package.json          # bundle 清单：name=dsh-mixer，dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 插入行 id=dsh-mixer / name=dsh-mixer
├── index.js              # Host half（当前为空：视图逻辑都在 Client）
├── client.js             # Client half（Web UI，当前为占位）
├── locale/
│   ├── en.json           # meta.title / meta.description
│   └── zh.json
├── icon.svg              # 原创图标：三路推子，其中一路亮灯
├── docs/
│   ├── naming.md         # 命名决策记录
│   └── open-questions.md # 开工前必须摸清的扩展点问题
└── LICENSE
```

## 安装

待实现后才谈得上。计划是走 `plugin_manager` 的 `install_bundle`，target 指向本包目录，由它写入 profile 的清单与 patch 叠加；**不要**手改 profile 的 `package.json` / `cordis.patch.yml`。

## License

MIT，见 [LICENSE](LICENSE)。
