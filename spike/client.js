/**
 * THROWAWAY SPIKE — wayfinder ticket #4 (dsh-mixer). NOT production code.
 *
 * Question: can two Conversation panes coexist on one page, each with its own
 * working composer and a clickable approval card, driven by independent
 * SessionReferences?
 *
 * Plan (one line): register a `main` keyed panel (key `mixer`) plus a button in
 * the conversation header, bind the first two sessions of the session list
 * through our own `mixerChannel` reference source, and render the shared
 * `conversation.content` factory once per pane.
 *
 * Prototype rules apply: no polish, no tests, no persistence, state thrown away
 * on unmount. Delete this directory once the verdict is recorded on the ticket.
 *
 * Known rough edges, on purpose:
 * - `sessions.retain()` is called during render (guarded by a cache), which is a
 *   side effect in render. A real implementation mints references in a store.
 * - No release on session removal: references live until the plugin unloads.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mixer-spike',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'mixer'
    /** Our own Session reference source; never `mainView` (see docs/adr/0001). */
    const SOURCE = 'mixerChannel'
    const PANE_LIMIT = 2

    const T = {
      base: 'var(--dsw-alias-bg-base)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
    }
    const CSS = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, background: T.base },
      bar: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px',
        borderBottom: `1px solid ${T.border}`, color: T.label2,
        font: '12px/1.5 system-ui, -apple-system, sans-serif',
      },
      barTitle: { color: T.label, fontWeight: 600 },
      panes: { display: 'flex', flex: 1, minHeight: 0, gap: 1, background: T.border },
      pane: {
        display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 320, minHeight: 0,
        background: T.base, overflow: 'hidden',
      },
      paneHead: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
        borderBottom: `1px solid ${T.border}`, color: T.label2,
        font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'nowrap', overflow: 'hidden',
      },
      paneTitle: { color: T.label, overflow: 'hidden', textOverflow: 'ellipsis' },
      paneBody: { flex: 1, minHeight: 0, overflow: 'hidden' },
      badge: {
        flex: '0 0 auto', padding: '1px 6px', borderRadius: 999, background: T.layer2,
        color: T.label2, border: `1px solid ${T.border}`, font: '10px/1.7 system-ui, sans-serif',
      },
      note: { padding: 16, color: T.label2, font: '12px/1.7 system-ui, sans-serif' },
      button: {
        font: '11px/1.4 system-ui, sans-serif', padding: '3px 9px', cursor: 'pointer',
        color: T.label, background: T.layer2, border: `1px solid ${T.border}`, borderRadius: 6,
      },
    }

    /** Chat-only selection for an embedded occurrence (mirrors ui-subagent). */
    function FixedChatViews(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    function Pane(props) {
      const { sessionId, summary, renderFactorySlot } = props
      const retained = summary === undefined ? undefined : JSON.stringify(summary.retainedBy)
      return h('div', { style: CSS.pane, 'data-mixer-pane': sessionId },
        h('div', { style: CSS.paneHead },
          h('span', { style: CSS.paneTitle }, summary === undefined ? sessionId : summary.displayTitle),
          h('span', { style: CSS.badge }, sessionId.slice(0, 8)),
          summary !== undefined && summary.running ? h('span', { style: CSS.badge }, 'running') : null,
          retained === undefined ? null : h('span', { style: CSS.badge }, `retainedBy=${retained}`),
        ),
        h('div', { style: CSS.paneBody },
          renderFactorySlot(
            'conversation.content',
            { variant: 'embedded', phase: 'active', hero: false },
            { slots: { views: FixedChatViews } },
          )),
      )
    }

    function MixerPanel(props) {
      const { useSessions, SessionProvider, renderFactorySlot, refFor, backToConversation } = props
      const list = useSessions(state => state)
      const ids = (list && list.ids ? list.ids : []).slice(0, PANE_LIMIT)
      return h('div', { style: CSS.root },
        h('div', { style: CSS.bar },
          h('span', { style: CSS.barTitle }, '调音台 spike'),
          h('span', null, `绑定 ${ids.length} 格 / 会话总数 ${list && list.ids ? list.ids.length : 0}`),
          h('button', { style: CSS.button, onClick: backToConversation }, '常规视图'),
        ),
        ids.length === 0
          ? h('div', { style: CSS.note }, '当前没有会话：先在左侧开一个会话，再切回调音台。')
          : h('div', { style: CSS.panes }, ids.map(sessionId =>
              h(SessionProvider, { key: sessionId, session: refFor(sessionId) },
                h(Pane, {
                  sessionId,
                  summary: list.byId[sessionId],
                  renderFactorySlot,
                })))),
      )
    }

    function HeaderToggle(props) {
      return h('button', {
        style: CSS.button,
        title: 'THROWAWAY SPIKE：打开调音台（两格并排）',
        'data-mixer-spike-toggle': '',
        onClick: props.openMixer,
      }, '调音台')
    }

    return {
      inject: ['slots', 'sessions', 'layout'],
      apply(ctx) {
        /** A Session reference per session, owned by this spike plugin. */
        const refs = new Map()
        const refFor = (sessionId) => {
          let reference = refs.get(sessionId)
          if (reference === undefined) {
            reference = ctx.sessions.retain(sessionId, { source: SOURCE })
            reference.ready.catch((error) => {
              console.error('[mixer-spike] Session open failed', sessionId, error)
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
          // Declaring one session-scoped child is what hands this entry the
          // SessionProvider seat, exactly as the shipped conversation panel
          // declares `main.conversation` (see docs/research, finding 2).
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
