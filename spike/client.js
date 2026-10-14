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
    const { useState, useEffect, useCallback, useRef } = React

    const PANEL_ID = 'mixer'
    /** Our own Session reference source; never `mainView` (see docs/adr/0001). */
    const SOURCE = 'mixerChannel'
    const PANE_LIMIT = 3
    const PROTOTYPE = true
    const VARIANTS = ['V1', 'V2', 'V3']
    const VARIANT_NOTE = {
      V1: 'V1 点标：只在等待的通道标题前加一个圆点与「等你」胶囊',
      V2: 'V2 边缘强调（已选）：等待的通道左侧竖条 + 表面提亮 + 标题加重',
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
      grid: { display: 'grid', flex: 1, minHeight: 0, gap: 1, background: T.b1 },
      pane: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: T.base, overflow: 'hidden' },
      paneLifted: { background: T.l1 },
      dim: { opacity: 0.88 },
      head: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
        padding: '4px 10px', borderBottom: `1px solid ${T.b1}`, font: `11px/1.7 ${MONO}`,
        whiteSpace: 'nowrap', overflow: 'hidden',
      },
      headWaitingV2: { boxShadow: `inset 2px 0 0 0 ${T.warn}` },
      headTitle: { overflow: 'hidden', textOverflow: 'ellipsis' },
      headStrong: { fontWeight: 600 },
      closeBtn: {
        flex: '0 0 auto', width: 18, height: 18, lineHeight: '16px', textAlign: 'center',
        cursor: 'pointer', borderRadius: PILL, background: 'transparent',
        border: `1px solid ${T.b1}`, color: T.fg2, font: `11px/1 ${MONO}`, padding: 0,
      },
      body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      /* Mock-only chrome stand-in, so the pane layout can be judged while the
         shipped header stays unmountable (see docs/plugin-gotchas.md). */
      mockChrome: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
        padding: '5px 10px', borderBottom: `1px solid ${T.b1}`, font: `11.5px/1.7 ${SANS}`,
        whiteSpace: 'nowrap', overflow: 'hidden',
      },
      mockCrumb: { color: T.fg, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' },
      mockTabRow: {
        display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto',
        padding: '0 10px', borderBottom: `1px solid ${T.b1}`,
      },
      mockTab: {
        font: `11.5px/1.6 ${SANS}`, padding: '5px 9px', cursor: 'pointer', borderRadius: 0,
        color: T.fg2, background: 'transparent', border: 'none',
        borderBottom: '2px solid transparent',
      },
      mockTabOn: { color: T.fg, fontWeight: 600, borderBottom: `2px solid ${T.b2}` },
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
        h('div', { style: CSS.composer },
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
     * Consequence recorded on ticket #11: the view TAB ROW cannot be built here at
     * all. `useConversationViews` / the conversation store live on the
     * `conversation.session` slot props, which this seam does not receive.
     */
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
      const { renderFactorySlot, mode, blank, running } = props
      const [probe, setProbe] = useState(null)
      const hostRef = useRef(null)
      const input = { variant: 'embedded', phase: 'active', hero: false }
      const node = mode === 'passthrough'
        ? renderFactorySlot('conversation.content', input, { slots: { views: PassThroughViews } })
        : renderFactorySlot('conversation.content', input)
      useEffect(() => {
        const measure = () => {
          const host = hostRef.current
          if (host === null) return
          const scroll = host.querySelector('[data-conversation-scroll]')
          setProbe({
            h: host.offsetHeight,
            s: scroll === null ? -1 : scroll.offsetHeight,
            c: scroll === null ? -1 : scroll.scrollHeight,
            n: host.querySelectorAll('*').length,
          })
        }
        measure()
        const timers = [window.setTimeout(measure, 600), window.setTimeout(measure, 2000)]
        return () => { timers.forEach(id => window.clearTimeout(id)) }
      }, [])
      const probeText = probe === null
        ? '测量中'
        : `h=${probe.h} scroll=${probe.s}/${probe.c} nodes=${probe.n}`
      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h('div', { style: CSS.diagLine, 'data-mixer-real-mode': mode },
          `${mode === 'passthrough' ? '真实·直通' : '真实·默认'} · blank=${String(blank)} running=${String(running)} · ${probeText}`),
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

    function Pane(props) {
      const { variant, sessionId, summary, waiting, waitingKind, simulatedWaiting, isFocus, index, contentMode, onClose, renderFactorySlot } = props
      const isWaiting = waiting !== undefined
      const title = summary === undefined ? sessionId : summary.displayTitle
      const [mockTab, setMockTab] = useState('chat')
      const mock = contentMode === 'mock'
      const task = MOCK_TASKS[index % MOCK_TASKS.length]
      const paneStyle = {
        ...CSS.pane,
        ...(isWaiting && variant === 'V2' ? CSS.paneLifted : null),
        ...(variant === 'V3' && !isFocus ? CSS.dim : null),
      }
      const closeButton = h('button', {
        style: CSS.closeBtn,
        title: '从调音台移除（任务继续执行，仍在等你的话顶部条会提示）',
        'data-mixer-close': sessionId,
        onClick: () => onClose(sessionId),
      }, '×')

      /* Mock mode shows the full chrome the original view has, so the pane layout
         can be judged now. Items marked 原型占位 are the shipped controls that a
         plugin CANNOT mount here (their slots are declared by ui-conversation and
         a duplicate declaration throws); they are labelled so nobody mistakes a
         stand-in for the real control. */
      const head = mock
        ? h(React.Fragment, null,
            h('div', {
              style: { ...CSS.mockChrome, ...(isWaiting && variant === 'V2' ? CSS.headWaitingV2 : null) },
              'data-mixer-mock-chrome': '',
            },
              isWaiting && variant === 'V1' ? h('span', { style: CSS.dot }) : null,
              h('span', { style: { ...CSS.mockCrumb, ...(isWaiting && variant !== 'V3' ? CSS.headStrong : null) } }, title),
              h('span', { style: CSS.chip, title: '原型占位：原件由 ui-agent-preset 注册进 conversation.session.header.actions' }, '智能体团队 · UI'),
              h('span', { style: CSS.chip, title: '原型占位：原件由 ui-permission-presets 注册进 conversation.session.header.actions' }, '模式 · 标准'),
              h('span', { style: { flex: 1 } }),
              isWaiting && variant !== 'V3'
                ? h(WaitingChip, { kind: waitingKind, simulated: simulatedWaiting, compact: true })
                : null,
              h('span', { style: CSS.chip }, '模拟内容'),
              summary !== undefined && summary.running ? h('span', { style: CSS.chip }, '运行中') : null,
              h('button', { style: CSS.ghostBtn, title: '原型占位：原件由 ui-open-in-app 注册进 conversation.session.header.utilities' }, '用 xx 打开'),
              h('button', { style: CSS.ghostBtn, title: '原型占位：原件由 session-log-export 注册进 conversation.session.header.utilities' }, '下载日志'),
              closeButton,
            ),
            h('div', { style: CSS.mockTabRow, 'data-mixer-mock-tabs': '' },
              h('button', {
                style: mockTab === 'chat' ? { ...CSS.mockTab, ...CSS.mockTabOn } : CSS.mockTab,
                'data-mixer-view': 'chat',
                onClick: () => setMockTab('chat'),
              }, '对话'),
              h('button', {
                style: mockTab === 'trajectory' ? { ...CSS.mockTab, ...CSS.mockTabOn } : CSS.mockTab,
                'data-mixer-view': 'trajectory',
                onClick: () => setMockTab('trajectory'),
              }, '轨迹'),
            ))
        : h('div', { style: isWaiting && variant === 'V2' ? { ...CSS.head, ...CSS.headWaitingV2 } : CSS.head },
            isWaiting && variant === 'V1' ? h('span', { style: CSS.dot }) : null,
            h('span', { style: { ...CSS.headTitle, ...(isWaiting && variant !== 'V3' ? CSS.headStrong : null) } }, title),
            isWaiting && variant !== 'V3'
              ? h(WaitingChip, { kind: waitingKind, simulated: simulatedWaiting, compact: true })
              : null,
            h('span', { style: { flex: 1 } }),
            h('span', { style: CSS.chip, title: '真实模式：会话头由 ui-conversation 独占声明，插件无法在此挂载（见 docs/plugin-gotchas.md）' }, '精简头'),
            summary !== undefined && summary.running ? h('span', { style: CSS.chip }, '运行中') : null,
            closeButton,
          )

      return h('div', {
        style: paneStyle,
        'data-mixer-pane': sessionId,
        'data-mixer-waiting': isWaiting ? 'yes' : 'no',
      },
        head,
        h('div', { style: CSS.body },
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
                mode: contentMode === 'real-passthrough' ? 'passthrough' : 'default',
                blank: summary === undefined ? undefined : summary.blank,
                running: summary === undefined ? undefined : summary.running,
              }),
        ),
      )
    }

    function Grid(props) {
      const { variant, ids, summaries, attention, focusId, SessionProvider, refFor, contentMode, onClose, renderFactorySlot } = props
      const columns = ids.map(id => (variant === 'V3' && id === focusId ? '2.2fr' : '1fr')).join(' ')
      return h('div', { style: { ...CSS.grid, gridTemplateColumns: columns } },
        ids.map((id, index) => h(SessionProvider, { key: id, session: refFor(id) },
          h(Pane, {
            variant,
            sessionId: id,
            index,
            summary: summaries[id],
            waiting: attention[id],
            waitingKind: attention[id] === undefined ? undefined : attention[id].kind,
            simulatedWaiting: attention[id] === undefined ? undefined : attention[id].simulated,
            isFocus: id === focusId,
            contentMode,
            onClose,
            renderFactorySlot,
          }))))
    }

    function ProtoBar(props) {
      const { variant, onVariant, forced, onForced, contentMode, onContentMode, state } = props
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
          [['mock', '模拟'], ['real-default', '真实·默认'], ['real-passthrough', '真实·直通']].map(([id, label]) =>
            h('button', {
              key: id,
              style: contentMode === id ? { ...CSS.ghostBtn, ...CSS.protoSegOn } : CSS.ghostBtn,
              'data-mixer-content-mode': id,
              onClick: () => onContentMode(id),
            }, label))),
        h('label', { style: CSS.protoToggle },
          h('input', { type: 'checkbox', checked: forced, onChange: event => onForced(event.target.checked) }),
          '模拟等待态'),
        h('span', { style: CSS.protoState }, state),
      )
    }

    function MixerPanel(props) {
      const {
        useSessions, useSessionStatus, useWorkspaces, SessionProvider, renderFactorySlot, refFor,
        backToConversation, startSession, openWorkspace, collapseSidebar, restoreSidebar,
      } = props
      const [variant, setVariant] = useState('V2')
      const [forced, setForced] = useState(true)
      const [contentMode, setContentMode] = useState('mock')
      const [focusId, setFocusId] = useState(null)
      const [channels, setChannels] = useState(null)
      const [hidden, setHidden] = useState([])

      const list = useSessions(state => state)
      const status = useSessionStatus(snapshot => snapshot)
      const workspaceState = useWorkspaces(state => state)
      const summaries = list && list.byId ? list.byId : {}
      const workspaces = workspaceState && workspaceState.items ? workspaceState.items : []

      /* Hide the sidebar for the duration of the mixer view; the host cannot go
         below its 56px collapsed rail, so the rail stays. */
      useEffect(() => {
        collapseSidebar()
        return () => restoreSidebar()
      }, [collapseSidebar, restoreSidebar])

      /* Channels are ours (ticket #2 option c): default to the first three, then
         the dropdown and each pane's close button own the set. */
      const visible = channels !== null
        ? channels
        : (list && list.ids ? list.ids.slice(0, PANE_LIMIT) : [])
      const attention = {}
      ;[...visible, ...hidden].forEach(id => {
        /* Retain every channel we are tracking, including ones closed away from the
           layout: the waiting signal only exists for retained Sessions, so dropping
           the reference on close would silently stop the alerts. */
        refFor(id)
        const entry = status === undefined ? undefined : status.get(id)
        const real = entry === undefined ? undefined : entry.pendingInteraction
        if (real !== undefined) attention[id] = { kind: real.kind, simulated: false }
        else if (forced && id === visible[1]) attention[id] = { kind: 'approval', simulated: true }
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

      return h('div', { style: CSS.root },
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
              SessionProvider, refFor, contentMode, onClose: closeChannel, renderFactorySlot,
            }),
        PROTOTYPE
          ? h(ProtoBar, {
              variant, onVariant: setVariant,
              forced, onForced: setForced,
              contentMode, onContentMode: setContentMode,
              state: `channels=${visible.length} hidden=${hidden.length} waiting=[${visibleWaiting.map(id => id.slice(0, 6)).join(' ')}]`,
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
           you must survive leaving the layout, or the whole point is lost. */
        const releaseAll = () => {
          for (const reference of refs.values()) reference.release()
          refs.clear()
        }
        ctx.effect(() => () => releaseAll())

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
