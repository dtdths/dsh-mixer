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

**已发布：[`v1.2.0`](https://github.com/dtdths/dsh-mixer/releases/tag/v1.2.0)（此前 `v1.1.0` / `v1.0.0`），`main` 与 `feat/mixer-v1` 同点。** 四条用户需求（空会话居中 / 新建不离开调音台 / 整格拖拽虚影 / 顶栏重做）与归档能力都已实现，并在真实 DSH 宿主上按 [`docs/spec.md`](docs/spec.md) §6 逐条验收通过。之后两轮：v1.1.0 = `会话` 浮层新建入口挪进左列每个工作区行 + 行/按钮 hover 态可辨；v1.2.0 = 归档可撤销（顶栏 6s `撤销`，通道回原位与宽度）。`npm run check` = 82 用例 + 冷启动守卫。

- **[`docs/spec.md`](docs/spec.md) 是交接物**：§1–§8 是设计，**§11 是正式版实现状态**（文件、内部缝、验证命令、逐轮验收记录）。
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

## 安装

只装 **Client half**（Host half 是空的），三种方式按需要选。装完都要把原型包 `dsh-mixer-spike` 从 profile 卸掉 —— 它和正式版会抢同一个 `main` key。

**A. 从仓库目录装（开发 / 日常，热更新）** —— 当前开发机就是这种：

```
plugin_manager → install_bundle，target = 本包根目录的绝对路径
```

profile 里会写成 `"dsh-mixer": "link:/…/dsh-mixer"`；之后改代码、刷新页面即生效（改了 `apply()` / `inject` 必须硬刷新，见下方验证第 2 条）。

**B. 从 tag 装（冻结版本，推荐给别人 / 另一台机器）**：

```
plugin_manager → install_bundle，target = "github:dtdths/dsh-mixer#v1.2.0"
```

装进 `node_modules` 的是**快照**，不会热更新；升级就是重新装一个新 tag。

**C. tarball（离线 / 内网 / 不想让它连 GitHub）**：

```bash
npm pack --cache /tmp/npm-cache        # 产出 dsh-mixer-1.2.0.tgz
# 把 tgz 传过去，然后：
plugin_manager → install_bundle，target = "/绝对路径/dsh-mixer-1.2.0.tgz"
```

**不发布 npm**：`package.json` 是 `private: true`，交付形态就是上面三种。

## 验证

拉代码后先跑自动化（无需浏览器）：

```bash
npm run check                          # 语法 + 79 个用例 + 冷启动守卫
DSH_REPO=/别的/DSH/checkout npm run check   # 换宿主重验：契约漂移会指到具体文件与断言
```

装完的浏览器验收清单见 [docs/spec.md](docs/spec.md) §6 —— 其中**第 2 条"硬刷新冷启动"必须做**（任何 `apply()` 改动都不能只靠热重载验证）。

profile 侧判据：依赖是 `link:/…` 或 `github:…#tag`（或 tgz），`dsh.profile.bundles` 里有 `dsh-mixer` 且**没有** `dsh-mixer-spike`；硬刷新后没有 `Failed to load plugins` / `web boot: N entry did not activate`；会话头出现「调音台」按钮，`/mixer` 可用。

## 发布

1. `npm run check` 绿；再对目标 DSH 宿主跑一次 `DSH_REPO=… npm run check`。
2. 把 `package.json` 的 `version` bump 到与 tag 一致（v1.2.0 对应 `1.2.0`）。
3. 提交后合入默认分支：`git checkout main && git merge --ff-only feat/mixer-v1 && git push origin main`。
4. 打 tag 并推送：`git tag -a v1.2.0 -m "dsh-mixer v1.2.0" && git push origin v1.2.0`。
5. `gh release create v1.2.0 --title … --notes-file …`：notes 里写**安装命令**（B 方式那行）与**验证过的 DSH runtime 版本**（v1.2.0 对 `0.2.1-alpha.1` / checkout `5badb15` 验证）。
6. 发完复核：`gh release view v1.2.0`、`git ls-remote --tags origin`，以及全新 profile 上按 B 方式装一次、走 §6 清单。

## License

MIT，见 [LICENSE](LICENSE)。
