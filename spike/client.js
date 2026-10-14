/**
 * THROWAWAY PROTOTYPE - wayfinder tickets #3 (UI), #4 (feasibility), #9 (picker).
 *
 * Round 4, per user feedback: V2 is the chosen base, and
 *   1. one unified top bar over the channels,
 *   2. the top bar carries ONLY what the collapsed rail loses. The 56px rail
 *      keeps the brand mark, the panel icons and the settings gear
 *      (ui-sidebar/SidebarRoot + ui-settings-general/chrome), so repeating them
 *      here would duplicate the same routes; the rail drops the workspace and
 *      session browsing region, so the workspace dropdown lives here,
 *   3. a close button on every channel header: the channel leaves the mixer
 *      while its task keeps running,
 *   4. a `/mixer` slash command (ctx.commandUi, Client-owned action command).
 *
 * Host limits verified in the runtime, and how this round handles them:
 *   - The sidebar cannot reach zero width: `computeColumns` uses
 *     SIDEBAR_COLLAPSED = 56 whenever it is closed, so the mixer collapses it
 *     and lives with the rail (user decision).
 *   - Settings has no programmatic open path, but it survives in the rail as a
 *     gear icon, so no top-bar replacement is needed (user decision).
 *   - Nothing exposes the sidebar's collapsed state (`PanelInfo` carries only
 *     `activePanelId`), so the collapse below reads the frame's own
 *     `data-sidebar-collapsed` marker as a prototype shortcut. A real build
 *     needs a layout API for this.
 *
 * Prototype rules apply: no polish, no tests, no persistence. Delete this
 * directory once the verdicts are recorded.
 *
 * Design discipline (design-taste skill, applied to dense product UI):
 * - ONE accent: `--dsw-alias-state-warn-primary`, only for the waiting state.
 * - Shape lock: surfaces square (0), interactive elements pills (999).
 * - Motion: near zero. Host tokens only. No emoji, no hand-rolled SVG icons.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mixer-spike',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    /**
     * Reuse the host's own state dot for the "AI is running" indicator, so the
     * mixer matches the left sidebar's session rows exactly instead of hand-rolling
     * a spinner. `StateDot state="ongoing"` is that same loading glyph (a quiet
     * ring plus a breathing arc), and it already handles `prefers-reduced-motion`
     * and keeps concurrent loaders in phase.
     *
     * Declared as `dsh.client.external` in package.json. The read is guarded on
     * purpose: a module the table cannot resolve would otherwise throw inside the
     * factory and fail the whole entry (the round-4 class of incident), so the
     * indicator simply falls back to a plain dot.
     */
    let StateDot = null
    try {
      StateDot = require('@deepseek-ai/dsh-client-ui-primitives').StateDot
    } catch (error) {
      console.error('[mixer-proto] ui-primitives unavailable, running dot falls back', error)
    }

    const PANEL_ID = 'mixer'
    /** Our own Session reference source; never `mainView` (see docs/adr/0001). */
    const SOURCE = 'mixerChannel'
    /** Default channel set before the user has picked one (decision: ticket #6). */
    const PANE_LIMIT = 3
    /** Fixed minimum pane width; more channels than fit scroll horizontally (#6). */
    const MIN_PANE_W = 380
    /**
     * Pane width at which the turn navigator is allowed to show (user decision:
     * lower the host's breakpoint rather than keep it or drop it).
     *
     * The host hides the rail below 900px of CONTAINER width
     * (`TurnNavigator.module.css`: `@container (max-width: 900px) { .frame { display: none } }`),
     * and that container is the rail's own `.slot`, which pads itself by
     * `calc(var(--dsh-composer-side-clearance) + 16px)` per side. In our embedded
     * panes the clearance is 8px (`ConversationRoot.module.css`, `.embeddedBody`),
     * so the container measures pane − 2*(8+16) = pane − 48. The host's effective
     * pane requirement is therefore ~948px; ours is 640px, i.e. 592px of container.
     */
    const RAIL_MIN_PANE_W = 640
    const RAIL_MIN_CONTAINER_W = RAIL_MIN_PANE_W - 48
    /* Persisted channel selection (#9). Namespaced like ui-sidebar-right's
       `dsh.sidebar-right.v1`; the real build should go through the store
       persistence convention instead of touching localStorage directly. */
    const PERSIST_KEY = 'dsh.mixer-spike.v1'
    const PROTOTYPE = true
    const VARIANTS = ['V1', 'V2', 'V3']
    const VARIANT_NOTE = {
      V1: 'V1 点标：等待的通道标题前一个圆点与「等你」胶囊',
      V2: 'V2 边缘强调（已选）：等待的通道【仅】头部左侧一条竖条',
      V3: 'V3 主次分栏：等待的通道自动升为宽栏',
    }

    const T = {
      base: 'var(--dsw-alias-bg-base)',
      l1: 'var(--dsw-alias-bg-layer-1)',
      l2: 'var(--dsw-alias-bg-layer-2)',
      b1: 'var(--dsw-alias-border-l1)',
      b2: 'var(--dsw-alias-border-l2)',
      fg: 'var(--dsw-alias-label-primary)',
      fg2: 'var(--dsw-alias-label-secondary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      /* The host's focus colour (ui-theme focus.css falls back to this). */
      business: 'var(--dsw-alias-state-business-primary)',
    }
    const SURFACE = 0
    const PILL = 999
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
    const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif'

    const KIND_LABEL = { approval: '等待审批', 'plan-review': '等待计划确认', question: '等待回答' }

    const MOCK_TASKS = [
      {
        user: 'validate.ts 里边界校验重复了三处，抽成一个函数，顺手把边界用例补上。',
        say: '先看现有实现，再决定抽到哪里。',
        tools: [
          { name: 'Read', arg: 'src/validate.ts', out: '214 行，三处重复的边界分支' },
          { name: 'Edit', arg: 'src/validate.ts', out: '抽出 validateBoundary()' },
          { name: 'Bash', arg: 'pnpm vitest run validate', out: '12 passed, 0 failed' },
        ],
        last: '已抽出 validateBoundary，13 个用例通过。要不要把重复的默认值也一起合并？',
        approval: { command: 'Bash: pnpm vitest run --coverage', detail: '覆盖率报告会写入 coverage/ 目录' },
      },
      {
        user: 'CI 上 pnpm build 比本地慢一倍，帮我找出原因。',
        say: '先比对两边的缓存命中情况。',
        tools: [
          { name: 'Read', arg: '.github/workflows/ci.yml', out: '未配置 actions/cache' },
          { name: 'Grep', arg: 'cache 命中日志', out: '本地 .vite 命中，CI 冷启' },
        ],
        last: '差异来自依赖缓存：CI 每次都冷启 node_modules 与 .vite。加一步 actions/cache 即可。',
        approval: { command: 'Bash: pnpm build --profile', detail: '会生成本地构建耗时剖析文件' },
      },
      {
        user: '设置页加一个「记住上次选的模型」开关。',
        say: '先确认这个偏好的存储位置，避免和全局设置打架。',
        tools: [
          { name: 'Grep', arg: 'modelPreference', out: '2 处读写点' },
          { name: 'Read', arg: 'src/settings/store.ts', out: '已有 localPreference 容器' },
        ],
        last: '可以复用 localPreference 容器，改动集中在设置页与 composer 初始值两处。',
        approval: { command: 'Bash: pnpm test settings', detail: '会运行设置页相关用例' },
      },
    ]

    /** Read the persisted channel selection; any failure means "nothing stored". */
    function loadStoredChannels() {
      try {
        const raw = window.localStorage.getItem(PERSIST_KEY)
        if (raw === null || raw === undefined) return null
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return null
        const ids = parsed.filter(id => typeof id === 'string' && id !== '')
        return ids.length === 0 ? null : ids
      } catch (error) {
        console.error('[mixer-proto] stored channel selection unusable, ignoring it', error)
        return null
      }
    }

    /** Best-effort write; storage being unavailable must never break the view. */
    function saveStoredChannels(ids) {
      try {
        window.localStorage.setItem(PERSIST_KEY, JSON.stringify(ids))
      } catch (error) {
        console.error('[mixer-proto] could not persist the channel selection', error)
      }
    }

    const CSS = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 420, minWidth: 0, background: T.base, color: T.fg },
      /* Unified top bar: mixer label, workspace dropdown, waiting summary,
         view exit. Global entries deliberately absent, see the note in TopBar. */
      topbar: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', flexWrap: 'wrap',
        padding: '6px 12px', borderBottom: `1px solid ${T.b1}`, font: `12px/1.6 ${SANS}`,
        background: T.base,
      },
      topTitle: { fontWeight: 600 },
      divider: { width: 1, height: 18, background: T.b1, flex: '0 0 auto' },
      navBtn: {
        font: `12px/1.4 ${SANS}`, padding: '3px 9px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg, background: 'transparent', border: `1px solid transparent`,
      },
      navBtnOn: { background: T.l2, border: `1px solid ${T.b1}` },
      ghostBtn: {
        font: `11px/1.5 ${SANS}`, padding: '2px 9px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg2, background: 'transparent', border: `1px solid ${T.b1}`,
      },
      button: {
        font: `12px/1.4 ${SANS}`, padding: '3px 10px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg, background: T.l2, border: `1px solid ${T.b1}`,
      },
      topQuietInline: { color: T.fg2, font: `11px/1.6 ${MONO}` },
      chip: {
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '1px 7px', borderRadius: PILL, background: T.l2,
        border: `1px solid ${T.b1}`, color: T.fg2, font: `10px/1.8 ${SANS}`,
      },
      dot: { width: 7, height: 7, borderRadius: PILL, background: T.warn, flex: '0 0 auto' },
      ddWrap: { position: 'relative' },
      ddPanel: {
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, minWidth: 340, maxWidth: 460,
        maxHeight: '60vh', overflow: 'auto', background: T.base,
        border: `1px solid ${T.b2}`, boxShadow: '0 8px 28px rgba(0,0,0,.22)', padding: 4,
      },
      ddRow: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', cursor: 'pointer',
        font: `12px/1.6 ${SANS}`, borderRadius: SURFACE,
      },
      ddRowOn: { background: T.l1 },
      ddPath: { color: T.fg2, font: `10.5px/1.6 ${MONO}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      ddSub: { padding: '2px 8px 6px 26px', display: 'flex', flexDirection: 'column', gap: 2, borderLeft: `1px solid ${T.b1}`, marginLeft: 12 },
      ddSubRow: { display: 'flex', alignItems: 'center', gap: 7, padding: '3px 6px', cursor: 'pointer', font: `11.5px/1.6 ${SANS}` },
      backdrop: { position: 'fixed', inset: 0, zIndex: 39, background: 'transparent' },
      /* Channel row: a flex track (not a grid) because dividers are draggable.
         Horizontal overflow stays deliberate: cells keep MIN_PANE_W and the row
         scrolls instead of squeezing (#6), while the user can also widen a channel
         by dragging the divider. */
      track: {
        display: 'flex', flex: 1, minHeight: 0,
        overflowX: 'auto', overflowY: 'hidden', background: T.b1,
      },
      trackCell: {
        display: 'flex', flexDirection: 'column', minWidth: MIN_PANE_W,
        minHeight: 0, overflow: 'hidden', background: T.base,
      },
      /* Where a dropped channel (or a session row dragged in from the sidebar)
         would land. Two pixels of the host's focus colour, full height. */
      dropIndicator: {
        flex: '0 0 2px', alignSelf: 'stretch', background: T.business,
      },
      /* A 5px grab area with a 1px line down its middle, so the divider still
         reads as a hairline until you hover it. */
      resizer: {
        flex: '0 0 5px', display: 'flex', justifyContent: 'center', alignItems: 'stretch',
        cursor: 'col-resize', touchAction: 'none', background: 'transparent',
      },
      resizerLine: { width: 1, background: T.b1, transition: 'background 120ms linear' },
      resizerLineActive: { width: 1, background: T.business },
      pane: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: T.base, overflow: 'hidden' },
      /* Activation ring: on the COMPOSER, not the whole pane (user feedback).
         Real content is the shipped composer, which we cannot give a class to, so
         the panel injects a scoped rule keyed on the host's stable
         `[data-composer-seat]` hook. This style is the mock-mode equivalent. */
      composerFocused: {
        outline: `2px solid ${T.business}`,
        outlineOffset: '-2px',
      },
      dim: { opacity: 0.88 },
      /* Header: sized to actually be readable, since it carries the breadcrumb. */
      head: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
        padding: '7px 12px', borderBottom: `1px solid ${T.b1}`, font: `12.5px/1.6 ${MONO}`,
        whiteSpace: 'nowrap', overflow: 'hidden',
      },
      /* V2's whole waiting signal: a warn stripe on the head row only. */
      headWaitingV2: { boxShadow: `inset 2px 0 0 0 ${T.warn}` },
      /* Breadcrumb: ancestors are plain text (this pane IS the destination), the
         last crumb carries the weight. */
      crumbs: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' },
      crumb: { color: T.fg2, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 },
      crumbCurrent: {
        color: T.fg, fontWeight: 600, fontSize: 14, overflow: 'hidden',
        textOverflow: 'ellipsis', maxWidth: 280,
      },
      crumbSep: { color: T.fg2, opacity: 0.6, fontSize: 12.5 },
      /* Running indicator: the host's own StateDot, same as the sidebar rows.
         These two styles only cover the wrapper and the no-primitives fallback. */
      runningWrap: { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center' },
      runningFallback: {
        width: 8, height: 8, borderRadius: PILL,
        background: 'var(--dsw-alias-label-tertiary)',
      },
      closeBtn: {
        flex: '0 0 auto', width: 18, height: 18, lineHeight: '16px', textAlign: 'center',
        cursor: 'pointer', borderRadius: PILL, background: 'transparent',
        border: `1px solid ${T.b1}`, color: T.fg2, font: `11px/1 ${MONO}`, padding: 0,
      },
      body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      /* Real view tabs: ours, because the shipped header's view navigation is not
         mountable per pane. Switching re-renders with the view pinned, which the
         strict Session body honours (`viewId = view ?? active?.id`). */
      viewTabs: {
        display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto',
        padding: '0 12px', borderBottom: `1px solid ${T.b1}`,
      },
      viewTab: {
        font: `12.5px/1.6 ${SANS}`, padding: '6px 11px', cursor: 'pointer', borderRadius: 0,
        color: T.fg2, background: 'transparent', border: 'none',
        borderBottom: '2px solid transparent',
      },
      viewTabOn: { color: T.fg, fontWeight: 600, borderBottom: `2px solid ${T.b2}` },
      trajRow: { display: 'flex', gap: 8, padding: '6px 8px', borderBottom: `1px solid ${T.b1}`, font: `11px/1.7 ${MONO}` },
      trajTurn: { color: T.fg2, flex: '0 0 auto', minWidth: 28 },
      transcript: {
        flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 10, font: `12.5px/1.7 ${SANS}`,
      },
      roleLine: { color: T.fg2, font: `10px/1.7 ${MONO}`, marginBottom: 3 },
      userMsg: { background: T.l1, border: `1px solid ${T.b1}`, padding: '7px 9px' },
      sayMsg: { paddingLeft: 9, borderLeft: `2px solid ${T.b1}` },
      tool: { border: `1px solid ${T.b1}`, padding: '6px 8px', font: `11px/1.7 ${MONO}` },
      toolHead: { color: T.fg, marginBottom: 2 },
      toolOut: { color: T.fg2, whiteSpace: 'pre-wrap' },
      approval: { border: `1px solid ${T.b2}`, background: T.l1, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 },
      approvalHead: { display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 12 },
      approvalCmd: { font: `11px/1.7 ${MONO}`, color: T.fg },
      approvalDetail: { color: T.fg2, fontSize: 11.5 },
      rowWrap: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      composer: { flex: '0 0 auto', borderTop: `1px solid ${T.b1}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 },
      textarea: {
        width: '100%', minHeight: 46, maxHeight: 130, resize: 'vertical', boxSizing: 'border-box',
        background: T.base, color: T.fg, border: `1px solid ${T.b1}`, borderRadius: SURFACE,
        padding: '6px 8px', font: `12.5px/1.6 ${SANS}`, outline: 'none',
      },
      textareaFocus: { borderColor: T.b2 },
      composerRow: { display: 'flex', alignItems: 'center', gap: 6 },
      sendBtn: {
        font: `11px/1.5 ${SANS}`, padding: '3px 12px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg, background: T.l2, border: `1px solid ${T.b2}`,
      },
      sendBtnOff: { opacity: 0.5, cursor: 'default' },
      diag: {
        margin: 12, padding: '10px 12px', border: `1px solid ${T.b2}`, background: T.l1,
        font: `11.5px/1.7 ${SANS}`, color: T.fg,
      },
      diagLine: {
        flex: '0 0 auto', padding: '3px 10px', color: T.fg2, background: T.l1,
        borderBottom: `1px solid ${T.b1}`, font: `10.5px/1.7 ${MONO}`,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      empty: {
        flex: 1, display: 'flex', flexDirection: 'column', gap: 8,
        alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center', font: `13px/1.8 ${SANS}`,
      },
      emptyTitle: { fontWeight: 600 },
      emptyBody: { color: T.fg2, maxWidth: 420 },
      protoBar: {
        position: 'fixed', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 2147483000,
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexWrap: 'wrap',
        maxWidth: '92vw', borderRadius: PILL, border: `1px solid ${T.b2}`, background: T.l2,
        boxShadow: '0 6px 24px rgba(0,0,0,.24)', font: `11px/1.5 ${MONO}`, color: T.fg,
      },
      protoArrow: {
        font: `11px/1 ${MONO}`, padding: '4px 8px', cursor: 'pointer',
        borderRadius: PILL, border: `1px solid ${T.b1}`, background: T.base, color: T.fg,
      },
      protoSeg: { display: 'inline-flex', gap: 4, alignItems: 'center' },
      protoSegOn: { borderColor: T.b2, color: T.fg },
      protoLabel: { minWidth: 100, textAlign: 'center' },
      protoToggle: { display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: T.fg2 },
      protoState: { color: T.fg2, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' },
    }

    function WaitingChip(props) {
      const { kind, simulated, compact } = props
      const label = compact ? '等你' : (KIND_LABEL[kind] || '等待你处理')
      return h('span', { style: CSS.chip },
        h('span', { style: CSS.dot }),
        simulated === true ? `${label} · 模拟` : label)
    }

    /* ---------- simulated conversation ---------- */

    function ToolBlock(props) {
      return h('div', { style: CSS.tool },
        h('div', { style: CSS.toolHead }, `${props.name} · ${props.arg}`),
        h('div', { style: CSS.toolOut }, props.out))
    }

    function ApprovalCard(props) {
      const { task, kind, simulated } = props
      const [decision, setDecision] = useState(null)
      return h('div', { style: CSS.approval },
        h('div', { style: CSS.approvalHead },
          h('span', { style: CSS.dot }),
          simulated === true ? `${KIND_LABEL[kind] || '等待你处理'} · 模拟` : (KIND_LABEL[kind] || '等待你处理')),
        h('div', { style: CSS.approvalCmd }, decision === null ? task.approval.command : `${task.approval.command}（${decision}）`),
        h('div', { style: CSS.approvalDetail }, task.approval.detail),
        h('div', { style: CSS.rowWrap },
          decision === null
            ? [
                h('button', { key: 'once', style: CSS.button, onClick: () => setDecision('已允许一次') }, '允许一次'),
                h('button', { key: 'always', style: CSS.button, onClick: () => setDecision('已总是允许') }, '总是允许'),
                h('button', { key: 'deny', style: CSS.ghostBtn, onClick: () => setDecision('已拒绝') }, '拒绝'),
              ]
            : h('span', { style: CSS.chip }, decision)),
      )
    }

    function MockConversation(props) {
      const { task, waiting, waitingKind, simulatedWaiting } = props
      const [sent, setSent] = useState([])
      const [draft, setDraft] = useState('')
      const [focused, setFocused] = useState(false)
      const send = () => {
        const text = draft.trim()
        if (text === '') return
        setSent(messages => [...messages, text])
        setDraft('')
      }
      return h(React.Fragment, null,
        h('div', { style: CSS.transcript },
          h('div', { style: CSS.userMsg },
            h('div', { style: CSS.roleLine }, '你'),
            task.user),
          h('div', { style: CSS.sayMsg },
            h('div', { style: CSS.roleLine }, 'agent'),
            task.say),
          task.tools.map(tool => h(ToolBlock, { key: `${tool.name}${tool.arg}`, ...tool })),
          h('div', { style: CSS.sayMsg },
            h('div', { style: CSS.roleLine }, 'agent'),
            task.last),
          sent.map((text, index) => h('div', { key: `sent${index}`, style: CSS.userMsg },
            h('div', { style: CSS.roleLine }, '你'),
            text)),
          waiting !== undefined
            ? h(ApprovalCard, { task, kind: waitingKind, simulated: simulatedWaiting })
            : null,
        ),
        /* Mock-mode activation: ring the composer box itself, mirroring what the
           injected rule does for the shipped composer in real mode. */
        h('div', { style: focused ? { ...CSS.composer, ...CSS.composerFocused } : CSS.composer },
          h('textarea', {
            style: focused ? { ...CSS.textarea, ...CSS.textareaFocus } : CSS.textarea,
            value: draft,
            placeholder: `${props.title} 里继续说…`,
            'data-mixer-input': props.sessionId,
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
            onChange: event => setDraft(event.target.value),
          }),
          h('div', { style: CSS.composerRow },
            h('button', { style: CSS.ghostBtn, title: '原型占位：最终用 DSH 图标组件' }, '附件'),
            h('button', { style: CSS.ghostBtn, title: '原型占位：最终用 DSH 图标组件' }, '/ 指令'),
            h('span', { style: { flex: 1 } }),
            h('span', { style: CSS.chip }, '模型 · 默认'),
            h('button', {
              style: draft.trim() === '' ? { ...CSS.sendBtn, ...CSS.sendBtnOff } : CSS.sendBtn,
              disabled: draft.trim() === '',
              onClick: send,
              'data-mixer-send': props.sessionId,
            }, '发送'),
          ),
        ),
      )
    }

    /**
     * Local component for the `conversation.content` factory's `views` seam.
     *
     * The shipped default is `ConversationSessionView`, which renders the factory
     * child `conversation.session` (`ConversationContent.tsx`:
     * `useFactorySlot('views', ConversationSessionView)`). So the seam's
     * `renderSlot` is bound to the FACTORY's children: `conversation.session` is
     * renderable, `conversation.view` is NOT (that key belongs to
     * `conversation.session`'s own registration). The round-5 override called the
     * undeclared key, the call threw, the occurrence unmounted, and the pane lost
     * the transcript together with our diagnostic line. This mirrors the shipped
     * default instead.
     *
     * `pinnedView` is the plugin-side substitute for writing the conversation
     * store: the strict Session body resolves `view ?? active?.id`, so pinning the
     * view here switches tabs without touching another entry's store.
     */
    function makeViews(pinnedView) {
      return function PinnedViews(props) {
        return props.renderSlot('conversation.session', pinnedView === null ? {} : { view: pinnedView })
      }
    }

    /** The shipped default views component, used when we are not pinning anything. */
    function PassThroughViews(props) {
      return props.renderSlot('conversation.session', {})
    }

    /**
     * Real factory content, with a DOM probe.
     *
     * A blank pane has two very different causes and this line separates them:
     *   h / scroll / content - heights of the host, the scrollport inside the
     *     factory, and its scroll content; content > scroll means collapsed
     *   nodes - element count under the host; 0 means the factory rendered no
     *     elements at all, so it is not a layout problem
     *   'default' - no `views` override, shipped default component runs
     *   'passthrough' - our override renders `conversation.session`, as the default does
     */
    function RealConversation(props) {
      const { renderFactorySlot, mode, blank, running, viewsComponent } = props
      const [probe, setProbe] = useState(null)
      const hostRef = useRef(null)
      const input = { variant: 'embedded', phase: 'active', hero: false }
      const node = viewsComponent === undefined || viewsComponent === null
        ? renderFactorySlot('conversation.content', input)
        : renderFactorySlot('conversation.content', input, { slots: { views: viewsComponent } })
      useEffect(() => {
        const measure = () => {
          const host = hostRef.current
          if (host === null) return
          const scroll = host.querySelector('[data-conversation-scroll]')
          const style = scroll === null ? null : window.getComputedStyle(scroll)
          /* Turning the "where is the turn navigator" question into numbers.
             The rail is ChatView's own child: it renders only when its item list
             has at least two turns, and its height is the scrollport minus the
             composer (`--turn-rail-band`), both published on this scroller by the
             conversation content. `rail` counts candidate rail frames in the pane. */
          const band = style === null
            ? null
            : style.getPropertyValue('--dsh-conversation-viewport-height').trim()
          const composer = style === null ? null : style.getPropertyValue('--dsh-composer-height').trim()
          const railFrames = [...host.querySelectorAll('[class*="_frame"]')]
            .filter(element => element.querySelector('[data-index]') !== null).length
          const marks = host.querySelectorAll('[data-index]').length
          /* Deciding between the two ways the rail can be missing:
             - `turns` counts the distinct turns actually painted (every turn node
               carries data-chat-turn), so turns >= 2 with marks = 0 means the rail's
               item list is empty even though turns exist.
             - `tail` reports the reading state's own output attribute: ChatView omits
               data-chat-following-tail when it is NOT following the tail, and the
               reading state must have published at least once for the rail to render
               at all, so a missing attribute on an untouched pane points at
               "never initialized".
             - `railAny` counts rail frames regardless of marks, separating "no frame
               rendered" from "frame rendered with no marks". */
          const turnKeys = new Set()
          for (const element of host.querySelectorAll('[data-chat-turn]')) {
            turnKeys.add(element.getAttribute('data-chat-turn'))
          }
          const railAny = host.querySelectorAll('[class*="_frame"]').length
          const tail = host.querySelector('[data-chat-following-tail]') !== null
          setProbe({
            w: host.offsetWidth,
            h: host.offsetHeight,
            s: scroll === null ? -1 : scroll.offsetHeight,
            c: scroll === null ? -1 : scroll.scrollHeight,
            n: host.querySelectorAll('*').length,
            turns: turnKeys.size,
            railAny,
            tail,
            rail: railFrames,
            marks,
            band: band === '' ? 'unset' : band,
            composer: composer === '' ? 'unset' : composer,
          })
        }
        measure()
        const timers = [window.setTimeout(measure, 600), window.setTimeout(measure, 2000)]
        return () => { timers.forEach(id => window.clearTimeout(id)) }
      }, [])
      const probeText = probe === null
        ? '测量中'
        : `w=${probe.w} h=${probe.h} scroll=${probe.s}/${probe.c} nodes=${probe.n}`
          /* The rail is hidden below 900px of pane width by a HOST container query
             (ui-chat TurnNavigator.module.css: `@container (max-width: 900px) { .frame { display: none } }`),
             so width is part of the reading, not noise. */
          + ` · 轮次导航 rail=${probe.rail} 标记=${probe.marks} 轮次=${probe.turns} 宽=${probe.w}px（<${RAIL_MIN_PANE_W} 才隐藏） band=${probe.band}`
      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h('div', { style: CSS.diagLine, 'data-mixer-real-mode': mode },
          `${mode === 'pinned' ? '真实·标签' : '真实·默认'} · blank=${String(blank)} running=${String(running)} · ${probeText}`),
        node === null || node === undefined
          ? h('div', { style: CSS.diag }, '真实内容未产出：工厂返回了空。请把这行抄给 agent。')
          : h('div', { ref: hostRef, style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }, node),
      )
    }

    /* ---------- unified top bar ---------- */

    /**
     * Two-level dropdown: level 1 is the workspace list (switch / new session),
     * level 2 is that workspace's sessions with a checkbox per session, which is
     * also where a channel removed by its close button comes back.
     */
    function WorkspaceDropdown(props) {
      const { open, onOpen, workspaces, sessions, currentWorkspaceId, channels, onToggleChannel, onSwitch, onNewSession } = props
      const [expanded, setExpanded] = useState(currentWorkspaceId || null)
      useEffect(() => { if (open && expanded === null && workspaces.length > 0) setExpanded(workspaces[0].workspaceId) },
        [open, expanded, workspaces])
      if (!open) return null
      return h(React.Fragment, null,
        h('div', { style: CSS.backdrop, onClick: () => onOpen(false) }),
        h('div', { style: CSS.ddPanel, 'data-mixer-dropdown': '' },
          h('div', { style: { ...CSS.ddRow, cursor: 'default', color: T.fg2 } }, '工作区'),
          workspaces.length === 0
            ? h('div', { style: { ...CSS.ddRow, cursor: 'default', color: T.fg2 } }, '还没有工作区')
            : workspaces.map(workspace => {
                const isCurrent = workspace.workspaceId === currentWorkspaceId
                const isOpen = workspace.workspaceId === expanded
                return h('div', { key: workspace.workspaceId },
                  h('div', {
                    style: { ...CSS.ddRow, ...(isOpen ? CSS.ddRowOn : null) },
                    onClick: () => setExpanded(isOpen ? null : workspace.workspaceId),
                  },
                    h('span', { style: { fontWeight: isCurrent ? 600 : 400 } }, workspace.title),
                    isCurrent ? h('span', { style: CSS.chip }, '当前') : null,
                    h('span', { style: { flex: 1 } }),
                    h('span', { style: CSS.ddPath }, workspace.path),
                  ),
                  isOpen
                    ? h('div', { style: CSS.ddSub },
                        (workspace.sessionIds || []).map(sessionId => {
                          const summary = sessions[sessionId]
                          const checked = channels.includes(sessionId)
                          return h('label', { key: sessionId, style: CSS.ddSubRow },
                            h('input', {
                              type: 'checkbox',
                              checked,
                              onChange: () => onToggleChannel(sessionId),
                            }),
                            h('span', null, summary === undefined ? sessionId.slice(0, 8) : summary.displayTitle),
                          )
                        }),
                        (workspace.sessionIds || []).length === 0
                          ? h('div', { style: { ...CSS.ddSubRow, color: T.fg2, cursor: 'default' } }, '这个工作区还没有会话')
                          : null,
                        h('div', { style: { ...CSS.ddSubRow, gap: 6 } },
                          h('button', {
                            style: CSS.ghostBtn,
                            onClick: () => onSwitch(workspace.workspaceId),
                            disabled: isCurrent,
                          }, isCurrent ? '已在此工作区' : '切换到此工作区'),
                          h('button', {
                            style: CSS.ghostBtn,
                            onClick: () => onNewSession(workspace.workspaceId),
                          }, '在此新建会话'),
                        ),
                      )
                    : null,
                )
              }),
        ))
    }

    function TopBar(props) {
      const {
        variant, channels, hiddenWaiting, hiddenCount, summaries,
        attention, onFocus, focusId, backToConversation,
        workspaces, sessions, currentWorkspaceId, onToggleChannel, onSwitch, onNewSession,
      } = props
      const [dropdownOpen, setDropdownOpen] = useState(false)
      const waitingCount = channels.filter(id => attention[id] !== undefined).length
      const currentWorkspace = workspaces.find(w => w.workspaceId === currentWorkspaceId)
      /* No brand, plugin, schedule or settings entry here on purpose: the 56px
         rail keeps the brand mark, the panel icons and the settings gear
         (ui-sidebar/SidebarRoot + ui-settings-general/chrome), so repeating them
         would duplicate the same routes. The rail drops the workspace/session
         browsing region, which is exactly what this bar carries instead. */
      return h('div', { style: CSS.topbar },
        h('span', { style: CSS.topTitle }, '调音台'),
        h('span', { style: CSS.divider }),

        /* 2. workspace dropdown: switch workspace + new session */
        h('div', { style: CSS.ddWrap },
          h('button', {
            style: { ...CSS.navBtn, ...(dropdownOpen ? CSS.navBtnOn : null) },
            onClick: () => setDropdownOpen(!dropdownOpen),
            'data-mixer-workspace': '',
          }, `${currentWorkspace === undefined ? '工作区' : currentWorkspace.title} ▾`),
          h(WorkspaceDropdown, {
            open: dropdownOpen, onOpen: setDropdownOpen,
            workspaces, sessions, currentWorkspaceId, channels,
            onToggleChannel, onSwitch, onNewSession,
          })),

        h('span', { style: { flex: 1 } }),

        /* 4. attention summary for channels, including the ones closed away */
        variant === 'V3' && waitingCount > 0
          ? h(React.Fragment, null,
              h('span', { style: CSS.topQuietInline }, '需要你：'),
              channels.filter(id => attention[id] !== undefined).map(id => h('button', {
                key: id,
                style: { ...CSS.ghostBtn, ...(id === focusId ? { boxShadow: `inset 0 0 0 1px ${T.warn}` } : null) },
                onClick: () => onFocus(id),
              }, `${summaries[id] === undefined ? id.slice(0, 8) : summaries[id].displayTitle} · ${KIND_LABEL[attention[id].kind] || attention[id].kind}`)))
          : null,
        waitingCount > 0
          ? h('span', { style: CSS.chip }, h('span', { style: CSS.dot }), `${waitingCount} 个通道在等你`)
          : null,
        hiddenCount > 0
          ? h('button', {
              style: CSS.chip,
              title: '点一下把这些通道放回调音台',
              onClick: props.onRestoreHidden,
              'data-mixer-hidden': '',
            }, hiddenWaiting > 0
              ? `已移出 ${hiddenCount} 个，其中 ${hiddenWaiting} 个在等你`
              : `已移出 ${hiddenCount} 个`)
          : null,
        h('button', { style: CSS.button, onClick: backToConversation }, '常规视图'),
      )
    }

    /** Trajectory view stand-in, so the second tab is not a dead end. */
    function MockTrajectory(props) {
      const { task } = props
      return h('div', { style: CSS.transcript, 'data-mixer-trajectory': '' },
        h('div', { style: CSS.roleLine }, '轨迹（模拟）'),
        task.tools.slice().reverse().map((tool, index) => h('div', { key: `${tool.name}-${index}`, style: CSS.trajRow },
          h('span', { style: CSS.trajTurn }, `回合 ${task.tools.length - index}`),
          h('span', { style: CSS.toolHead }, `${tool.name} · ${tool.arg}`),
          h('span', { style: CSS.toolOut }, tool.out))),
        h('div', { style: CSS.diag },
          '真实的轨迹视图由 ui-chat 注册进 conversation.view，宿主一挂就有；这里只演示同一格内切换视图的样子。'),
      )
    }

    /** Ancestry chain for the breadcrumb, walking parentId up from a session. */
    function crumbsFor(summaries, sessionId) {
      const chain = []
      const seen = new Set()
      let cursor = sessionId
      while (cursor !== undefined && cursor !== null && !seen.has(cursor) && chain.length < 6) {
        seen.add(cursor)
        const summary = summaries[cursor]
        if (summary === undefined) {
          chain.push({ id: cursor, title: cursor.slice(0, 8) })
          break
        }
        chain.push({ id: cursor, title: summary.displayTitle })
        cursor = summary.parentId
      }
      return chain.reverse()
    }

    function Pane(props) {
      const {
        variant, sessionId, summary, summaries, waiting, waitingKind, simulatedWaiting,
        isFocus, index, contentMode, views, running, onClose, renderFactorySlot,
      } = props
      const isWaiting = waiting !== undefined
      const title = summary === undefined ? sessionId : summary.displayTitle
      const [mockTab, setMockTab] = useState('chat')
      /* null = follow the Session's own stored view. A string pins the view by
         re-rendering the strict body with it, which is the plugin-side substitute
         for writing another entry's conversation store. */
      const [pinnedView, setPinnedView] = useState(null)
      const [focused, setFocused] = useState(false)
      const viewsComponent = useMemo(() => makeViews(pinnedView), [pinnedView])
      const viewList = views !== undefined && views.length > 0
        ? views
        : [{ id: 'chat', label: '对话' }, { id: 'trajectory', label: '轨迹' }]
      const mock = contentMode === 'mock'
      const pinned = contentMode === 'real-pinned'
      const activeViewId = mock
        ? mockTab
        : (pinned && pinnedView !== null ? pinnedView : viewList[0].id)
      const task = MOCK_TASKS[index % MOCK_TASKS.length]
      const crumbs = crumbsFor(summaries === undefined ? {} : summaries, sessionId)
      /* V2 (the chosen variant) marks waiting with ONE thing: a warn stripe on the
         head row. No surface lift, no bold title, no chip, and specifically no
         stripe across the transcript. The wait type stays reachable as the head's
         tooltip, which costs no pixels. */
      const paneStyle = {
        ...CSS.pane,
        ...(variant === 'V3' && !isFocus ? CSS.dim : null),
      }
      const headStyle = isWaiting && variant === 'V2'
        ? { ...CSS.head, ...CSS.headWaitingV2 }
        : CSS.head
      const closeButton = h('button', {
        style: CSS.closeBtn,
        title: '从调音台移除（任务继续执行，仍在等你的话顶部条会提示）',
        'data-mixer-close': sessionId,
        onClick: () => onClose(sessionId),
      }, '×')

      return h('div', {
        style: paneStyle,
        'data-mixer-pane': sessionId,
        'data-mixer-waiting': isWaiting ? 'yes' : 'no',
        'data-mixer-focused': focused ? 'yes' : 'no',
      },
        h('div', {
          style: headStyle,
          'data-mixer-head': '',
          /* Reorder by dragging the head. The payload matches what the sidebar
             already puts on the wire for a session row (see Grid's drop handler),
             so one code path serves both this and a drop from the sidebar. */
          draggable: true,
          title: isWaiting
            ? `${KIND_LABEL[waitingKind] || '等待你处理'}（拖动可调整通道顺序）`
            : '拖动可调整通道顺序',
          onDragStart: (event) => {
            /* Never start a channel drag from the head's own controls. */
            const target = event.target
            if (target !== null && typeof target.closest === 'function' && target.closest('button') !== null) {
              event.preventDefault()
              return
            }
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', sessionId)
          },
        },
          /* Running first: the user asked for the spinner ahead of the breadcrumb.
             Same glyph as the sidebar's session rows (`StateDot state="ongoing"`). */
          running === true
            ? h('span', {
                style: CSS.runningWrap,
                'data-mixer-loading': 'yes',
                role: 'status',
                'aria-label': 'AI 正在执行',
                title: 'AI 正在执行',
              }, StateDot === null
                ? h('span', { style: CSS.runningFallback })
                : h(StateDot, { state: 'ongoing', size: 12 }))
            : null,
          h('nav', { style: CSS.crumbs, 'aria-label': '会话层级' },
            crumbs.map((crumb, crumbIndex) => h(React.Fragment, { key: crumb.id },
              crumbIndex > 0 ? h('span', { style: CSS.crumbSep }, '/') : null,
              h('span', {
                style: crumbIndex === crumbs.length - 1 ? CSS.crumbCurrent : CSS.crumb,
                'data-mixer-crumb': crumb.id,
                title: crumb.title,
              }, crumb.title),
            ))),
          /* V1 keeps its point + chip; V2 is stripe-only; V3 relies on the column. */
          isWaiting && variant === 'V1' ? h('span', { style: CSS.dot }) : null,
          isWaiting && variant === 'V1'
            ? h(WaitingChip, { kind: waitingKind, simulated: simulatedWaiting, compact: true })
            : null,
          h('span', { style: { flex: 1 } }),
          mock ? h('span', { style: CSS.chip }, '模拟内容') : null,
          closeButton,
        ),
        h('div', { style: CSS.viewTabs, 'data-mixer-view-tabs': '' },
          viewList.map(view => h('button', {
            key: view.id,
            style: view.id === activeViewId ? { ...CSS.viewTab, ...CSS.viewTabOn } : CSS.viewTab,
            'data-mixer-view': view.id,
            onClick: () => (mock ? setMockTab(view.id) : setPinnedView(view.id)),
          }, view.label))),
        /* Activation: focus anywhere inside this pane's content rings the pane, so
           the user can see which channel they are typing into. Scoped to the body
           on purpose, so clicking the tabs or the close button does not light it
           up. React focus events bubble, so the shipped composer inside real
           content (and the mock textarea) both trigger it. */
        h('div', {
          style: CSS.body,
          'data-mixer-body': '',
          onFocusCapture: () => setFocused(true),
          onBlurCapture: () => setFocused(false),
        },
          mock
            ? (mockTab === 'trajectory'
                ? h(MockTrajectory, { task })
                : h(MockConversation, {
                    task,
                    title,
                    sessionId,
                    waiting,
                    waitingKind,
                    simulatedWaiting,
                  }))
            : h(RealConversation, {
                renderFactorySlot,
                mode: pinned ? 'pinned' : 'default',
                viewsComponent: pinned ? viewsComponent : undefined,
                blank: summary === undefined ? undefined : summary.blank,
                running: summary === undefined ? undefined : summary.running,
              }),
        ),
      )
    }

    /** Relative channel widths. Absent means the default weight of 1. */
    const weightOf = (weights, id) => (weights !== undefined && weights[id] !== undefined ? weights[id] : 1)
    const totalWeight = (weights, ids) => ids.reduce((sum, id) => sum + weightOf(weights, id), 0)

    /**
     * One draggable divider. Adjusts only its two neighbouring channels, keeping
     * both at or above MIN_PANE_W; the track keeps its own horizontal scroll, so
     * the sum is free to exceed the viewport.
     */
    function Resizer(props) {
      const { before, after, ids, weights, trackRef, onResize } = props
      const [hovered, setHovered] = useState(false)
      const [dragging, setDragging] = useState(false)
      const drag = useRef(null)

      const onPointerDown = (event) => {
        const track = trackRef.current
        if (track === null) return
        drag.current = {
          startX: event.clientX,
          contentWidth: Math.max(1, track.scrollWidth),
          /* Snapshot the weight basis: the drag is proportional to it, so later
             re-renders cannot make the divider chase the pointer. */
          total: totalWeight(weights, ids),
          beforeWeight: weightOf(weights, before),
          afterWeight: weightOf(weights, after),
        }
        setDragging(true)
        event.currentTarget.setPointerCapture(event.pointerId)
        /* Keep the pointer from selecting transcript text while dragging. */
        document.body.style.userSelect = 'none'
        event.preventDefault()
      }

      const onPointerMove = (event) => {
        const state = drag.current
        if (state === null) return
        const floor = state.total * (MIN_PANE_W / state.contentWidth)
        let delta = ((event.clientX - state.startX) / state.contentWidth) * state.total
        delta = Math.min(delta, state.afterWeight - floor)
        delta = Math.max(delta, floor - state.beforeWeight)
        onResize(before, state.beforeWeight + delta, after, state.afterWeight - delta)
      }

      const endDrag = (event) => {
        if (drag.current === null) return
        drag.current = null
        setDragging(false)
        document.body.style.userSelect = ''
        if (event !== undefined && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }

      return h('div', {
        style: CSS.resizer,
        'data-mixer-resizer': `${before}|${after}`,
        role: 'separator',
        'aria-orientation': 'vertical',
        title: '拖动调整这两个通道的宽度',
        onPointerDown,
        onPointerMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        onPointerEnter: () => setHovered(true),
        onPointerLeave: () => setHovered(false),
      }, h('span', {
        style: hovered || dragging ? { ...CSS.resizerLine, ...CSS.resizerLineActive } : CSS.resizerLine,
      }))
    }

    function Grid(props) {
      const {
        variant, ids, summaries, attention, focusId, SessionProvider, refFor, contentMode,
        views, running, weights, onResize, onDropChannel, onClose, renderFactorySlot,
      } = props
      const trackRef = useRef(null)
      /* Insertion gap while a channel (or a sidebar session row) hovers the track. */
      const [dropIndex, setDropIndex] = useState(null)

      const indexForPointer = (clientX) => {
        const track = trackRef.current
        if (track === null) return ids.length
        const cells = [...track.querySelectorAll('[data-mixer-cell]')]
        for (let position = 0; position < cells.length; position += 1) {
          const rect = cells[position].getBoundingClientRect()
          if (clientX < rect.left + rect.width / 2) return position
        }
        return cells.length
      }

      const onDragOver = (event) => {
        /* Accept only the session-row payload the sidebar publishes. Reading the
           value is not allowed during dragover, so this checks the format name. */
        if (!event.dataTransfer.types.includes('text/plain')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropIndex(indexForPointer(event.clientX))
      }

      const onDrop = (event) => {
        event.preventDefault()
        const sessionId = event.dataTransfer.getData('text/plain')
        const index = indexForPointer(event.clientX)
        setDropIndex(null)
        /* A text selection drag would also arrive as text/plain: ignore anything
           that is not a Session this client knows. */
        if (sessionId === '' || summaries[sessionId] === undefined) return
        onDropChannel(sessionId, index)
      }

      const indicator = h('div', { style: CSS.dropIndicator, 'data-mixer-drop-indicator': '' })

      return h('div', {
        ref: trackRef,
        style: CSS.track,
        'data-mixer-track': '',
        onDragOver,
        onDrop,
        onDragLeave: (event) => {
          /* Ignore the leave events that fire while moving between our own cells. */
          if (event.currentTarget.contains(event.relatedTarget)) return
          setDropIndex(null)
        },
      },
        ids.map((id, index) => {
          /* V3's emphasis multiplies the focused channel's weight; V2 (the chosen
             variant) leaves widths to the user. */
          const emphasis = variant === 'V3' && id === focusId ? 2.2 : 1
          return h(React.Fragment, { key: id },
            dropIndex === index ? indicator : null,
            index === 0
              ? null
              : h(Resizer, {
                  before: ids[index - 1],
                  after: id,
                  ids,
                  weights,
                  trackRef,
                  onResize,
                }),
            h('div', {
              style: { ...CSS.trackCell, flex: `${weightOf(weights, id) * emphasis} 1 0` },
              'data-mixer-cell': id,
            },
              h(SessionProvider, { session: refFor(id) },
                h(Pane, {
                  variant,
                  sessionId: id,
                  index,
                  summary: summaries[id],
                  summaries,
                  waiting: attention[id],
                  waitingKind: attention[id] === undefined ? undefined : attention[id].kind,
                  simulatedWaiting: attention[id] === undefined ? undefined : attention[id].simulated,
                  isFocus: id === focusId,
                  contentMode,
                  views,
                  running: running === undefined ? undefined : running[id] === true,
                  onClose,
                  renderFactorySlot,
                }))),
          )
        }),
        dropIndex === ids.length ? indicator : null)
    }

    function ProtoBar(props) {
      const { variant, onVariant, forced, onForced, forcedRunning, onForcedRunning, contentMode, onContentMode, state } = props
      const cycle = useCallback((step) => {
        const index = VARIANTS.indexOf(variant)
        onVariant(VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length])
      }, [variant, onVariant])
      useEffect(() => {
        const onKey = (event) => {
          const el = document.activeElement
          const tag = el === null ? '' : el.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || (el !== null && el.isContentEditable)) return
          if (event.key === 'ArrowLeft') cycle(-1)
          else if (event.key === 'ArrowRight') cycle(1)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [cycle])
      return h('div', { style: CSS.protoBar, 'data-mixer-proto-bar': '' },
        h('span', { style: CSS.protoState }, '原型'),
        h('button', { style: CSS.protoArrow, onClick: () => cycle(-1), 'aria-label': '上一个变体' }, '←'),
        h('span', { style: CSS.protoLabel }, `${variant} (${VARIANTS.indexOf(variant) + 1}/${VARIANTS.length})`),
        h('button', { style: CSS.protoArrow, onClick: () => cycle(1), 'aria-label': '下一个变体' }, '→'),
        h('span', { style: CSS.protoSeg },
          [['mock', '模拟'], ['real-default', '真实·默认'], ['real-pinned', '真实·标签']].map(([id, label]) =>
            h('button', {
              key: id,
              style: contentMode === id ? { ...CSS.ghostBtn, ...CSS.protoSegOn } : CSS.ghostBtn,
              'data-mixer-content-mode': id,
              onClick: () => onContentMode(id),
            }, label))),
        h('label', { style: CSS.protoToggle },
          h('input', { type: 'checkbox', checked: forced, onChange: event => onForced(event.target.checked) }),
          '模拟等待态'),
        h('label', { style: CSS.protoToggle },
          h('input', {
            type: 'checkbox',
            checked: forcedRunning,
            'data-mixer-force-running': '',
            onChange: event => onForcedRunning(event.target.checked),
          }),
          '模拟执行中'),
        h('span', { style: CSS.protoState }, state),
      )
    }

    function MixerPanel(props) {
      const {
        useSessions, useSessionStatus, useWorkspaces, SessionProvider, renderFactorySlot, refFor,
        backToConversation, startSession, openWorkspace, collapseSidebar, restoreSidebar, listViews,
        storedChannels,
      } = props
      const [variant, setVariant] = useState('V2')
      const [forced, setForced] = useState(true)
      const [forcedRunning, setForcedRunning] = useState(true)
      const [contentMode, setContentMode] = useState('mock')
      const [focusId, setFocusId] = useState(null)
      /* null = never picked anything, so fall back to the first few Sessions.
         A stored selection (#9, user decision) wins over that default. */
      const [channels, setChannels] = useState(storedChannels === undefined ? null : storedChannels)
      const [hidden, setHidden] = useState([])
      /* Per-channel relative width, changed by dragging a divider. Session-keyed so
         it survives channels coming and going; unknown ids fall back to weight 1. */
      const [weights, setWeights] = useState({})

      const list = useSessions(state => state)
      const status = useSessionStatus(snapshot => snapshot)
      const workspaceState = useWorkspaces(state => state)
      const summaries = list && list.byId ? list.byId : {}
      const workspaces = workspaceState && workspaceState.items ? workspaceState.items : []
      /* Registered conversation views, read straight off the slot registry: the
         plugin can build the tab row even though the store that selects one is
         out of reach. */
      const views = typeof listViews === 'function' ? listViews() : []

      /* Hide the sidebar for the duration of the mixer view; the host cannot go
         below its 56px collapsed rail, so the rail stays. */
      useEffect(() => {
        collapseSidebar()
        return () => restoreSidebar()
      }, [collapseSidebar, restoreSidebar])

      /* Persist the selection once the user owns one (#9, user decision: remember
         it). The untouched default is never written, so first run stays clean. */
      const listIds = list && list.ids ? list.ids : []
      const listIdsKey = listIds.join(',')
      useEffect(() => {
        if (channels === null) return
        saveStoredChannels(channels)
      }, [channels])

      /* Auto-remove a channel whose Session was closed or archived on the left
         (#5, user decision). Two guards keep this from wiping the board: the Host
         list must be populated (never prune against a still-loading list), and an
         archived id always counts as gone. */
      const archivedIds = workspaceState && workspaceState.archivedSessionIds
        ? workspaceState.archivedSessionIds
        : []
      const archivedKey = archivedIds.join(',')
      useEffect(() => {
        if (channels === null) return
        if (listIds.length === 0) return
        const alive = channels.filter(id => listIds.includes(id) && !archivedIds.includes(id))
        if (alive.length !== channels.length) setChannels(alive)
      }, [channels, listIdsKey, archivedKey])

      /* Channels are ours (ticket #2 option c): default to the first three, then
         the dropdown and each pane's close button own the set. */
      const visible = channels !== null
        ? channels
        : (list && list.ids ? list.ids.slice(0, PANE_LIMIT) : [])
      const attention = {}
      const running = {}
      const observedRunning = {}
      ;[...visible, ...hidden].forEach(id => {
        /* Retain every channel we are tracking, including ones closed away from the
           layout: the waiting signal only exists for retained Sessions, so dropping
           the reference on close would silently stop the alerts. */
        refFor(id)
        const entry = status === undefined ? undefined : status.get(id)
        const real = entry === undefined ? undefined : entry.pendingInteraction
        if (real !== undefined) attention[id] = { kind: real.kind, simulated: false }
        else if (forced && id === visible[1]) attention[id] = { kind: 'approval', simulated: true }
        /* Executing/thinking: SessionStatus.running is the live observation, the
           Session summary is the Host fallback while the status source is silent. */
        const summary = summaries[id]
        observedRunning[id] = entry !== undefined && entry.running !== undefined
          ? entry.running === true
          : (summary === undefined ? false : summary.running === true)
      })
      /* Stage the indicator only when nothing is genuinely running, so the demo
         never contradicts the real state. */
      const anyObservedRunning = visible.some(id => observedRunning[id] === true)
      const stageRunning = forcedRunning && !anyObservedRunning && visible.length > 0
      ;[...visible, ...hidden].forEach(id => {
        running[id] = observedRunning[id] === true || (stageRunning && id === visible[0])
      })
      const visibleWaiting = visible.filter(id => attention[id] !== undefined)
      const hiddenWaiting = hidden.filter(id => attention[id] !== undefined).length
      const effectiveFocus = focusId !== null && visible.includes(focusId)
        ? focusId
        : (visibleWaiting.length > 0 ? visibleWaiting[0] : visible[0])
      const currentWorkspaceId = workspaces.length === 0
        ? undefined
        : (() => {
            const current = visible[0] === undefined ? undefined : summaries[visible[0]]
            const byPath = current === undefined ? undefined : workspaces.find(w => w.path === current.cwd)
            return byPath === undefined ? workspaces[0].workspaceId : byPath.workspaceId
          })()

      const toggleChannel = (sessionId) => {
        const current = channels === null ? visible : channels
        if (current.includes(sessionId)) {
          setChannels(current.filter(id => id !== sessionId))
          setHidden(hidden.filter(id => id !== sessionId))
          return
        }
        setChannels([...current, sessionId])
        setHidden(hidden.filter(id => id !== sessionId))
      }
      const closeChannel = (sessionId) => {
        setChannels(visible.filter(id => id !== sessionId))
        setHidden(hidden.includes(sessionId) ? hidden : [...hidden, sessionId])
      }
      const restoreHidden = () => {
        setChannels([...visible, ...hidden])
        setHidden([])
      }
      /**
       * One path for both drag gestures: a channel head dragged inside the track,
       * and a session row dragged in from the expanded sidebar (both publish the
       * SessionId as `text/plain`, see Grid's drop handler).
       * The dropped id is either already a channel (reorder) or new (insert).
       */
      const dropChannel = (sessionId, index) => {
        const current = channels === null ? visible : channels
        const from = current.indexOf(sessionId)
        const without = current.filter(id => id !== sessionId)
        /* `index` counts rendered cells, which still include the dragged one. */
        const target = Math.max(0, Math.min(from !== -1 && from < index ? index - 1 : index, without.length))
        setChannels([...without.slice(0, target), sessionId, ...without.slice(target)])
        /* Dropping a channel that was closed earlier brings it back. */
        setHidden(hidden.filter(id => id !== sessionId))
      }
      /* Dragging one divider only touches its two neighbours. */
      const resizeChannels = (beforeId, beforeWeight, afterId, afterWeight) => {
        setWeights({ ...weights, [beforeId]: beforeWeight, [afterId]: afterWeight })
      }

      return h('div', { style: CSS.root },
        /* Activation for the SHIPPED composer (real content), which we cannot give a
           class to. The host publishes stable hooks on its own markup, so a scoped
           rule reaches the input card itself:
             - `data-composer-card`  the input card (border-radius: --dsw-radius-panel)
             - `data-composer-seat`  the wider composer band that wraps it
           Ring the CARD, not the seat: the seat spans the whole composer band
           (input + toolbar + docks) with no radius, which reads as a big ugly box.
           Colour and width follow ui-theme's focus convention
           (focus.css: 2px of --dsw-alias-state-business-primary); offset 0 makes the
           ring hug the card's own rounded border. */
        h('style', { key: 'mixer-focus-ring' },
          '[data-mixer-pane] [data-composer-card]:focus-within{'
          + `outline:2px solid ${T.business};outline-offset:0}`),
        /* Turn navigator: the host hides the rail below 900px of container width.
           Re-show it from RAIL_MIN_PANE_W up, and only for our panes. The rail's
           frame is a direct child of its own `.slot` (both hashed with the same
           module prefix), so `[class*="_slot"] > [class*="_frame"]` selects exactly
           it: ChatView's own `.frame` has a different hash and no `_slot` parent.
           Our rule out-specifies the host's single-class rule, so it wins even
           though the host's declaration sits in a container query; below our
           threshold no rule applies and the host's hide stands. */
        h('style', { key: 'mixer-rail-breakpoint' },
          `@container (min-width:${RAIL_MIN_CONTAINER_W}px){`
          + '[data-mixer-pane] [class*="_slot"]>[class*="_frame"]{display:block}}'),
        h(TopBar, {
          variant,
          channels: visible,
          hiddenCount: hidden.length,
          hiddenWaiting,
          summaries,
          attention,
          focusId: effectiveFocus,
          onFocus: setFocusId,
          onRestoreHidden: restoreHidden,
          backToConversation,
          workspaces,
          sessions: summaries,
          currentWorkspaceId,
          onToggleChannel: toggleChannel,
          onSwitch: (workspaceId) => openWorkspace(workspaceId),
          onNewSession: (workspaceId) => startSession(workspaceId),
        }),
        visible.length === 0
          ? h('div', { style: CSS.empty },
              h('div', { style: CSS.emptyTitle }, '调音台里还没有通道'),
              h('div', { style: CSS.emptyBody },
                '用顶栏的工作区下拉勾选要关注的会话，只有勾中的会话会在这里列出。移除的会话不会停止，仍在等你的话顶栏会提示。'))
          : h(Grid, {
              variant, ids: visible, summaries, attention, focusId: effectiveFocus,
              SessionProvider, refFor, contentMode, views, running, weights,
              onResize: resizeChannels,
              onDropChannel: dropChannel,
              onClose: closeChannel, renderFactorySlot,
            }),
        PROTOTYPE
          ? h(ProtoBar, {
              variant, onVariant: setVariant,
              forced, onForced: setForced,
              forcedRunning, onForcedRunning: setForcedRunning,
              contentMode, onContentMode: setContentMode,
              state: `channels=${visible.length} hidden=${hidden.length} waiting=[${visibleWaiting.map(id => id.slice(0, 6)).join(' ')}] running=[${visible.filter(id => running[id]).map(id => id.slice(0, 6)).join(' ')}]`,
            })
          : null,
      )
    }

    function HeaderToggle(props) {
      return h('button', {
        style: CSS.button,
        title: '原型：打开调音台（多通道并排 + 统一顶栏）',
        'data-mixer-spike-toggle': '',
        onClick: props.openMixer,
      }, '调音台')
    }

    return {
      inject: ['slots', 'sessions', 'layout', 'uiWorkspace'],
      apply(ctx) {
        const refs = new Map()
        const refFor = (sessionId) => {
          let reference = refs.get(sessionId)
          if (reference === undefined) {
            reference = ctx.sessions.retain(sessionId, { source: SOURCE })
            reference.ready.catch((error) => {
              console.error('[mixer-proto] Session open failed', sessionId, error)
            })
            refs.set(sessionId, reference)
          }
          return reference
        }
        /* Closing a channel keeps its reference: the signal that it is waiting on
           you must survive leaving the layout, or the whole point is lost. The
           references also outlive the mixer view itself (user decision on #5:
           never release on leaving), so they are only dropped on plugin unload. */
        const releaseAll = () => {
          for (const reference of refs.values()) reference.release()
          refs.clear()
        }
        ctx.effect(() => () => releaseAll())

        /* Read the stored channel selection once, at plugin load, rather than on
           every render of the inject factory. */
        const storedChannels = loadStoredChannels()

        /* Prototype shortcut: read the frame's own collapsed marker instead of a
           layout API that does not expose it. A real build needs that API. */
        let collapsedByUs = false
        const isCollapsed = () => document.querySelector('[data-sidebar-collapsed]') !== null
        const collapseSidebar = () => {
          if (!isCollapsed()) { ctx.layout.toggleSidebar(); collapsedByUs = true }
        }
        const restoreSidebar = () => {
          if (collapsedByUs && isCollapsed()) ctx.layout.toggleSidebar()
          collapsedByUs = false
        }

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'mixer-spike-toggle',
          order: -20,
          label: '调音台',
          inject: () => ({ openMixer: () => ctx.layout.selectPanel(PANEL_ID) }),
        }, HeaderToggle))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          children: { 'mixer.channel': { kind: 'single', scope: 'session' } },
          inject: () => ({
            refFor,
            backToConversation: () => ctx.layout.selectPanel('conversation'),
            startSession: (workspaceId) => ctx.uiWorkspace.startSession(workspaceId),
            openWorkspace: (workspaceId) => ctx.uiWorkspace.openWorkspace(workspaceId),
            collapseSidebar,
            restoreSidebar,
            storedChannels,
            /* Read the registered conversation views for the tab row. Guarded
               because `entries` is not part of the catalogued service face, even
               though shipped plugins (ui-settings-general) call it. */
            listViews: () => {
              try {
                return ctx.slots.entries('conversation.view').map(entry => ({
                  id: entry.options.id,
                  label: typeof entry.options.label === 'function'
                    ? entry.options.label()
                    : (entry.options.label === undefined ? entry.options.id : entry.options.label),
                }))
              } catch (error) {
                console.error('[mixer-proto] conversation.view entries unavailable', error)
                return []
              }
            },
          }),
        }, MixerPanel))

        /* `/mixer`: a Client-owned slash command (ui-commands contract), so the
           view is reachable from any composer without touching the header.

           MUST go through `ctx.inject`, never `if (ctx.commandUi)`: in Cordis a
           read of a not-yet-provided service THROWS ("cannot get property
           \"commandUi\" without inject"), it does not return undefined. This
           plugin does not inject ui-commands, so on a cold boot `apply` runs
           before `commandUi` exists and that read failed the whole entry
           (web boot: dsh-mixer-spike: failed). `ctx.inject` waits for the
           service instead, and simply never fires when it never arrives. */
        ctx.inject(['commandUi'], (scope) => {
          scope.commandUi.register({
            name: 'mixer',
            label: () => '调音台视图',
            description: () => '把所有关注的会话并排放在一屏里',
            available: () => true,
            ui: { kind: 'action', run: () => ctx.layout.selectPanel(PANEL_ID) },
          })
        })
      },
    }
  },
})
