/**
 * THROWAWAY PROTOTYPE - wayfinder tickets #3 (UI) and #4 (feasibility). NOT production.
 *
 * Two questions, one artifact:
 *   #4  can several Conversation panes coexist, each with its own composer? (mechanism)
 *   #3  which structure routes attention to the channel that needs the user,
 *       without breaking focus on the one being worked on? (design)
 *
 * Round 2 note: round 1 rendered the real `conversation.content` factory, which
 * produced EMPTY panes, so the variants could not be judged. This round fills
 * every pane with fully simulated content (transcript, tool calls, approval card,
 * working composer) and keeps a "real content" switch whose empty result is
 * reported on screen instead of silently rendering nothing.
 *
 * Prototype rules apply: no polish, no tests, no persistence (pane state is
 * in-memory and dies on variant switch unmount). Delete this directory once both
 * verdicts are recorded.
 *
 * Design discipline (design-taste skill, applied to dense product UI):
 * - ONE accent: `--dsw-alias-state-warn-primary`, used only for the waiting state.
 * - Shape lock: surfaces square (0), interactive elements pills (999). Focus uses
 *   the stronger border token, not a second accent colour.
 * - Motion: near zero, `:active` feedback only.
 * - Host tokens only, so light and dark both work.
 * - No emoji, no hand-rolled SVG icons. Text labels stand in for icons; the real
 *   design uses `@deepseek-ai/dsh-client-ui-primitives` components.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mixer-spike',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'mixer'
    /** Our own Session reference source; never `mainView` (see docs/adr/0001). */
    const SOURCE = 'mixerChannel'
    const PANE_LIMIT = 3
    const PROTOTYPE = true
    const VARIANTS = ['V1', 'V2', 'V3']
    const VARIANT_NOTE = {
      V1: 'V1 点标：只在等待的通道标题前加一个圆点与「等你」胶囊，其余不动',
      V2: 'V2 边缘强调：等待的通道左侧竖条 + 表面提亮 + 标题加重',
      V3: 'V3 主次分栏：等待的通道自动升为宽栏，顶部汇总可点击切换焦点',
    }

    /* Host alias tokens, verified against Theme.listTokens. */
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
    /* Shape lock: exactly two radii, nothing invented in between. */
    const SURFACE = 0
    const PILL = 999
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
    const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif'

    const KIND_LABEL = { approval: '等待审批', 'plan-review': '等待计划确认', question: '等待回答' }

    /* Simulated content, one task per channel, so the three panes read as three
       genuinely different conversations. Explicitly mock: labelled in the pane. */
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
        user: 'setters 页加一个「记住上次选的模型」开关。',
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
      topbar: {
        display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto', flexWrap: 'wrap',
        padding: '6px 12px', borderBottom: `1px solid ${T.b1}`, font: `12px/1.6 ${SANS}`,
      },
      topTitle: { fontWeight: 600 },
      topNote: { color: T.fg2, font: `11px/1.6 ${SANS}` },
      topQuiet: { color: T.fg2, font: `11px/1.6 ${MONO}` },
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
      dot: { width: 7, height: 7, borderRadius: PILL, background: T.warn, flex: '0 0 auto' },
      chip: {
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '1px 7px', borderRadius: PILL, background: T.l2,
        border: `1px solid ${T.b1}`, color: T.fg2, font: `10px/1.8 ${SANS}`,
      },
      body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
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
      ghostBtn: {
        font: `11px/1.5 ${SANS}`, padding: '2px 9px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg2, background: 'transparent', border: `1px solid ${T.b1}`,
      },
      button: {
        font: `12px/1.4 ${SANS}`, padding: '3px 10px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg, background: T.l2, border: `1px solid ${T.b1}`,
      },
      sendBtn: {
        font: `11px/1.5 ${SANS}`, padding: '3px 12px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg, background: T.l2, border: `1px solid ${T.b2}`,
      },
      sendBtnOff: { opacity: 0.5, cursor: 'default' },
      diag: {
        margin: 12, padding: '10px 12px', border: `1px solid ${T.b2}`, background: T.l1,
        font: `11.5px/1.7 ${SANS}`, color: T.fg,
      },
      empty: {
        flex: 1, display: 'flex', flexDirection: 'column', gap: 8,
        alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center', font: `13px/1.8 ${SANS}`,
      },
      emptyTitle: { fontWeight: 600 },
      emptyBody: { color: T.fg2, maxWidth: 380 },
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
      protoLabel: { minWidth: 118, textAlign: 'center' },
      protoToggle: { display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: T.fg2 },
      protoState: { color: T.fg2, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' },
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

    /** Real factory content; reports an empty render instead of showing nothing. */
    function RealConversation(props) {
      const node = props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: 'active', hero: false },
        { slots: { views: FixedChatViews } },
      )
      if (node === null || node === undefined) {
        return h('div', { style: CSS.diag },
          '真实内容未产出：conversation.content 工厂这次返回了空。这说明第 1 轮的空白不是样式问题，请把这条结果告诉 agent。')
      }
      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }, node)
    }

    /** Chat-only selection for an embedded occurrence (mirrors ui-subagent). */
    function FixedChatViews(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    function Pane(props) {
      const { variant, sessionId, summary, waiting, waitingKind, simulatedWaiting, isFocus, index, contentMode, renderFactorySlot } = props
      const isWaiting = waiting !== undefined
      const title = summary === undefined ? sessionId : summary.displayTitle
      const paneStyle = {
        ...CSS.pane,
        ...(isWaiting && variant === 'V2' ? CSS.paneLifted : null),
        ...(variant === 'V3' && !isFocus ? CSS.dim : null),
      }
      const headStyle = isWaiting && variant === 'V2' ? { ...CSS.head, ...CSS.headWaitingV2 } : CSS.head
      return h('div', {
        style: paneStyle,
        'data-mixer-pane': sessionId,
        'data-mixer-waiting': isWaiting ? 'yes' : 'no',
      },
        h('div', { style: headStyle },
          isWaiting && variant === 'V1' ? h('span', { style: CSS.dot }) : null,
          h('span', { style: { ...CSS.headTitle, ...(isWaiting && variant !== 'V3' ? CSS.headStrong : null) } }, title),
          isWaiting && variant !== 'V3'
            ? h(WaitingChip, { kind: waitingKind, simulated: simulatedWaiting, compact: true })
            : null,
          h('span', { style: { flex: 1 } }),
          contentMode === 'mock' ? h('span', { style: CSS.chip }, '模拟内容') : null,
          summary !== undefined && summary.running ? h('span', { style: CSS.chip }, '运行中') : null,
        ),
        h('div', { style: CSS.body },
          contentMode === 'mock'
            ? h(MockConversation, {
                task: MOCK_TASKS[index % MOCK_TASKS.length],
                title,
                sessionId,
                waiting,
                waitingKind,
                simulatedWaiting,
              })
            : h(RealConversation, { renderFactorySlot }),
        ),
      )
    }

    function Grid(props) {
      const { variant, ids, summaries, attention, focusId, SessionProvider, refFor, contentMode, renderFactorySlot } = props
      /* V3 promotes the channel that needs the user into the wide column. */
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
            renderFactorySlot,
          }))))
    }

    function TopBar(props) {
      const { variant, ids, summaries, attention, focusId, onFocus, backToConversation } = props
      const waitingIds = ids.filter(id => attention[id] !== undefined)
      return h('div', { style: CSS.topbar },
        h('span', { style: CSS.topTitle }, '调音台'),
        h('span', { style: CSS.topNote }, VARIANT_NOTE[variant]),
        h('span', { style: { flex: 1 } }),
        variant === 'V1' && waitingIds.length > 0
          ? h('span', { style: CSS.topQuiet }, `${waitingIds.length} 个通道在等你`)
          : null,
        variant === 'V3' && waitingIds.length > 0
          ? h(React.Fragment, null,
              h('span', { style: CSS.topQuiet }, '需要你：'),
              waitingIds.map(id => {
                const title = summaries[id] === undefined ? id.slice(0, 8) : summaries[id].displayTitle
                return h('button', {
                  key: id,
                  style: { ...CSS.button, ...(id === focusId ? { boxShadow: `inset 0 0 0 1px ${T.warn}` } : null) },
                  title: '把这个通道切到宽栏',
                  onClick: () => onFocus(id),
                }, `${title} · ${KIND_LABEL[attention[id].kind] || attention[id].kind}`)
              }))
          : null,
        h('span', { style: CSS.topQuiet }, `${ids.length} 通道`),
        h('button', { style: CSS.button, onClick: backToConversation }, '常规视图'),
      )
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
          h('button', {
            style: contentMode === 'mock' ? { ...CSS.ghostBtn, ...CSS.protoSegOn } : CSS.ghostBtn,
            onClick: () => onContentMode('mock'),
          }, '模拟内容'),
          h('button', {
            style: contentMode === 'real' ? { ...CSS.ghostBtn, ...CSS.protoSegOn } : CSS.ghostBtn,
            onClick: () => onContentMode('real'),
          }, '真实内容')),
        h('label', { style: CSS.protoToggle },
          h('input', { type: 'checkbox', checked: forced, onChange: event => onForced(event.target.checked) }),
          '模拟等待态'),
        h('span', { style: CSS.protoState }, state),
      )
    }

    function MixerPanel(props) {
      const { useSessions, useSessionStatus, SessionProvider, renderFactorySlot, refFor, backToConversation } = props
      const [variant, setVariant] = useState('V1')
      const [forced, setForced] = useState(true)
      const [contentMode, setContentMode] = useState('mock')
      const [focusId, setFocusId] = useState(null)
      const list = useSessions(state => state)
      const status = useSessionStatus(snapshot => snapshot)
      const ids = (list && list.ids ? list.ids : []).slice(0, PANE_LIMIT)
      const summaries = list && list.byId ? list.byId : {}

      /* Real signal is SessionStatus.pendingInteraction; the second channel can be
         forced so all three variants are judgeable without arranging a real wait. */
      const attention = {}
      ids.forEach((id, index) => {
        const entry = status === undefined ? undefined : status.get(id)
        const real = entry === undefined ? undefined : entry.pendingInteraction
        if (real !== undefined) attention[id] = { kind: real.kind, simulated: false }
        else if (forced && index === 1) attention[id] = { kind: 'approval', simulated: true }
      })
      const waitingIds = ids.filter(id => attention[id] !== undefined)
      const effectiveFocus = focusId !== null && ids.includes(focusId)
        ? focusId
        : (waitingIds.length > 0 ? waitingIds[0] : ids[0])

      return h('div', { style: CSS.root },
        h(TopBar, {
          variant, ids, summaries, attention,
          focusId: effectiveFocus, onFocus: setFocusId, backToConversation,
        }),
        ids.length === 0
          ? h('div', { style: CSS.empty },
              h('div', { style: CSS.emptyTitle }, '还没有会话可以上墙'),
              h('div', { style: CSS.emptyBody },
                '先在左侧打开或新建一个会话，再回到调音台。原型阶段固定取会话列表最前面的 3 个，最终会换成你自己勾选的那组。'))
          : h(Grid, {
              variant, ids, summaries, attention, focusId: effectiveFocus,
              SessionProvider, refFor, contentMode, renderFactorySlot,
            }),
        PROTOTYPE
          ? h(ProtoBar, {
              variant, onVariant: setVariant,
              forced, onForced: setForced,
              contentMode, onContentMode: setContentMode,
              state: `waiting=[${waitingIds.map(id => (attention[id].simulated ? 'sim:' : '') + id.slice(0, 6) + '/' + attention[id].kind).join(' ')}]`,
            })
          : null,
      )
    }

    function HeaderToggle(props) {
      return h('button', {
        style: CSS.button,
        title: '原型：打开调音台（多通道并排 + 等待态变体）',
        'data-mixer-spike-toggle': '',
        onClick: props.openMixer,
      }, '调音台')
    }

    return {
      inject: ['slots', 'sessions', 'layout'],
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
        const releaseAll = () => {
          for (const reference of refs.values()) reference.release()
          refs.clear()
        }
        ctx.effect(() => () => releaseAll())

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
          }),
        }, MixerPanel))
      },
    }
  },
})
