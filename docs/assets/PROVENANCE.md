# 截图出处（`docs/assets/*.png`）

这两张图不是设计稿、不是手工 HTML，也不是原型分支的产物：它们是在**真实 DSH 宿主**（`dsh web`）里、
用**无头 Chrome + CDP** 驱动本仓库根包的插件截下来的，而且图里的对话是**真实模型回合**跑出来的
（不是占位文本）。下面记录能让人重跑一遍的全部事实。

## 宿主与插件版本

| 项 | 值 |
| --- | --- |
| 宿主 checkout | `/Users/user/Documents/code/deepseek-harness` |
| 宿主 `package.json` 版本 | **0.2.1-rc.2** |
| 宿主 `git rev-parse --short HEAD` | **687f282**（`687f282e86`） |
| 插件 | 本仓库根包，分支 `feat/mixer-v1`，HEAD `c3b81c9`，以 `link:` 装进沙箱 profile |
| profile | 沙箱 `DSH_HOME` 里的 `profiles/web`，`dsh.profile.bundles` 只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-mixer` |
| 启动命令 | `DSH_HOME=<沙箱> node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 4599` |
| 浏览器 | Google Chrome 155.0.8059.85，`--headless=new` |
| 主题 | 暗色（`Emulation.setEmulatedMedia` 的 `prefers-color-scheme: dark`） |
| 模型 | `DeepSeek V4.1 Flash`（profile 的 `agent-default-model` 那条 patch；回合真的发出去了） |

## 沙箱怎么拿到登录态

- 沙箱 `DSH_HOME` 从 `~/.dsh` **只**复制两样：`profiles`（纯配置）与 `.credentials.yaml`（登录凭据）。
- 凭据文件只落在 `/tmp` 的一次性沙箱里：**没有**被读取打印、**没有**进入仓库、也没写成任何文件；
  整个沙箱在收尾时删除。宿主的 `~/.dsh` 本体、3080 上正在用的 GUI、live token 全程没碰。
- 有了它，沙箱宿主是登录态：`/mixer` 命令、通道、composer 都正常，模型回合也能真的跑，
  首屏不再要求登录（图里也没有任何登录弹窗）。

## 窗口与像素

| 项 | 值 |
| --- | --- |
| 视口（`Emulation.setDeviceMetricsOverride`） | **1656 × 700** CSS px |
| `deviceScaleFactor` | **2** |
| 左侧栏 | 调音台会自动把它折成 56px 轨道（spec §7.1），**截图时整条裁掉**（`clip.x = 56`） |
| 出图裁剪区 | `x=56, y=0, width=1600, height=700`（CSS） |
| 两张 PNG 的像素尺寸 | **3200 × 1400**（= 1600×700 CSS × DPR 2） |
| 文件体积 | `mixer.png` ≈ 418 KB（428,411 B）、`mixer-solo.png` ≈ 208 KB（213,360 B）（均小于 800 KB） |

> 视口高度选 700 而不是更高的窗口，是因为**审批卡很高**（约 260px）：在 900 高的窗口里它会顶到
> 可视区之外，700 高时刚好整张卡（含 `拒绝` / `允许一次`）都落在画面里。

## 每张图里是什么

### `mixer.png` —— README 主图（空 / 在跑 / 在等你，三格同框）

从左到右三个通道，三格状态各不相同，一眼可辨：

1. **`infra`：空对话**（hero + 输入框）。composer 里有一段未发送的草稿：
   `镜像层顺序调一下，依赖安装放到源码复制之前。` —— 这一格是「真实会话」的锚点。
2. **`直接写入 manifest.csv 表头`：等待审批**（`data-mixer-state="waiting"`，头部左侧 2px 琥珀竖条）。
   对话里有模型的思考与一次被沙箱拒绝的写入，下面就是真实的 `[data-approval-key]` 卡片：
   `等待审批` + 越界理由（把清单写到工作区外的 `/srv/demo-artifacts/manifest.csv`）+ `拒绝` / `允许一次`。
3. **`清理代码中的 TODO 并写计划`：进行中**（头部转圈，`data-mixer-state="running"`）。
   有真实对话记录、`已编辑 N 个文件` 的改动卡（`+89 -0` / `+130 -0` …）、`todo-plan.md` 产物卡、
   时间轴上的 `思考` / `读取` / `编辑` 步骤，以及 `深度求索中，用时 … ` 的实时状态行。

顶栏完整保留：`调音台` │ `会话 · 3` │ **`1 个通道在等你`** │ `常规视图`。

### `mixer-solo.png` —— solo 态（宽格里是活的回合）

对第 3 格点 `solo` 之后：

- 被 solo 的通道占满剩余宽度，头部变成 `清理代码中的 TODO 并写计划` + `退出`（+ `×`）：
  里面正是它**正在跑**的回合 —— 刚发出的中文需求、`更新任务清单`、`读取 tests/cart.test.ts`、
  `深度求索中，用时 35 秒`、`任务 1 进行中 · 3 待处理`；
- 其余两个通道压成 **64px 窄条**：`infra`（空）与 `直接写入…`（那条**正在等你**的通道，
  窄条顶部有琥珀状态点）—— 这就是「solo 只是视觉聚焦，其余通道照常亮灯」（spec §5.7）；
- 顶栏同时挂着 `1 个通道在等你` 与 `solo：… 退出` 两个 chip。

### `waiting.png` —— 等待审批卡的近景（从 `mixer.png` 第 2 格裁出）

同一张主图的裁切，不引入任何新内容：只取那一格的 `[data-approval-key]` 卡片（`等待审批` +
越界理由 + `拒绝` / `允许一次`）。裁切范围 = `mixer.png`（3200×1400）的
`x=1126, y=878, w=944, h=524`，原生 1:1 像素、**没有放大**（`sips` 直接裁）。

## 演示数据：全部虚构

**所有工作区与会话均为 `/tmp` 下虚构演示数据，无真实用户内容。**

- 虚构工作区：`/private/tmp/mixer-demo/{web-app,api,infra}`（macOS 下 `/tmp` 的真身是 `/private/tmp`），
  里面只有几个随手写的示例文件（`src/cart.ts` / `src/checkout.ts` / `tests/cart.test.ts` …）与 TODO 注释；
- 会话：三个空会话，标题由**真实回合**自动命名（`清理代码中的 TODO 并写计划` /
  `直接写入 manifest.csv 表头` / 工作区名 `infra`）；
- 草稿与 prompt 都是自拟中文业务文案，见下节原文；
- 截图里**不出现**任何真实工作区名（`d` / `code` / `tcel-main-project` / `fs-sub-flow` / `temp` /
  `turbo-json-viewer` / `learn-personal-agent` / `fs-new-booking` / `wx-claw-bot` / `video` /
  `deepseek-harness` / `mvp-hotel` / `code-bot` / `user` / `fs-main-flow` 等），**不出现** `/Users/...` 路径，
  也不出现登录弹窗或左侧栏。工具行里出现的路径只有演示树本身（`/private/tmp/mixer-demo/...`）
  与虚构的发布目录（`/srv/demo-artifacts/...`）。

## 真实回合是怎么造出来的

三个通道的输入（原文）：

- **进行中那格**（`web-app` 工作区）：
  `把 src 和 tests 下的每个文件从头到尾读一遍，列出里面的 TODO，然后逐个改掉：每处理完一个文件再读下一个，最后写一份 docs/todo-plan.md 记录你改了哪些地方、为什么。`
  之后又追加过几轮（补测试、补 JSDoc、重排断言），截图抓的是其中一轮还在跑的时刻。
- **等待审批那格**（`api` 工作区）：
  `直接用写文件的工具把表头写成一行 name,size 保存到 /srv/demo-artifacts/manifest.csv（发布目录在工作区外），不要先运行任何命令。`
  → 写文件被 `workspace-write` 策略拒绝 → 宿主弹提权请求 → 那张 `[data-approval-key]` 卡。
  截图时**故意不点** `允许一次`，所以越界写入从未发生，工作区外没有任何文件被创建。
- **空对话那格**（`infra` 工作区）：只打草稿，不发送。

⚠️ 一处诚实说明：这台机器的宿主跑在本 agent 自己的文件沙箱里，**嵌套的 `sandbox-exec` 起不来**，
所以 `bash` 工具在这个沙箱宿主里报 `sandbox mode "workspace-write" is requested but no sandbox backend
is usable on this host`，并因此提权。为了不让画面变成"每个 bash 调用都在要权限"，进行中那格第一张
审批卡是在 CDP 里点了 `拒绝` 后让它改用文件读写工具继续跑的 —— 图里那条灰色 `Error: [sandbox: …]`
就是这件事的痕迹。审批卡本身（第 2 格）仍然是真实触发的，理由也来自模型自己写的那段话。

## 复现步骤（要点）

1. **沙箱 HOME**（配置 + 凭据，仅此两样）：

   ```bash
   export SH=/tmp/dsh-mixer-shot-home
   rm -rf "$SH" && mkdir -p "$SH"
   cp -R ~/.dsh/profiles "$SH/profiles"
   cp ~/.dsh/.credentials.yaml "$SH/.credentials.yaml" && chmod 600 "$SH/.credentials.yaml"
   ln -sfn /Users/user/Documents/code/d/dsh-mixer "$SH/profiles/web/node_modules/dsh-mixer"
   ```

   profile 里只留 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-mixer`；
   `cordis.patch.yml` 的 `workspaceRoot` 改成 `/tmp/mixer-demo`。

2. **虚构工作区**：`/tmp/mixer-demo/{web-app,api,infra}`，塞几个带 `TODO` 注释的小文件。

3. **起 server**：见上表；token 从 stdout 取。

4. **无头 Chrome**：

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless=new --no-sandbox --disable-gpu --disable-crash-reporter --disable-breakpad \
     --remote-debugging-port=9333 --user-data-dir=/tmp/chrome-mixer-shot \
     --window-size=1600,1000 --force-device-scale-factor=2 --hide-scrollbars about:blank
   ```

5. **CDP 驱动**（Node 24 原生 `WebSocket`，零依赖）：

   ```js
   await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
   await send('Emulation.setDeviceMetricsOverride', { width: 1656, height: 700, deviceScaleFactor: 2, mobile: false })
   await send('Page.navigate', { url: `http://127.0.0.1:4599/?token=${token}` })
   // 轮询 Runtime.evaluate，等插件 UI / 各格状态，而不是固定 sleep
   ```

   - 进调音台：composer 里 `Input.insertText` 打 `/mixer` → 点命令菜单里的 `调音台视图`；
   - 加通道：`[data-mixer-sessions]` 开 `会话` 浮层 → 指针移到工作区行（`data-mixer-workspace`）让
     `＋会话`（`data-mixer-new="<workspaceId>"`）浮现 → 点它（新通道落在第 0 位）；
   - 发 prompt：点 `[data-composer-card]` → `Input.insertText` → 点 `[aria-label="发送消息"]`；
   - 轮询状态：`[data-mixer-pane][data-mixer-state]`（`idle` / `running` / `waiting`）+
     `[data-approval-key]` 是否出现；
   - solo：点该格 `[data-mixer-solo]`（solo 后变 `退出`），顶栏 `[data-mixer-solo-exit]` 退出；
   - 截图：`Page.captureScreenshot({ format: 'png', clip: { x: 56, y: 0, width: 1600, height: 700, scale: 1 } })`。

6. **收尾**：关 Chrome、停 server，删 `/tmp/chrome-mixer-shot`、`/tmp/dsh-mixer-shot-home`（含凭据副本）、
   `/tmp/mixer-demo`。

## 这一轮踩到的坑（下次直接绕开）

- **`/tmp` 不是真路径**：macOS 上 `/tmp` 是 `/private/tmp` 的软链。工作区记录的 `path` 必须是
  **realpath**，否则宿主拒绝挂载会话（`session/workspace-attach-failed: … its cwd resolves to
  '/private/tmp/…'`），表现是"会话建了但列表里没有"。
- **Chrome 在 DSH 自己的文件沙箱里起不来**：报 `sandbox initialization failed: Operation not permitted`，
  必须加 `--no-sandbox`（再顺手关掉 crashpad，否则日志被崩溃上报刷屏）。
- **`--dump-dom` / `--screenshot` 对活页面会挂住**（websocket 长连接 + virtual time 不触发），只能 CDP 轮询。
- **`Emulation.*` 覆盖是跟着 CDP 会话走的**：每个新 WebSocket（即每个新的 node 脚本）都要**重新**
  `setDeviceMetricsOverride`，否则视口回到窗口默认值 —— 这一轮因此先把审批卡截到了画面外，
  白跑了一次截图。
- **`--dump-dom` 那份页面没有 token**：URL 里不带 `?token=` 时 RPC 不通，界面停在"没有会话"。
- **未登录弹窗**：凭据没带进来时首屏会盖一层"登录 / 添加 API Key"；带进来就消失，别去真的登录。
- **暗色主题**只能靠 `Emulation.setEmulatedMedia` 给，headless 默认是浅色。
- **bash 工具在嵌套沙箱里不可用**（见上文），所以演示回合只依赖文件读写工具。
