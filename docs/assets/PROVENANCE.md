# 截图出处（`docs/assets/*.png`）

这两张图不是设计稿、不是手工 HTML，也不是原型分支的产物：它们是在**真实 DSH 宿主**（`dsh web`）上、
用**无头 Chrome + CDP** 驱动本仓库根包的插件截下来的。下面记录能让人重跑一遍的全部事实。

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

## 窗口与像素

| 项 | 值 |
| --- | --- |
| 视口（Emulation 覆盖） | **1656 × 900** CSS px |
| `deviceScaleFactor` | **2** |
| 左侧栏 | 调音台会自动把它折成 56px 轨道（spec §7.1），**截图时整条裁掉**（`clip.x = 56`） |
| 出图裁剪区 | `x=56, y=0, width=1600, height=700`（CSS） |
| 两张 PNG 的像素尺寸 | **3200 × 1400**（= 1600×700 CSS × DPR 2） |
| 文件体积 | `mixer.png` ≈ 163 KB、`mixer-solo.png` ≈ 93 KB（均远小于 800 KB） |

## 每张图里是什么

### `mixer.png` —— README 主图

调音台视图叠在真实宿主上，**3 个通道并排**（每格 511 CSS px）：

- 顶栏完整保留：`调音台` 标签 │ `会话 · 3` chip │ 右侧 `常规视图`；
- 每格头部：会话标题（`api` / `web-app` / `infra`）、`solo` 按钮、`×`（移出），下面是 `对话` / `轨迹` 视图标签；
- 每格各自一份宿主官方 composer（空会话的 hero 态），**输入框里各有一段不同的草稿**：
  - `回调签名比较改成常量时间，再补一条重复通知的用例。`
  - `导出字段跟运营对过了：金额两位小数，空值留空。`
  - `镜像层顺序调一下，依赖安装放到源码复制之前。`
- 最右那格是当前焦点所在（输入卡片带宿主自己的 2px 焦点描边，spec §5.3）；
- 通道之间是 5px 抓取带 + 1px 分界线。

### `mixer-solo.png` —— solo 态

同一屏，点了 `web-app` 这格的 `solo` 之后：

- 被 solo 的通道占满剩余宽度，头部变成 `web-app` + `退出`（+ `×`）；
- 其余两个通道压成 **64px 窄条**（`api` / `infra`）：凹陷表面 + 右缘 1px 分界线 + 主色标题；
- 顶栏多出 `solo：web-app 退出` chip；
- `web-app` 那格的草稿仍是 `导出字段跟运营对过了：金额两位小数，空值留空。`，`会话 · 3` 计数不变
  —— solo 只是视图状态，通道照旧在（spec §5.7）。

## 演示数据：全部虚构

**所有工作区与会话均为 `/tmp` 下虚构演示数据，无真实用户内容。**

- 沙箱 `DSH_HOME` 只从 `~/.dsh` 复制的 `profiles`（纯配置），**没有**复制
  `sessions` / `storages` / `logs` / `attachments` / 凭据，因此宿主从一个空库起步；
- 虚构工作区：`/private/tmp/mixer-demo/{web-app,api,infra}`（macOS 下 `/tmp` 的真身是 `/private/tmp`），
  里面只有两三个随手写的示例文件；
- 虚构会话：3 个空会话，标题就取工作区名（`api` / `web-app` / `infra`）；
- 输入框草稿是自拟的中文业务文案（见上）；
- 截图里**不出现**任何真实工作区名（`d` / `code` / `tcel-main-project` / `fs-sub-flow` / `temp` /
  `turbo-json-viewer` / `learn-personal-agent` / `fs-new-booking` / `wx-claw-bot` / `video` /
  `deepseek-harness` / `mvp-hotel` / `code-bot` / `user` / `fs-main-flow` 等），**不出现** `/Users/...` 路径，
  也不出现登录弹窗或左侧栏。

## 复现步骤（要点）

1. **沙箱 HOME**（只带配置）：

   ```bash
   export SH=/tmp/dsh-mixer-shot-home
   rm -rf "$SH" && mkdir -p "$SH"
   cp -R ~/.dsh/profiles "$SH/profiles"
   # profile 里只留 base + web-app + dsh-mixer；dsh-mixer 指向工作区（绝对软链）
   ln -sfn /Users/user/Documents/code/d/dsh-mixer "$SH/profiles/web/node_modules/dsh-mixer"
   ```

   顺手把这台机器上无关的 bundle（`better-miniprogram-sim`、agent-team profile）从
   `profiles/web/package.json` 的 `dependencies` / `dsh.profile.bundles` 里去掉，冷启动更快也更干净。

2. **虚构工作区 + 把沙箱的 `cordis.patch.yml` 的 `workspaceRoot` 改到 `/tmp/mixer-demo`**。

3. **起 server**（后台）：

   ```bash
   cd /Users/user/Documents/code/deepseek-harness
   DSH_HOME=$SH node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 4599
   # 从 stdout 取 `?token=…`
   ```

4. **无头 Chrome**：

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless=new --no-sandbox --disable-gpu --disable-crash-reporter --disable-breakpad \
     --remote-debugging-port=9333 --user-data-dir=/tmp/chrome-mixer-shot \
     --window-size=1600,1000 --force-device-scale-factor=2 --hide-scrollbars about:blank
   ```

   （`--window-size` 只是初始值，headless 会再扣掉一层浏览器高度；出图用的 1656 × 900 由下一步的
   `Emulation.setDeviceMetricsOverride` 精确指定，实测 `innerWidth/innerHeight` 与之一致。）

5. **CDP 驱动**（Node 24 原生 `WebSocket`，零依赖；`/json/list` 取 `webSocketDebuggerUrl`）：

   ```js
   await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
   await send('Emulation.setDeviceMetricsOverride', { width: 1656, height: 900, deviceScaleFactor: 2, mobile: false })
   await send('Page.navigate', { url: `http://127.0.0.1:4599/?token=${token}` })
   // 轮询 Runtime.evaluate 等 document.readyState / 插件 UI 出现，不要固定 sleep
   ```

   进调音台、造通道、打草稿、截图**全部走 CDP**：
   - 进调音台：composer 里 `Input.insertText` 打 `/mixer` → 点命令菜单里的 `调音台视图`（等价于会话头的 `调音台` 按钮）；
   - 加通道：点 `[data-mixer-sessions]` 打开 `会话` 浮层 → 把指针移到某工作区行（`data-mixer-workspace`）让
     `＋会话`（`data-mixer-new="<workspaceId>"`）浮现 → 点它（新通道落在第 0 位）；
   - 打草稿：点该格 `[data-composer-card]`，`Input.insertText` 输入文本（占位符不算内容，必须真的输入）；
   - solo：点该格 `[data-mixer-solo]`（solo 后变 `退出`），或顶栏 `[data-mixer-solo-exit]` 退出；
   - 截图：`Page.captureScreenshot({ format: 'png', clip: { x: 56, y: 0, width: 1600, height: 700 } })`
     —— `x = 56` 就是裁掉折叠后的侧栏轨道。

6. **清理**：关 Chrome、停 server，删 `/tmp/chrome-mixer-shot`、`/tmp/dsh-mixer-shot-home`、`/tmp/mixer-demo`。

## 这一轮踩到的坑（下次直接绕开）

- **`/tmp` 不是真路径**：macOS 上 `/tmp` 是 `/private/tmp` 的软链。工作区记录的 `path` 必须是
  **realpath**，否则宿主拒绝挂载会话（`session/workspace-attach-failed: … its cwd resolves to
  '/private/tmp/…'`），表现是"会话建了但列表里没有"。
- **Chrome 在 DSH 自己的文件沙箱里起不来**：报 `sandbox initialization failed: Operation not permitted`，
  必须加 `--no-sandbox`（再顺手关掉 crashpad，否则日志被崩溃上报刷屏）。
- **`--dump-dom` / `--screenshot` 对活页面会挂住**（websocket 长连接 + virtual time 不触发），只能用
  CDP 轮询 `Runtime.evaluate`。
- **`--dump-dom` 那份页面没有 token**：URL 里不带 `?token=` 时 RPC 不通，界面会停在"工作区空空如也"的样子。
- **未登录弹窗**：沙箱宿主是未登录态，首屏可能盖一层"登录 / 添加 API Key"弹窗，用 aria-label 为 `关闭`
  的按钮关掉即可（**不要**去登录，也**不要**用任何真实凭据）。会话创建、草稿都是本地能力，不需要登录。
- **暗色主题**只能靠 `Emulation.setEmulatedMedia` 给，headless 默认是浅色。
