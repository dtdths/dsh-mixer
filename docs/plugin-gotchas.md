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
