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

## 2. 冷启动不等于 HMR

在已经启动好的页面上热重载插件时，**所有服务早就到位**，所以带 bug 的代码看起来完全正常。只有当页面**全新加载**、插件在 `commandUi` 之类的服务被 provide 之前 apply 时，才会暴露。

**规则**：任何改动只要碰 `apply()`，就必须做一次"冷启动"验证，而不是在活着的页面上刷一下就算过。

**本仓库的守卫**：

```bash
node spike/boot-check.mjs
```

它把真实的 `spike/client.js` 放进真实的 Cordis Context，按宿主装载路径（`root.inject(def.inject, scope => apply(scope))`）启动，读 fiber 状态；并内置一个**对照项**复现当年的故障模式 —— 对照项若不再失败，脚本会自报"这个检查证明不了任何东西"。

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
