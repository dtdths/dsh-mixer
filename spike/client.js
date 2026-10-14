/**
 * THROWAWAY PROTOTYPE - wayfinder tickets #3 (UI) and #4 (feasibility). NOT production.
 *
 * Two questions, one artifact:
 *   #4  can several Conversation panes coexist, each with its own composer and a
 *       clickable approval card? (mechanism)
 *   #3  which structure routes attention to the channel that needs the user,
 *       without breaking focus on the one being worked on? (design)
 *
 * Plan (one line): keep the `main` keyed panel + header toggle, bind the first
 * three sessions through our own `mixerChannel` reference source, and render
 * three structurally different attention-routing variants into the shared
 * `conversation.content` factory, switchable from a floating prototype bar.
 *
 * Prototype rules apply: no polish, no tests, no persistence. Delete this
 * directory once both verdicts are recorded on their tickets.
 *
 * Design discipline (design-taste skill, applied to dense product UI):
 * - ONE accent: `--dsw-alias-state-warn-primary`, used only for the waiting state.
 * - Shape lock: surfaces square (0), interactive elements pills (999).
 * - Motion: near zero, `:active` feedback only.
 * - Host tokens only, so light and dark both work.
 * - No emoji, no new icon library, no decorative dots. The waiting dot carries
 *   real semantic state, the one exception the skill allows.
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

    const CSS = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: T.base, color: T.fg },
      topbar: {
        display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto',
        padding: '6px 12px', borderBottom: `1px solid ${T.b1}`, font: `12px/1.6 ${SANS}`,
      },
      topTitle: { fontWeight: 600 },
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
      body: { flex: 1, minHeight: 0, overflow: 'hidden' },
      empty: {
        flex: 1, display: 'flex', flexDirection: 'column', gap: 8,
        alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center', font: `13px/1.8 ${SANS}`,
      },
      emptyTitle: { fontWeight: 600 },
      emptyBody: { color: T.fg2, maxWidth: 380 },
      button: {
        font: `12px/1.4 ${SANS}`, padding: '3px 10px', cursor: 'pointer',
        borderRadius: PILL, color: T.fg, background: T.l2, border: `1px solid ${T.b1}`,
      },
      /* Prototype-only chrome: deliberately loud, so it cannot be mistaken for design. */
      protoBar: {
        position: 'fixed', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 2147483000,
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
        borderRadius: PILL, border: `1px solid ${T.b2}`, background: T.l2,
        boxShadow: '0 6px 24px rgba(0,0,0,.24)', font: `11px/1.5 ${MONO}`, color: T.fg,
      },
      protoArrow: {
        font: `11px/1 ${MONO}`, padding: '4px 8px', cursor: 'pointer',
        borderRadius: PILL, border: `1px solid ${T.b1}`, background: T.base, color: T.fg,
      },
      protoLabel: { minWidth: 138, textAlign: 'center' },
      protoToggle: { display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: T.fg2 },
      protoState: { color: T.fg2, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' },
    }

    /** Chat-only selection for an embedded occurrence (mirrors ui-subagent). */
    function FixedChatViews(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    function WaitingChip(props) {
      const { kind, simulated, compact } = props
      const label = compact ? '等你' : (KIND_LABEL[kind] || '等待你处理')
      return h('span', { style: CSS.chip },
        h('span', { style: CSS.dot }),
        simulated === true ? `${label}·模拟` : label)
    }

    /**
     * One channel. The pane body is identical across variants, so what differs is
     * only how the waiting state is routed to the user's attention.
     */
    function Pane(props) {
      const { variant, sessionId, summary, waiting, isFocus, renderFactorySlot } = props
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
            ? h(WaitingChip, { kind: waiting.kind, simulated: waiting.simulated, compact: true })
            : null,
          h('span', { style: { flex: 1 } }),
          summary !== undefined && summary.running ? h('span', { style: CSS.chip }, '运行中') : null,
        ),
        h('div', { style: CSS.body },
          renderFactorySlot(
            'conversation.content',
            { variant: 'embedded', phase: 'active', hero: false },
            { slots: { views: FixedChatViews } },
          )),
      )
    }

    function Grid(props) {
      const { variant, ids, summaries, attention, focusId, SessionProvider, refFor, renderFactorySlot } = props
      /* V3 promotes the channel that needs the user into the wide column. */
      const columns = ids.map(id => (variant === 'V3' && id === focusId ? '2.2fr' : '1fr')).join(' ')
      return h('div', { style: { ...CSS.grid, gridTemplateColumns: columns } },
        ids.map(id => h(SessionProvider, { key: id, session: refFor(id) },
          h(Pane, {
            variant,
            sessionId: id,
            summary: summaries[id],
            waiting: attention[id],
            isFocus: id === focusId,
            renderFactorySlot,
          }))))
    }

    function TopBar(props) {
      const { variant, ids, summaries, attention, focusId, onFocus, backToConversation } = props
      const waitingIds = ids.filter(id => attention[id] !== undefined)
      return h('div', { style: CSS.topbar },
        h('span', { style: CSS.topTitle }, '调音台'),
        h('span', { style: CSS.topQuiet }, `${ids.length} 通道`),
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
        h('span', { style: { flex: 1 } }),
        h('button', { style: CSS.button, onClick: backToConversation }, '常规视图'),
      )
    }

    function ProtoBar(props) {
      const { variant, onVariant, forced, onForced, state } = props
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
        h('button', { style: CSS.protoArrow, onClick: () => cycle(-1), 'aria-label': '上一个变体' }, '←'),
        h('span', { style: CSS.protoLabel }, `变体 ${variant} (${VARIANTS.indexOf(variant) + 1}/${VARIANTS.length})`),
        h('button', { style: CSS.protoArrow, onClick: () => cycle(1), 'aria-label': '下一个变体' }, '→'),
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
              variant, ids, summaries, attention,
              focusId: effectiveFocus, SessionProvider, refFor, renderFactorySlot,
            }),
        PROTOTYPE
          ? h(ProtoBar, {
              variant, onVariant: setVariant, forced, onForced: setForced,
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
