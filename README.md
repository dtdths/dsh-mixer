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

**设计定稿，根包 `dsh-mixer` 已实现（分支 `feat/mixer-v1`），待装到 profile 上按清单验收。**

- **[`docs/spec.md`](docs/spec.md) 是交接物**：§1–§8 是设计，**§11 是正式版实现状态**（文件、内部缝、验证命令）。
- 设计由一次性原型验证（分支 [`spike/mixer-two-pane`](https://github.com/dtdths/dsh-mixer/tree/spike/mixer-two-pane) 的 `spike/` 包 `dsh-mixer-spike`），机制已全部搬进根包；**装根包后请把 spike 卸掉**。
- 原型已实测确认关键前提：**多会话真并排可行**（每格渲染官方 composer 与完整对话记录）。
- Host half 保持空 —— 本需求无需 Host 改动。

## 结构

```
dsh-mixer/
├── package.json          # bundle 清单 + dsh.client.external / inject
├── cordis.patch.yml      # 插入行 id=dsh-mixer / name=dsh-mixer
├── index.js              # Host half（保持为空）
├── client.js             # Client half（全部 UI 与状态，单文件）
├── boot-check.mjs        # 冷启动守卫（真实 Cordis Context + 对照项）
├── tests/                # node --test 覆盖的纯函数缝
├── locale/{en,zh}.json   # meta.title / meta.description
├── icon.svg              # 原创图标：三路推子，其中一路亮灯
├── docs/
│   ├── spec.md            # ★ 实现 spec（§11 = 实现状态）
│   ├── plugin-gotchas.md  # 已验证的 DSH 客户端插件坑 + 证据
│   ├── naming.md          # 命名决策记录
│   ├── open-questions.md  # 立项前的问题清单（已被 spec 取代，留作过程记录）
│   ├── adr/               # ADR-0001 自持引用来源 / ADR-0002 整屏替换走 main
│   ├── research/          # 可行性调研报告（83 个行号锚点已核校）
│   └── agents/            # issue tracker / triage 标签 / 领域文档约定
└── LICENSE
```

原型（`spike/`）只在 `spike/mixer-two-pane` 分支上，保留作对照，不参与根包运行。

## 安装与验证

只装 Client half，从本仓库目录安装：

```
plugin_manager → install_bundle，target = 本包根目录
# 然后从 profile 里卸掉 dsh-mixer-spike（原型与正式版会抢同一个 main key）
```

拉代码后先跑自动化（无需浏览器）：

```bash
npm run check        # 语法 + 纯函数测试 + 冷启动守卫
```

profile 会生成一条 `link:`，改代码后刷新即生效。**装完的验证清单见 [docs/spec.md](docs/spec.md) §6**（其中第 2 条"硬刷新冷启动"是必须做的 —— 任何 `apply()` 改动都不能只靠热重载验证）。

## License

MIT，见 [LICENSE](LICENSE)。
