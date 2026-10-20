/**
 * dsh-mixer - Client half: the mixer view, N independent conversations side by
 * side, each with its own composer and transcript, and a header state marker for
 * the channels that are waiting on you or still running.
 *
 * Three mounting points, all registered from here:
 *   1. a keyed `main` panel (`mixer`). It declares a session-scoped child slot,
 *      because a pane cannot render Session content without one,
 *   2. a toggle button in the conversation header, left of "open in app",
 *   3. a Client-owned `/mixer` command (via `ctx.inject(['commandUi'])`).
 *
 * Session references use OUR OWN source (`mixerChannel`), never `mainView`:
 * reusing mainView would make the document title, the sidebar highlight and the
 * shortcuts resolve to an arbitrary mixer pane (docs/adr/0001). Every channel is
 * retained, including channels closed with the x, because the waiting signal only
 * exists for retained Sessions; references are released on plugin unload only.
 *
 * Creating a Session does NOT go through `ctx.uiWorkspace.startSession`: that path
 * reveals the new Session (`replaceMain(…, 'reveal')` → `selectPanel(null)`) and
 * throws the user out of the mixer. We create it ourselves and add a channel, and we
 * take the centre panel back when one of the HOST's own new-session entrances does
 * the reveal for us — under a narrow condition only (docs/adr/0003).
 *
 * Host limits this module lives with (evidence in docs/spec.md §7):
 *   - the sidebar cannot reach zero width, so entering the mixer collapses it to
 *     the 56px rail and the top bar carries what the rail loses,
 *   - nothing exposes the sidebar's collapsed state, so `createSidebar` probes the
 *     host frame's own marker (see the comment there, and spec §7.1),
 *   - the shipped conversation header slots are declared exclusively by
 *     ui-conversation, so panes carry a reduced header.
 *
 * Design discipline: ONE accent (`--dsw-alias-state-warn-primary`, waiting only),
 * surfaces square (0) / interactive elements pills (999), near-zero motion, host
 * tokens only, no emoji and no hand-rolled SVG.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mixer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef } = React

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
      console.error('[mixer] ui-primitives unavailable, state dot falls back', error)
    }

    /**
     * The board store machinery, guarded for the same reason as the dot above: a
     * module the table cannot resolve would throw inside the factory and fail the
     * whole entry. The fallback keeps the board usable for the page session (state in
     * memory, nothing persisted) instead of taking the page down with it.
     */
    let defineStore = null
    try {
      defineStore = require('@deepseek-ai/dsh-client-store').defineStore
    } catch (error) {
      console.error('[mixer] client store unavailable, the board will not persist', error)
    }

    /**
     * Stand-in with the same handle contract as `defineStore` (`create()` returning
     * snapshot/subscribe/actions), used only when the store module is missing.
     * @param spec - the same init/persist/actions literal `defineStore` takes.
     * @returns a compatible handle without persistence.
     */
    function createMemoryStore(spec) {
      const state = spec.init()
      const listeners = new Set()
      return {
        spec,
        create() {
          const actions = {}
          for (const [name, action] of Object.entries(spec.actions)) {
            actions[name] = (...params) => {
              action(state, ...params)
              for (const listener of [...listeners]) listener()
            }
          }
          return {
            getSnapshot: () => state,
            subscribe: (listener) => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
            actions,
            clearPersisted: () => {},
          }
        },
      }
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
     * pane requirement is therefore ~948px; ours is 560px, i.e. 512px of container
     * (user 2026-10-15: "这个值再小一点"; was 640/592).
     */
    const RAIL_MIN_PANE_W = 560
    const RAIL_MIN_CONTAINER_W = RAIL_MIN_PANE_W - 48
    /**
     * How many animation frames the caret hand-off waits for a pane's composer to
     * appear (spec §5.1③). ~0.5s at 60fps: long enough for the host factory to paint,
     * short enough that a never-rendering pane does not hold the intent forever.
     */
    const FOCUS_RETRY_FRAMES = 30
    /**
     * How many pixels ABOVE the host's own optical centre an empty channel's hero stack
     * sits (round 3, user feedback: 位置虽居中但整体观感偏下). Applied as
     * `margin-bottom`, NOT a transform: the host centres that stack with flex, so a
     * bottom margin moves it up by half its value and keeps its layout math intact —
     * whereas a transform would make the stack the containing block for the host's
     * position:fixed pickers (`ConversationRoot.module.css` says so explicitly).
     * Tunable: this single number is the whole adjustment.
     */
    const HERO_LIFT_PX = 48
    /**
     * How long the bar offers to undo an archive (spec §5.2). Mirrors the host's own
     * hold for the archived toast (`LONG_TOAST_HOLD_MS = 6000` in ui-workspace's
     * `RowActionToast`), so the sidebar and the mixer promise the same window.
     */
    const ARCHIVE_UNDO_MS = 6000
    /**
     * Persist key for the whole board (which Sessions are channels, plus their
     * relative widths), namespaced like ui-sidebar-right's `dsh.sidebar-right.v1`.
     *
     * The framework's persistence is a blind JSON round-trip: it rehydrates with a
     * plain `JSON.parse` and no shape check (`store/src/index.ts`, attachPersistence).
     * So `normalizeBoard` below owns "bad data falls back to defaults", and this
     * module never trusts the persisted value.
     */
    const PERSIST_KEY = 'dsh.mixer.v1'

    const T = {
      base: 'var(--dsw-alias-bg-base)',
      l1: 'var(--dsw-alias-bg-layer-1)',
      l2: 'var(--dsw-alias-bg-layer-2)',
      b1: 'var(--dsw-alias-border-l1)',
      b2: 'var(--dsw-alias-border-l2)',
      fg: 'var(--dsw-alias-label-primary)',
      fg2: 'var(--dsw-alias-label-secondary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      /* The host's own placeholder wash. NOT `bg-layer-1/2`: both are plain white in
         the light theme, so a skeleton painted with them is invisible (spec §5.3).
         The lines inside a placeholder block need one step more contrast; `border-l2` is
         the neutral alpha the host already ships for that (10% black / 12% white). */
      skeleton: 'var(--dsw-alias-bg-skeleton)',
      skeletonLine: 'var(--dsw-alias-border-l2)',
      /* The host's interactive hover wash (`bg-layer-1/2` are WHITE in the light theme,
         so a hover painted with them is invisible there). */
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      /* The surface a button needs when it sits ON a hovered row (see rowAction). */
      elevated: 'var(--dsw-alias-button-elevated-fill)',
      /* The host's focus colour (ui-theme focus.css falls back to this). */
      business: 'var(--dsw-alias-state-business-primary)',
    }
    const SURFACE = 0
    const PILL = 999
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
    const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif'

    /*
     * Wording for the states a channel shares with the sidebar's session row. v1
     * hardcodes the Simplified Chinese strings (locale service is deferred: spec §1),
     * so they are copied verbatim from the sidebar's own dictionary
     * (`ui-workspace/src/client/locales.ts`, keys `status.*`) rather than invented.
     * `tests/labels.test.mjs` parses that file and fails if any of these drifts.
     */
    const KIND_LABEL = { approval: '等待审批', 'plan-review': '计划待审', question: '等待回答' }
    /* Only these three kinds count as "visible waiting", the same whitelist the sidebar
       row applies (tree.ts:379-388); other domains register their own kinds and must
       not light our channels. */
    const VISIBLE_PENDING_KINDS = ['approval', 'plan-review', 'question']
    const STATE_LABEL = { running: '进行中', completed: '已完成', idle: '空闲' }
    const subagentsLabel = n => `${n} 个子智能体运行中`
    /**
     * One line of human-readable text for a create failure. The host reports its own
     * failures as `code: message` from the transport error; anything else (a thrown
     * value from another realm) is stringified rather than shown as `[object Object]`.
     */
    function errorText(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }
    /* Full parity with the sidebar row would mean a grey idle dot in EVERY header;
       the user looked at that and said drop it (2026-10-15). Idle is therefore the one
       documented deviation: the other four states stay identical to the sidebar, and
       an idle channel simply shows nothing. */
    const SHOW_IDLE_DOT = false

    /** One StateDot descriptor; `key` is also the state name used in tests. */
    function dot(key, state, size, label) {
      return { key, state, size, label }
    }

    /**
     * The pending kind this plugin is willing to show, mirroring the host's own
     * filter (`visiblePendingKind`, tree.ts:379-388). Other domains register their
     * own kinds into `SessionPendingInteractionMap`, and the sidebar row does not
     * surface those either.
     * @param entry - the Session's status, or undefined.
     * @returns one of the whitelisted kinds, or undefined.
     */
    function visiblePendingKind(entry) {
      const kind = entry === undefined || entry === null ? undefined : entry.pendingInteraction?.kind
      return kind !== undefined && VISIBLE_PENDING_KINDS.indexOf(kind) !== -1 ? kind : undefined
    }

    /**
     * Whether one subagent catalog row is running: the unified status first, the
     * list row's own flag as the fallback (mirrors `tree.ts:392`).
     * @param childId - the catalog row's Session identity.
     * @param status - the unified status map.
     * @param summaries - the list rows by id.
     * @returns whether that subagent is running.
     */
    function isSubagentRunning(childId, status, summaries) {
      const entry = status === undefined ? undefined : status.get(childId)
      if (entry !== undefined && entry.running !== undefined) return entry.running === true
      const summary = summaries[childId]
      return summary === undefined ? false : summary.running === true
    }

    /**
     * The board a drop produces, for both drag gestures (a channel head reordered
     * inside the track, or a Session row dragged in from the sidebar). Pure: Grid
     * owns the drag plumbing, this owns the index arithmetic.
     * @param current - the channel list the drop landed on.
     * @param sessionId - the dropped Session.
     * @param index - the rendered drop slot (still counting the dragged cell).
     * @returns the next channel list.
     */
    function moveChannel(current, sessionId, index) {
      const from = current.indexOf(sessionId)
      const without = current.filter(id => id !== sessionId)
      /* `index` counts rendered cells, which still include the dragged one. */
      const target = Math.max(0, Math.min(from !== -1 && from < index ? index - 1 : index, without.length))
      return [...without.slice(0, target), sessionId, ...without.slice(target)]
    }

    /* ------------------------------------------------------------------
       2026-10-15, second round of UI decisions (spec §4.1 / §4.4 / §5.1 / §5.2):
       an empty channel must land on the host's own hero phase, "new session" must
       not leave the mixer, and the top bar asks a workspace only to answer "where
       does a new Session land".
       ------------------------------------------------------------------ */

    /**
     * The `conversation.content` factory input that puts an empty channel on the
     * SAME phase the regular view uses. The host derives this itself from the
     * Session snapshot (`ConversationMainPanel.tsx:41-43`: a blank, already-open
     * Session is `hero`), and the composer's vertical centring is the host's CSS for
     * that phase (`ConversationRoot.module.css:534-538`). Pinning `phase: 'active'`
     * is what left the composer at the TOP of an empty pane, with dead space below
     * (spec §4.4, requirement 1).
     *
     * Boundary: the host also reads the snapshot's `openState` / `awaitingFirstTurn`;
     * a pane only has the list row, so `blank` is the whole judgement here. An
     * unknown row is deliberately NOT hero — a wrong hero flash on the first frame
     * is worse than the docked bar.
     * @param summary - the Session's list row, or undefined.
     * @returns the factory `phase`/`hero` input.
     */
    function heroFor(summary) {
      const blank = summary !== undefined && summary !== null && summary.blank === true
      return blank ? { phase: 'hero', hero: true } : { phase: 'active', hero: false }
    }

    /**
     * The blank Session that "new session" should REUSE instead of creating another
     * one, mirroring the host's own `reuseOrCreateBlank` (navigation.ts:185-198): a
     * blank Session inside the workspace the user clicked, still listed, not archived.
     * @param list - the Sessions list snapshot.
     * @param workspace - the target workspace item, or undefined.
     * @param archivedIds - the host's archived Session ids.
     * @returns the Session id to reuse, or undefined when a real create is needed.
     */
    function blankTargetFor(list, workspace, archivedIds) {
      if (workspace === undefined || workspace === null) return undefined
      const ids = list !== null && list !== undefined && Array.isArray(list.ids) ? list.ids : []
      const byId = list !== null && list !== undefined && list.byId !== undefined ? list.byId : {}
      const archived = Array.isArray(archivedIds) ? archivedIds : []
      const members = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      for (const id of ids) {
        const summary = byId[id]
        if (summary === undefined || summary.blank !== true) continue
        if (summary.cwd !== workspace.path) continue
        if (members.indexOf(id) === -1 || archived.indexOf(id) !== -1) continue
        return id
      }
      return undefined
    }

    /**
     * Whether the mixer should take the centre panel back.
     *
     * The HOST's own new-session entrances (the 56px rail's button, `session.new`)
     * cannot be intercepted: `startSession` → `openWorkspace` → `replaceMain(…,
     * 'reveal')` → `selectPanel(null)` (navigation.ts:433) unmounts the mixer. The
     * plugin re-asserts its panel instead — but only on the conjunction that reads as
     * "the mixer just went away AND the host revealed a Session with no history".
     *
     * Why "no history" and not "a new id": the host's `reuseOrCreateBlank`
     * (navigation.ts:185-198) happily REUSES a blank Session instead of creating one,
     * and a blank channel is exactly what the plugin's own ＋ leaves behind — so a
     * new-id test would miss the most common repeat press and throw the user out
     * anyway. Blankness is also what separates the create path from the other user of
     * the very same `replaceMain(…, 'reveal')`: clicking a sidebar Session row reveals
     * a Session that has history.
     *
     * Boundary this accepts: deliberately leaving the mixer by clicking the sidebar row
     * of a BLANK Session is indistinguishable and takes you back (ADR-0003).
     * @param input.leftMixer - the mixer was the active panel and went blank just now.
     * @param input.activePanelId - where the host says the centre panel is now.
     * @param input.revealed - `{ id, blank }` for the Session `mainView` now points at.
     * @returns whether to call `selectPanel('mixer')` again.
     */
    function shouldReclaimPanel(input) {
      const revealed = input.revealed
      if (input.leftMixer !== true || input.activePanelId !== null) return false
      if (revealed === undefined || revealed === null) return false
      if (revealed.blank !== true) return false
      return typeof revealed.id === 'string' && revealed.id !== ''
    }

    /**
     * The activity a Host archive refusal reported, or undefined when the failure was
     * something else. Mirror of ui-workspace's own `activeSessionRefusal`
     * (`index.ts:326`), including its reason for going by NAME: client plugin bundles do
     * not share error-class identity, so `instanceof` against the host's class would
     * never match.
     * @param reason - whatever the archive promise rejected with.
     * @returns `[]`/activities when the Host refused because work is running, else
     *   undefined (a plain failure).
     */
    function archiveActivityOf(reason) {
      if (!(reason instanceof Error) || reason.name !== 'WorkspaceArchiveError') return undefined
      const rpcError = reason.rpcError
      if (rpcError === undefined || rpcError === null || rpcError.code !== 'workspace/session-active') {
        return undefined
      }
      const details = rpcError.details
      if (details === undefined || details === null || details.activity === undefined) return []
      return Array.isArray(details.activity) ? details.activity : []
    }

    /**
     * The sidebar's row state for one Session, as one pure function: the whole
     * precedence lives here, so the pane header, the top-bar summary and the tests
     * cannot drift apart.
     *
     * Precedence and pairing mirror `ui-workspace/src/client/rows/Rows.tsx:347-397`
     * exactly: pending outranks running; a running-subagent dot is CO-displayed
     * beside pending or running rather than replacing them; then completed, then
     * idle.
     * @param input.pendingKind - sidebar-visible pending kind, or undefined.
     * @param input.running - live running flag, already falling back to the row's.
     * @param input.subagents - number of running subagent rows.
     * @param input.completed - the row's completionUnread.
     * @returns the state key plus its dot descriptors in render order.
     */
    function channelState(input) {
      const waiting = input.pendingKind !== undefined
      const dots = []
      if (waiting) {
        if (input.subagents > 0) dots.push(dot('subagents', 'ongoing', 10, subagentsLabel(input.subagents)))
      } else if (input.running === true) {
        dots.push(dot('running', 'ongoing', 12, STATE_LABEL.running))
        if (input.subagents > 0) dots.push(dot('subagents', 'ongoing', 10, subagentsLabel(input.subagents)))
      } else if (input.subagents > 0) {
        dots.push(dot('subagents', 'ongoing', 12, subagentsLabel(input.subagents)))
      } else if (input.completed === true) {
        dots.push(dot('completed', 'done', 12, STATE_LABEL.completed))
      } else if (SHOW_IDLE_DOT) {
        dots.push(dot('idle', 'idle', 12, STATE_LABEL.idle))
      }
      const key = dots.length > 0 ? dots.map(entry => entry.key).join('+') : (waiting ? 'waiting' : 'idle')
      return { key, dots }
    }

    /**
     * Count this Session's running subagent rows, mirroring the host's
     * `runningChildCount` (`tree.ts:390-395`). `isRunning` is passed in so the
     * caller supplies the live unified status first and the list row as the
     * fallback; this function stays a pure function of the catalog.
     * @param catalog - `projectionsBySession[id].values.subagentCatalog`.
     * @param isRunning - predicate deciding whether a catalog child is running.
     * @returns how many children are running.
     */
    function runningSubagentCount(catalog, isRunning) {
      if (!Array.isArray(catalog)) return 0
      let count = 0
      for (const child of catalog) if (isRunning(child) === true) count += 1
      return count
    }

    /**
     * Read the catalog the host's own row state is computed from (`tree.ts:411`
     * reads `projectionsBySession[id].values.subagentCatalog`). Absent projections
     * mean "no subagents", never a crash: the list snapshot fills in incrementally.
     * @param list - the Sessions list snapshot.
     * @param id - Session identity.
     * @returns the catalog array, empty when unknown.
     */
    function subagentCatalogOf(list, id) {
      const projections = list === null || list === undefined ? undefined : list.projectionsBySession
      const snapshot = projections === null || projections === undefined ? undefined : projections[id]
      const values = snapshot === undefined ? undefined : snapshot.values
      const catalog = values === undefined ? undefined : values.subagentCatalog
      return Array.isArray(catalog) ? catalog : []
    }

    /**
     * Coerce whatever the persisted store handed back into a usable board. A bad
     * field costs only that field: non-string or duplicate channels are dropped, a
     * non-finite or non-positive weight falls back to the default of 1 (by simply
     * staying out of the map), and an unusable value yields "nothing picked yet".
     *
     * Weights for Sessions that are not channels right now are KEPT: a channel
     * closed with the x must come back at the same proportions (spec §4.1). The
     * component prunes weights of Sessions that are really gone (archived, or no
     * longer listed by the host), which is what bounds the map.
     * @param raw - the persisted value, of unknown shape.
     * @returns channel ids (possibly empty) and per-Session weight overrides.
     */
    function normalizeBoard(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const channels = []
      if (Array.isArray(source.channels)) {
        for (const id of source.channels) {
          if (typeof id === 'string' && id !== '' && channels.indexOf(id) === -1) channels.push(id)
        }
      }
      const weights = {}
      const rawWeights = source.weights !== null && typeof source.weights === 'object' ? source.weights : {}
      for (const [id, value] of Object.entries(rawWeights)) {
        if (id === '' || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
        weights[id] = value
      }
      return { channels, weights }
    }

    /**
     * Declare the board store: which Sessions are channels, plus their relative
     * widths, as one persisted root-scope instance.
     *
     * Actions are the only write path (the component never sees the instance), and
     * `weights` stays a map keyed by Session so a channel can come and go without
     * losing its proportion.
     * @returns the store handle, created inside apply so a plugin reload cannot
     *   reuse a module-level singleton.
     */
    function createBoardStore() {
      const init = () => ({ channels: [], weights: {} })
      const actions = {
        setChannels: (draft, channels) => { draft.channels = channels },
        setWeights: (draft, weights) => { draft.weights = weights },
        /**
         * Drop the weights of Sessions that are really gone. `ids` comes from the
         * component (archived, or no longer listed by the host); a channel closed
         * with the x is never in it, so putting it back restores its proportions.
         */
        dropWeights: (draft, ids) => {
          for (const id of ids) delete draft.weights[id]
        },
      }
      if (defineStore === null) return createMemoryStore({ init, actions })
      return defineStore({ init, persist: PERSIST_KEY, actions })
    }

    const CSS = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 420, minWidth: 0, background: T.base, color: T.fg },
      /* Unified top bar: mixer label, the 会话 panel, waiting summary, view exit.
         Global entries deliberately absent, see the note in TopBar.
         Type scale (round 3, user feedback "字体较小，不够明显"): the bar reads at
         13px, its label at 13.5/600, chips at 11.5 — the same step up the pane header
         took earlier; do not drift back to the 10–12px band. */
      topbar: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', flexWrap: 'wrap',
        padding: '7px 12px', borderBottom: `1px solid ${T.b1}`, font: `13px/1.6 ${SANS}`,
        background: T.base,
      },
      topTitle: { fontWeight: 600, fontSize: 13.5 },
      divider: { width: 1, height: 18, background: T.b1, flex: '0 0 auto' },
      /* The 会话 trigger must READ as a button (round 3: "无按钮样式" it was
         transparent until opened). */
      navBtn: {
        font: `13px/1.4 ${SANS}`, padding: '4px 11px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg, background: T.l1, border: `1px solid ${T.b1}`, fontWeight: 600,
      },
      navBtnOn: { background: T.l2, border: `1px solid ${T.b2}` },
      button: {
        font: `13px/1.4 ${SANS}`, padding: '4px 11px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg, background: T.l2, border: `1px solid ${T.b1}`,
      },
      chip: {
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '2px 8px', borderRadius: PILL, background: T.l2,
        border: `1px solid ${T.b1}`, color: T.fg2, font: `11.5px/1.8 ${SANS}`,
      },
      /* An action inside a chip (the archive undo): text-only, so the chip stays one
         object instead of growing a second surface (spec §5.2). */
      chipButton: {
        flex: '0 0 auto', padding: 0, border: 'none', background: 'transparent',
        color: T.fg, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline',
        font: `11.5px/1.8 ${SANS}`,
      },
      dot: { width: 7, height: 7, borderRadius: PILL, background: T.warn, flex: '0 0 auto' },
      ddWrap: { position: 'relative' },
      /* The `会话` popover (spec §5.2, requirement 4): two COLUMNS, because the old
         two-LEVEL dropdown made the user pick a workspace before any Session was even
         visible, and buried "new session" one level down. Left column = the workspace
         jump list, each row carrying its own 「＋会话」; right column = the channel
         picker (2026-10-20: 「新建落点」 retired, every row IS the target). */
      backdrop: { position: 'fixed', inset: 0, zIndex: 39, background: 'transparent' },
      panel: {
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40,
        display: 'flex', background: T.base, border: `1px solid ${T.b2}`,
        boxShadow: '0 8px 28px rgba(0,0,0,.22)', maxHeight: '62vh',
      },
      panelColLeft: {
        width: 196, flex: '0 0 auto', borderRight: `1px solid ${T.b1}`, padding: 4, overflow: 'auto',
      },
      panelColRight: { width: 344, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 },
      panelHead: { padding: '5px 8px', color: T.fg2, font: `12px/1.6 ${SANS}` },
      panelGroup: { padding: '6px 8px 2px', color: T.fg2, font: `12px/1.6 ${SANS}` },
      panelRows: { flex: 1, minHeight: 0, overflow: 'auto', padding: 4 },
      panelEmpty: { padding: '4px 8px', color: T.fg2, font: `12.5px/1.6 ${SANS}` },
      panelFoot: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderTop: `1px solid ${T.b1}`,
      },
      panelHint: { color: T.fg2, font: `11.5px/1.6 ${SANS}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      /* A workspace row: click jumps the right column to that workspace, hovering
         reveals its own create action. The hover wash is the host's interactive token,
         so it is visible in BOTH themes (spec §5.2). */
      workspaceRow: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer',
        font: `13px/1.6 ${SANS}`, borderRadius: SURFACE,
      },
      workspaceRowHover: { background: T.hover },
      searchRow: { padding: '6px 8px', borderBottom: `1px solid ${T.b1}` },
      searchInput: {
        width: '100%', font: `13px/1.6 ${SANS}`, padding: '5px 8px', borderRadius: SURFACE,
        background: T.l1, color: T.fg, border: `1px solid ${T.b1}`, outline: 'none',
      },
      sessionRow: {
        display: 'flex', alignItems: 'center', gap: 7, padding: '4px 7px',
        font: `13px/1.6 ${SANS}`, borderRadius: SURFACE,
      },
      sessionRowOn: { background: T.hover },
      sessionPick: {
        display: 'flex', alignItems: 'center', gap: 7, flex: 1, minWidth: 0, cursor: 'pointer',
      },
      /* The hover-only row actions (归档 / ＋会话). They sit ON the row's hover wash, so
         they need a raised surface of their own: `bg-layer-1/2` are white in the light
         theme (identical to the panel) and sit one step BELOW the dark theme's wash, which
         is why the first version of these chips blended into the row background (user
         feedback 2026-10-20: 「按钮和背景一个颜色」). `button-elevated-fill` is the host's
         "button surface" colour — white in the light theme, a step ABOVE the wash in the
         dark one — and the stronger border plus the primary label make it read as a
         button, not as part of the row. */
      rowAction: {
        flex: '0 0 auto', font: `11.5px/1.5 ${SANS}`, fontWeight: 600, padding: '2px 8px',
        cursor: 'pointer', borderRadius: PILL, color: T.fg,
        background: T.elevated, border: `1px solid ${T.b2}`,
      },
      rowActionPrimary: { color: T.fg, background: T.elevated, border: `1px solid ${T.b2}`, fontWeight: 600 },
      rowActionPending: { color: T.fg2, cursor: 'default', opacity: 0.7 },
      rowConfirm: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 7px 6px',
        font: `11.5px/1.6 ${SANS}`, color: T.fg2,
      },
      rowWarnDot: { width: 7, height: 7, flex: '0 0 auto', borderRadius: PILL, background: T.warn },
      rowTag: {
        flex: '0 0 auto', padding: '1px 6px', borderRadius: PILL, background: T.l2,
        border: `1px solid ${T.b1}`, color: T.fg2, font: `11px/1.7 ${SANS}`,
      },
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
      /* 让位 (spec §5.3, requirement 3): the slot is as wide as the dragged pane, so
         the siblings really move aside instead of the line just sliding over them. The
         2px insertion line rides its leading edge. */
      dropSlot: { alignSelf: 'stretch', background: T.l1, boxShadow: `inset 2px 0 0 0 ${T.business}` },
      /* The dragged pane stays in flow as a quiet placeholder: the ghost over the
         pointer carries the live image. */
      dragSource: { opacity: 0.4 },
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
      crumb: { color: T.fg2, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 },
      crumbCurrent: {
        color: T.fg, fontWeight: 600, fontSize: 14, overflow: 'hidden',
        textOverflow: 'ellipsis', maxWidth: 280,
      },
      crumbSep: { color: T.fg2, opacity: 0.6, fontSize: 13 },
      /* Running indicator: the host's own StateDot, same as the sidebar rows.
         These two styles only cover the wrapper and the no-primitives fallback. */
      runningWrap: { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: '4px' },
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
        font: `13px/1.6 ${SANS}`, padding: '7px 12px', cursor: 'pointer', borderRadius: 0,
        color: T.fg2, background: 'transparent', border: 'none',
        borderBottom: '2px solid transparent',
      },
      viewTabOn: { color: T.fg, fontWeight: 600, borderBottom: `2px solid ${T.b2}` },
      empty: {
        flex: 1, display: 'flex', flexDirection: 'column', gap: 8,
        alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center', font: `13px/1.8 ${SANS}`,
      },
      emptyTitle: { fontWeight: 600 },
      emptyBody: { color: T.fg2, maxWidth: 420 },
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

    /**
     * One pane's conversation body, rendered through the host's shared factory.
     *
     * `viewsComponent` is passed only when the user pinned a view (see
     * `makeViews`); without it the shipped default component runs. A factory that
     * returns nothing means it contributed no node, which we surface as an empty
     * state rather than a silently blank pane.
     */
    function RealConversation(props) {
      const { renderFactorySlot, viewsComponent, hero } = props
      /* The host's own phase for this Session (spec §4.4, requirement 1). An empty
         channel must land on `hero`, because that phase's CSS is what centres the
         composer; pinning `active` here is what left it at the top of the pane. */
      const input = { variant: 'embedded', ...(hero === undefined ? heroFor(undefined) : hero) }
      const node = viewsComponent === undefined || viewsComponent === null
        ? renderFactorySlot('conversation.content', input)
        : renderFactorySlot('conversation.content', input, { slots: { views: viewsComponent } })
      return node === null || node === undefined
        ? h('div', { style: CSS.emptyBody }, '这个通道没有渲染出会话内容。')
        : node
    }

    /* ---------- unified top bar ---------- */

    /**
     * The `会话` popover (spec §5.2, requirement 4): two COLUMNS, because the old
     * two-LEVEL dropdown conflated two different jobs — navigation (where a new
     * Session goes) and channel-set ownership (which Sessions I follow) — and made
     * the user pick a workspace before a single Session was visible.
     *
     * Left column = the workspace jump list, and each row also carries that workspace's
     * 「＋会话」 on hover (2026-10-20: the bottom button and the 「新建落点」
     * selection it needed are gone — every row IS its own landing). Right column = the
     * channel picker, with a local title filter and the waiting / 已移出 state on every
     * row.
     */
    function SessionPanel(props) {
      const {
        onClose, workspaces, sessions, channels, parked, attention,
        onToggleChannel, onNewSession,
        archived, onArchive, onStopAndArchive, archiveConfirm, archivePending, onDismissArchive,
      } = props
      const [query, setQuery] = useState('')
      /* Which row the pointer is on: the archive action only appears on hover, and there
         is no stylesheet to do that with (spec §5.2). */
      const [hoverId, setHoverId] = useState(undefined)
      /* The left column's hovered workspace: its 「＋会话」 shows on hover only, the
         same reveal rule as the archive action on a Session row (spec §5.2). */
      const [hoverWorkspaceId, setHoverWorkspaceId] = useState(undefined)
      const needle = query.trim()
      /* The right column scrolls to the workspace clicked on the left (round 3: 左列同时
         当跳转表用) — the two columns are one control, not two. Nothing is selected: the
         row that was clicked already carries the create action (spec §5.2). */
      const rowsRef = useRef(null)
      const jumpToWorkspace = (workspaceId) => {
        const rows = rowsRef.current
        if (rows === null || typeof rows.querySelectorAll !== 'function') return
        const group = [...rows.querySelectorAll('[data-mixer-group]')]
          .find(node => node.getAttribute('data-mixer-group') === workspaceId)
        if (group !== undefined && typeof group.scrollIntoView === 'function') {
          group.scrollIntoView({ block: 'start' })
        }
      }
      /* Local title filtering on purpose: the host's full-content search is a
         different feature (request-local results, loading/error handling) and is
         recorded as phase 2 (spec §9.1). */
      const matches = sessionId => needle === ''
        || String((sessions[sessionId] === undefined ? '' : sessions[sessionId].displayTitle) ?? '').includes(needle)
      /* Archived Sessions are hidden, exactly like the sidebar hides them (round 4):
         they are not openable and must not be pickable as channels. */
      const usable = sessionId => archived.indexOf(sessionId) === -1 && matches(sessionId)

      return h(React.Fragment, null,
        h('div', { style: CSS.backdrop, onClick: onClose }),
        h('div', {
          style: CSS.panel,
          'data-mixer-session-panel': '',
          role: 'dialog',
          'aria-label': '会话与工作区',
        },
          h('div', { style: CSS.panelColLeft, 'data-mixer-workspace-column': '' },
            h('div', { style: CSS.panelHead }, '工作区'),
            workspaces.length === 0
              ? h('div', { style: CSS.panelEmpty }, '还没有工作区')
              : workspaces.map(workspace => {
                  const hovered = hoverWorkspaceId === workspace.workspaceId
                  return h('div', {
                    key: workspace.workspaceId,
                    style: { ...CSS.workspaceRow, ...(hovered ? CSS.workspaceRowHover : null) },
                    'data-mixer-workspace': workspace.workspaceId,
                    title: `跳到 ${workspace.title} 的会话`,
                    onMouseEnter: () => setHoverWorkspaceId(workspace.workspaceId),
                    onMouseLeave: () => setHoverWorkspaceId(current => (
                      current === workspace.workspaceId ? undefined : current
                    )),
                    onClick: () => jumpToWorkspace(workspace.workspaceId),
                  },
                    h('span', {
                      style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    }, workspace.title),
                    /* Its own click target, so pressing it cannot also fire the jump. */
                    hovered
                      ? h('button', {
                          type: 'button',
                          style: CSS.rowAction,
                          'data-mixer-new': workspace.workspaceId,
                          'data-mixer-row-action': '',
                          title: `在 ${workspace.title} 新建会话并放到第一位`,
                          onClick: (event) => {
                            event.stopPropagation()
                            onNewSession(workspace.workspaceId)
                          },
                        }, '＋会话')
                      : null,
                  )
                }),
          ),
          h('div', { style: CSS.panelColRight, 'data-mixer-session-column': '' },
            h('div', { style: CSS.searchRow },
              h('input', {
                style: CSS.searchInput,
                type: 'search',
                value: query,
                placeholder: '搜索会话标题…',
                'aria-label': '搜索会话标题',
                'data-mixer-search': '',
                onChange: event => setQuery(event.target.value),
              })),
            h('div', { style: CSS.panelRows, ref: rowsRef },
              workspaces.length === 0
                ? h('div', { style: CSS.panelEmpty }, '还没有工作区')
                : workspaces.map(workspace => {
                    const ids = (workspace.sessionIds || []).filter(usable)
                    return h('div', { key: workspace.workspaceId, 'data-mixer-group': workspace.workspaceId },
                      h('div', { style: CSS.panelGroup }, workspace.title),
                      ids.length === 0
                        ? h('div', { style: CSS.panelEmpty },
                            needle === '' ? '这个工作区还没有会话' : '没有匹配的会话')
                        : ids.map(sessionId => {
                            const summary = sessions[sessionId]
                            const checked = channels.indexOf(sessionId) !== -1
                            const isParked = parked.indexOf(sessionId) !== -1
                            const hovered = hoverId === sessionId
                            const confirming = archiveConfirm === sessionId
                            return h('div', { key: sessionId },
                              h('div', {
                                style: { ...CSS.sessionRow, ...(hovered ? CSS.sessionRowOn : null) },
                                'data-mixer-session': sessionId,
                                onMouseEnter: () => setHoverId(sessionId),
                                onMouseLeave: () => setHoverId(current => (current === sessionId ? undefined : current)),
                              },
                                /* The pick target is its own label, so the archive button
                                   beside it cannot toggle the checkbox by accident. */
                                h('label', { style: CSS.sessionPick, 'data-mixer-pick': sessionId },
                                  h('input', {
                                    type: 'checkbox',
                                    checked,
                                    onChange: () => onToggleChannel(sessionId),
                                  }),
                                  attention[sessionId] === undefined
                                    ? null
                                    : h('span', { style: CSS.rowWarnDot, title: '这个通道在等你' }),
                                  h('span', {
                                    style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                                  }, summary === undefined ? sessionId.slice(0, 8) : summary.displayTitle),
                                  isParked ? h('span', { style: CSS.rowTag }, '已移出') : null,
                                ),
                                hovered
                                  ? h('button', {
                                      type: 'button',
                                      style: archivePending === sessionId
                                        ? { ...CSS.rowAction, ...CSS.rowActionPending }
                                        : CSS.rowAction,
                                      'data-mixer-archive': sessionId,
                                      'data-mixer-row-action': '',
                                      disabled: archivePending === sessionId,
                                      title: '归档这个会话（与侧边栏的归档一致；正在执行的会话会先问一次）',
                                      onClick: () => onArchive(sessionId),
                                    }, archivePending === sessionId ? '归档中…' : '归档')
                                  : null,
                              ),
                              confirming
                                ? h('div', { style: CSS.rowConfirm, 'data-mixer-archive-confirm': sessionId },
                                    h('span', { style: { flex: 1 } }, '这个会话正在执行，归档会先停止它'),
                                    h('button', {
                                      style: { ...CSS.rowAction, ...CSS.rowActionPrimary },
                                      'data-mixer-archive-stop': sessionId,
                                      'data-mixer-row-action': '',
                                      onClick: () => onStopAndArchive(sessionId),
                                    }, '停止并归档'),
                                    h('button', {
                                      style: CSS.rowAction,
                                      'data-mixer-archive-cancel': sessionId,
                                      'data-mixer-row-action': '',
                                      onClick: onDismissArchive,
                                    }, '取消'),
                                  )
                                : null,
                            )
                          }),
                    )
                  })),
            h('div', { style: CSS.panelFoot },
              h('span', { style: CSS.panelHint }, needle === '' ? '勾选即加入通道' : `过滤：${needle}`),
              h('span', { style: { flex: 1 } }),
            ),
          ),
        ))
    }

    function TopBar(props) {
      const {
        channels, hiddenWaiting, hiddenCount, parked,
        attention, backToConversation,
        workspaces, sessions,
        onToggleChannel, onNewSession, onPanelOpened, notice,
        undoArchive, onUndoArchive,
        archived, onArchive, onStopAndArchive, archiveConfirm, archivePending, onDismissArchive,
      } = props
      const [panelOpen, setPanelOpen] = useState(false)
      const waitingCount = channels.filter(id => attention[id] !== undefined).length
      /* Esc closes the popover; the backdrop covers the pointer path. */
      useEffect(() => {
        if (!panelOpen) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => { if (event.key === 'Escape') setPanelOpen(false) }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [panelOpen])
      /* No brand, plugin, schedule or settings entry here on purpose: the 56px rail
         keeps the brand mark, the panel icons and the settings gear
         (ui-sidebar/SidebarRoot + ui-settings-general/chrome), so repeating them
         would duplicate the same routes. The rail drops the workspace/session
         browsing region, which is exactly what this bar carries instead — and, since
         2026-10-15, it also still carries its own new-session button, which is why
         the plugin reclaims its panel on that path (spec §5.1 / §7.2 / ADR-0003). */
      return h('div', { style: CSS.topbar, 'data-mixer-topbar': '' },
        h('span', { style: CSS.topTitle }, '调音台'),
        h('span', { style: CSS.divider }),

        /* The ONLY panel entry: a workspace name in the bar would claim a concept the
           mixer does not have (spec §5.2). */
        h('div', { style: CSS.ddWrap },
          h('button', {
            style: { ...CSS.navBtn, ...(panelOpen ? CSS.navBtnOn : null) },
            onClick: () => {
              const next = !panelOpen
              setPanelOpen(next)
              if (next && typeof onPanelOpened === 'function') onPanelOpened()
            },
            'data-mixer-sessions': '',
            'aria-expanded': panelOpen ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            title: '关注的会话、工作区跳转与新建会话',
          }, `会话${channels.length > 0 ? ` · ${channels.length}` : ''}`),
          panelOpen
            ? h(SessionPanel, {
                onClose: () => setPanelOpen(false),
                workspaces, sessions, channels, parked, attention,
                onToggleChannel,
                archived, onArchive, onStopAndArchive, archiveConfirm, archivePending, onDismissArchive,
                onNewSession: (workspaceId) => { setPanelOpen(false); onNewSession(workspaceId) },
              })
            : null),

        h('span', { style: { flex: 1 } }),

        /* Attention summary for channels, including the ones put away */
        waitingCount > 0
          ? h('span', { style: CSS.chip }, h('span', { style: CSS.dot }), `${waitingCount} 个通道在等你`)
          : null,
        notice === undefined
          ? null
          : h('span', {
              style: { ...CSS.chip, borderColor: T.warn, color: T.fg },
              title: '详情在控制台',
              'data-mixer-notice': '',
            }, notice),
        /* Archive is destructive and normally one-way; for ARCHIVE_UNDO_MS the bar carries
           the same offer the sidebar's archived toast does (spec §5.2, issue #12). */
        undoArchive === undefined
          ? null
          : h('span', {
              style: { ...CSS.chip, borderColor: T.b2, color: T.fg, maxWidth: 280 },
              title: `可以在 ${ARCHIVE_UNDO_MS / 1000} 秒内撤销这次归档`,
              'data-mixer-undo-archive': undoArchive.sessionId,
            },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                `已归档「${undoArchive.title}」`),
              h('button', {
                type: 'button',
                style: CSS.chipButton,
                'data-mixer-undo-archive-do': '',
                title: '撤销这次归档（与侧边栏归档提示里的「撤销」是同一个动作）',
                onClick: onUndoArchive,
              }, '撤销')),
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

    /**
     * Requirement 3: the drag image is a WHOLE channel, but it cannot be a snapshot
     * of the live pane.
     *
     * Blink builds that snapshot as the union of the dragged element and EVERY
     * descendant's layout box (`AbsoluteBoundingBoxRectIncludingDescendants`,
     * layout_object.cc:2369), then clamps it to 8192px (data_transfer.cc,
     * `DraggedNodeImageBuilder::CreateImage`). For a hero channel nothing
     * overflows, so the union is the cell itself and the ghost looks right — which
     * is why this only went wrong for channels that have a transcript: the scrolled
     * content inside the transcript's scroll container has layout boxes thousands of
     * pixels down, the union hits the clamp, and what the browser draws is no longer
     * a cell (reported in the browser 2026-10-20). `overflow: hidden` cannot fix
     * that: it clips paint, not layout boxes.
     *
     * So the picture is a stand-in of the same box, assembled from parts the browser
     * can snapshot inside the cell:
     *   - the two real header rows, cloned verbatim (React writes both as inline
     *     styles, so a clone renders identically),
     *   - the body: the LIVE body cloned when nothing in it is laid out outside the
     *     channel (so a hero channel keeps its logo and composer, and a short
     *     conversation keeps its messages), and a transcript skeleton when something
     *     is — that overflowing content is exactly what breaks the snapshot,
     *   - a hairline so it reads as a surface while it floats.
     * HTML5 still has no "snapshot only the visible part", so for a long channel the
     * ghost says "there is a transcript here" instead of showing it (spec §5.3).
     *
     * It has to be in the document (a detached element has no layout object, and the
     * snapshot then silently falls back to the default head image), but it is put
     * off-screen so it never paints.
     */
    function buildDragGhost(pane, head, rect) {
      const doc = pane.ownerDocument
      if (doc === null || doc === undefined || doc.body === null) return null
      if (!(rect.width > 0) || !(rect.height > 0)) return null
      /* A drag cancelled in some way that never reached us may have left one behind. */
      for (const stale of doc.body.querySelectorAll('[data-mixer-drag-ghost]')) stale.remove()
      const ghost = doc.createElement('div')
      Object.assign(ghost.style, {
        position: 'fixed',
        /* Rendered (the snapshot needs a layout object) but never painted. */
        left: '-10000px',
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: T.base,
        border: `1px solid ${T.b2}`,
        boxSizing: 'border-box',
        pointerEvents: 'none',
      })
      ghost.setAttribute('data-mixer-drag-ghost', '')
      ghost.appendChild(head.cloneNode(true))
      const tabs = pane.querySelector('[data-mixer-view-tabs]')
      if (tabs !== null) ghost.appendChild(tabs.cloneNode(true))
      const realBody = pane.querySelector('[data-mixer-body]')
      if (realBody !== null && bodyFitsCell(realBody)) {
        const clonedBody = realBody.cloneNode(true)
        clonedBody.removeAttribute('data-mixer-body')
        /* The host's width handles are hover-only chrome (and can sit a few px outside
           the body); the picture does not need them and they would make it wider than
           the channel. */
        for (const handle of clonedBody.querySelectorAll('[data-width-handle]')) handle.remove()
        ghost.appendChild(clonedBody)
      } else {
        ghost.appendChild(buildDragSkeleton(doc))
      }
      /* Strip the hooks the view and the tests navigate by, so the stand-in cannot be
         mistaken for a live pane during the one task it exists. */
      for (const node of ghost.querySelectorAll(
        '[data-mixer-head],[data-mixer-close],[data-mixer-view-tabs],[data-mixer-view]',
      )) {
        for (const name of ['data-mixer-head', 'data-mixer-close', 'data-mixer-view-tabs', 'data-mixer-view']) {
          node.removeAttribute(name)
        }
      }
      doc.body.appendChild(ghost)
      return ghost
    }

    /**
     * Would the browser's snapshot of this channel stay inside the channel?
     *
     * Blink unions the dragged element with EVERY descendant's layout box (see
     * buildDragGhost), so one descendant laid out outside the body is already too much —
     * that is the exact predicate for "the live body may be cloned into the ghost".
     * The walk bails on the first offender, which for a transcript that overflows below
     * the fold happens after a handful of visible messages.
     */
    function bodyFitsCell(body) {
      const rect = body.getBoundingClientRect()
      /* No box at all (nothing rendered / the read is impossible): do not clone. */
      if (!(rect.width > 0) || !(rect.height > 0)) return false
      /* A few px of overhang is chrome, not content: the host's width handles live
         slightly outside the body, and losing a couple of px is invisible. Hundreds of
         px (a transcript, a wide code block) is what makes the image stop being a cell,
         and thousands is what the browser clamps at. */
      const slack = 24
      for (const node of body.querySelectorAll('*')) {
        const box = node.getBoundingClientRect()
        /* display:none and empty wrappers have no box; they cannot stretch the image. */
        if (box.width <= 0 && box.height <= 0) continue
        if (box.right > rect.right + slack || box.bottom > rect.bottom + slack) return false
        if (box.left < rect.left - slack || box.top < rect.top - slack) return false
      }
      return true
    }

    /**
     * The stand-in body for a channel whose transcript cannot be snapshotted (see
     * buildDragGhost): LARGE content blocks that fill the height above a composer
     * silhouette, all in host tokens.
     *
     * The rules come from the browser feedback (2026-10-20, rounds 8-9):
     *   - it must FILL the body — a couple of thin lines at the top reads as a broken
     *     picture, not as "this channel has a transcript";
     *   - each block carries a few text lines, so the blocks read as message groups and
     *     not as blank cards;
     *   - the composer has to be at the bottom and be recognisable (an input line over a
     *     row of toolbar chips), because every channel in the mixer has one.
     * Painted with `--dsw-alias-bg-skeleton` / `--dsw-alias-border-l2`, the tokens the
     * host itself uses for placeholders: `bg-layer-1/2` are both WHITE in the light
     * theme, which is why the first version of this skeleton was invisible.
     * Static on purpose: a drag image is one frame, so a pulsing skeleton would promise
     * motion it will never have.
     */
    function buildDragSkeleton(doc) {
      const bar = (style) => {
        const node = doc.createElement('div')
        Object.assign(node.style, { borderRadius: `${PILL}px`, background: T.skeleton }, style)
        return node
      }
      const body = doc.createElement('div')
      Object.assign(body.style, {
        flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column',
        gap: '12px', padding: '16px 18px', overflow: 'hidden', background: T.base,
      })
      body.setAttribute('data-mixer-drag-skeleton', '')
      /* Big blocks, sized like message groups: with a zero basis they share whatever
         height the channel has, and `space-between` spreads their text lines over the
         whole block, so a taller channel gets airier blocks instead of a hole. */
      for (const [grow, width, edge, lines] of [
        [3, '100%', 'stretch', [92, 78, 96, 64, 88, 72, 82, 54, 90, 66, 94, 58]],
        [2.2, '86%', 'flex-end', [88, 62, 90, 74, 48, 80, 56, 68]],
        [1.6, '64%', 'flex-start', [72, 46, 84, 58, 70, 50]],
      ]) {
        const area = doc.createElement('div')
        area.setAttribute('data-mixer-drag-block', '')
        Object.assign(area.style, {
          flex: `${grow} 1 0`, width, alignSelf: edge, minHeight: 0,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '8px',
          padding: '16px', borderRadius: 'var(--dsw-radius-panel)',
          /* border-box matters: the widths below are percentages of the body. */
          boxSizing: 'border-box',
          background: T.skeleton, overflow: 'hidden',
        })
        for (const lineWidth of lines) {
          area.appendChild(bar({ flex: '0 0 12px', width: `${lineWidth}%`, background: T.skeletonLine }))
        }
        body.appendChild(area)
      }
      /* The composer's silhouette, sized like the real one: an input line over a toolbar
         row (model seat + icon chips), the two pushed apart by space-between. */
      const composer = doc.createElement('div')
      composer.setAttribute('data-mixer-drag-composer', '')
      Object.assign(composer.style, {
        flex: '0 0 auto', minHeight: '104px', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        gap: '14px', padding: '16px', border: `1px solid ${T.b2}`,
        borderRadius: 'var(--dsw-radius-panel)', background: T.base,
      })
      composer.appendChild(bar({ flex: '0 0 12px', width: '58%' }))
      const toolbar = doc.createElement('div')
      Object.assign(toolbar.style, { display: 'flex', alignItems: 'center', gap: '8px' })
      for (const chipWidth of [54, 32, 32, 22]) {
        toolbar.appendChild(bar({ width: `${chipWidth}px`, height: '12px' }))
      }
      composer.appendChild(toolbar)
      body.appendChild(composer)
      return body
    }

    function Pane(props) {
      const {
        sessionId, summary, summaries, waitingKind, views, state,
        onClose, onDragStateChange, renderFactorySlot,
      } = props
      const isWaiting = waitingKind !== undefined
      /* Empty channels render in the host's own hero phase (requirement 1). */
      const hero = heroFor(summary)
      /* null = follow the Session's own stored view. A string pins the view by
         re-rendering the strict body with it, which is the plugin-side substitute
         for writing another entry's conversation store. */
      const [pinnedView, setPinnedView] = useState(null)
      const [focused, setFocused] = useState(false)
      const viewsComponent = useMemo(() => makeViews(pinnedView), [pinnedView])
      const viewList = views !== undefined && views.length > 0
        ? views
        : [{ id: 'chat', label: '对话' }, { id: 'trajectory', label: '轨迹' }]
      const activeViewId = pinnedView === null ? viewList[0].id : pinnedView
      const crumbs = crumbsFor(summaries === undefined ? {} : summaries, sessionId)
      /* Waiting is marked with ONE thing: a warn stripe on the head row. No surface
         lift, no bold title, no chip, and specifically no stripe across the
         transcript. The wait type stays reachable as the head's tooltip, which costs
         no pixels. */
      const headStyle = isWaiting ? { ...CSS.head, ...CSS.headWaitingV2 } : CSS.head
      const closeButton = h('button', {
        style: CSS.closeBtn,
        title: '从调音台移除（任务继续执行，仍在等你的话顶部条会提示）',
        'data-mixer-close': sessionId,
        onClick: () => onClose(sessionId),
      }, '×')
      const dots = state.dots
      const stateLabel = dots.map(entry => entry.label).join(' · ')

      return h('div', {
        style: CSS.pane,
        'data-mixer-pane': sessionId,
        'data-mixer-waiting': isWaiting ? 'yes' : 'no',
        'data-mixer-focused': focused ? 'yes' : 'no',
        'data-mixer-state': state.key,
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
            /* Requirement 3: the browser's default drag image is the element carrying
               `draggable` — this head row — so hand it a whole-channel picture instead.
               It cannot be the live pane (see buildDragGhost); the snapshot is taken
               once, right here, and HTML5 has no live drag image, which is why "跟手"
               would mean giving up this API (spec §5.3). */
            const pane = typeof event.currentTarget.closest === 'function'
              ? event.currentTarget.closest('[data-mixer-pane]')
              : null
            if (pane !== null && typeof event.dataTransfer.setDragImage === 'function') {
              const rect = pane.getBoundingClientRect()
              const offsetX = Number.isFinite(event.clientX) ? event.clientX - rect.left : 0
              const offsetY = Number.isFinite(event.clientY) ? event.clientY - rect.top : 0
              const ghost = buildDragGhost(pane, event.currentTarget, rect)
              event.dataTransfer.setDragImage(ghost === null ? pane : ghost, offsetX, offsetY)
              if (ghost !== null) {
                /* Blink takes the snapshot synchronously after this handler returns
                   (DragController::StartDrag), so the stand-in can go on the next task. */
                setTimeout(() => { if (ghost.isConnected) ghost.remove() }, 0)
              }
            }
            onDragStateChange(sessionId)
          },
          /* Cancelled drags (dropped outside, Esc) never reach the track's drop
             handler, so the placeholder and the insertion slot are cleared here too. */
          onDragEnd: () => onDragStateChange(undefined),
        },
          /* The sidebar's own state dots (see channelState). The wait stripe stays
             the waiting mark, so a waiting channel shows no primary dot, only a
             subagent one if any. */
          dots.length > 0
            ? h('span', {
                style: CSS.runningWrap,
                'data-mixer-loading': state.key.indexOf('running') !== -1 || state.key.indexOf('subagents') !== -1 ? 'yes' : 'no',
                role: 'status',
                'aria-label': stateLabel,
                title: stateLabel,
              }, dots.map(entry => StateDot === null
                ? h('span', { key: entry.key, style: CSS.runningFallback })
                : h(StateDot, { key: entry.key, state: entry.state, size: entry.size })))
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
          h('span', { style: { flex: 1 } }),
          closeButton,
        ),
        h('div', { style: CSS.viewTabs, 'data-mixer-view-tabs': '' },
          viewList.map(view => h('button', {
            key: view.id,
            style: view.id === activeViewId ? { ...CSS.viewTab, ...CSS.viewTabOn } : CSS.viewTab,
            'data-mixer-view': view.id,
            onClick: () => setPinnedView(view.id),
          }, view.label))),
        /* Activation: focus anywhere inside this pane's content rings the input card,
           so the user can see which channel they are typing into. Scoped to the body
           on purpose, so clicking the tabs or the close button does not light it up.
           React focus events bubble, so the shipped composer inside the factory
           content triggers it. */
        h('div', {
          style: CSS.body,
          'data-mixer-body': '',
          onFocusCapture: () => setFocused(true),
          onBlurCapture: () => setFocused(false),
        },
          h(RealConversation, {
            renderFactorySlot,
            hero,
            viewsComponent: pinnedView === null ? undefined : viewsComponent,
          }),
        ),
      )
    }

    /** Relative channel widths. Absent means the default weight of 1. */
    const weightOf = (weights, id) => (weights !== undefined && weights[id] !== undefined ? weights[id] : 1)
    const totalWeight = (weights, ids) => ids.reduce((sum, id) => sum + weightOf(weights, id), 0)

    /**
     * The weight pair a divider drag produces, clamped so neither neighbour drops
     * below MIN_PANE_W. Pure: the Resizer owns pointer capture and cleanup, this
     * owns the arithmetic (and is what the tests pin down).
     * @param drag - the snapshot taken at pointerdown.
     * @param clientX - current pointer x.
     * @returns the two new weights, before-side first.
     */
    function resizedWeights(drag, clientX) {
      const floor = drag.total * (MIN_PANE_W / drag.contentWidth)
      let delta = ((clientX - drag.startX) / drag.contentWidth) * drag.total
      delta = Math.min(delta, drag.afterWeight - floor)
      delta = Math.max(delta, floor - drag.beforeWeight)
      return { beforeWeight: drag.beforeWeight + delta, afterWeight: drag.afterWeight - delta }
    }

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
        const next = resizedWeights(state, event.clientX)
        onResize(before, next.beforeWeight, after, next.afterWeight)
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
        ids, summaries, attention, states, SessionProvider, refFor,
        views, weights, onResize, onDropChannel, onClose, renderFactorySlot,
      } = props
      const trackRef = useRef(null)
      /* Insertion slot while a channel (or a sidebar session row) hovers the track. */
      const [dropIndex, setDropIndex] = useState(null)
      /* The channel being dragged by its head, together with the geometry captured
         when the drag started. Measuring live would feed the insertion slot back into
         the pointer math and make the slot jump between neighbours; the snapshot also
         supplies the slot's width (the dragged pane's own, per spec §5.3). */
      const [drag, setDrag] = useState(undefined)

      const indexForPointer = (clientX) => {
        const snapshot = drag === undefined ? undefined : drag.rects
        if (snapshot !== undefined) {
          let index = 0
          for (const id of ids) {
            const rect = snapshot[id]
            if (rect === undefined) continue
            if (clientX < rect.left + rect.width / 2) return index
            index += 1
          }
          return ids.length
        }
        const track = trackRef.current
        if (track === null) return ids.length
        const cells = [...track.querySelectorAll('[data-mixer-cell]')]
        for (let position = 0; position < cells.length; position += 1) {
          const rect = cells[position].getBoundingClientRect()
          if (clientX < rect.left + rect.width / 2) return position
        }
        return cells.length
      }

      /* Drag bookkeeping lives here, not in the pane: the track owns the order, the
         pointer math and the placeholder, and a sidebar drag never calls this. */
      const beginDrag = (sessionId) => {
        const track = trackRef.current
        const rects = {}
        let width = 0
        if (track !== null) {
          for (const cell of track.querySelectorAll('[data-mixer-cell]')) {
            const id = cell.getAttribute('data-mixer-cell')
            const rect = cell.getBoundingClientRect()
            rects[id] = { left: rect.left, width: rect.width }
            if (id === sessionId) width = rect.width
          }
        }
        setDrag({ id: sessionId, width, rects })
      }
      const endDrag = () => { setDrag(undefined); setDropIndex(null) }

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
        endDrag()
        /* A text selection drag would also arrive as text/plain: ignore anything
           that is not a Session this client knows. */
        if (sessionId === '' || summaries[sessionId] === undefined) return
        onDropChannel(sessionId, index)
      }

      /* The insertion slot: as wide as the dragged pane (plus the 5px grab band it
         gives up) so the siblings really make room; a sidebar drag has no pane of ours
         to measure, so it keeps the plain 2px indication (spec §5.3). */
      const slotWidth = drag === undefined ? 0 : Math.max(0, drag.width) + 5
      const indicator = h('div', {
        style: slotWidth > 0 ? { ...CSS.dropSlot, flex: `0 0 ${slotWidth}px` } : CSS.dropIndicator,
        'data-mixer-drop-indicator': '',
        'data-mixer-drop-slot': slotWidth > 0 ? 'yes' : 'no',
      })

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
        ids.map((id, index) => h(React.Fragment, { key: id },
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
            style: {
              ...CSS.trackCell,
              flex: `${weightOf(weights, id)} 1 0`,
              ...(drag !== undefined && drag.id === id ? CSS.dragSource : null),
            },
            'data-mixer-cell': id,
            'data-mixer-dragging': drag !== undefined && drag.id === id ? 'yes' : 'no',
          },
            h(SessionProvider, { session: refFor(id) },
              h(Pane, {
                sessionId: id,
                summary: summaries[id],
                summaries,
                waitingKind: attention[id] === undefined ? undefined : attention[id].kind,
                views,
                state: states[id] === undefined ? channelState({}) : states[id],
                onClose,
                onDragStateChange: (draggingId) => (draggingId === undefined ? endDrag() : beginDrag(draggingId)),
                renderFactorySlot,
              }))),
        )),
        dropIndex === ids.length ? indicator : null)
    }

    /**
     * The mixer view. The board (channels plus widths) is the persisted store's
     * state: reads go through `useStore`, writes through the declared actions, and
     * every read is normalized, so a corrupt persisted value cannot break the view.
     */
    function MixerPanel(props) {
      const {
        useSessions, useSessionStatus, useWorkspaces, SessionProvider, renderFactorySlot, refFor,
        backToConversation, createSession, archiveSession, unarchiveSession,
        listViews, sidebar, useStore, actions,
        parkedIds, park, unpark, unparkAll, createdSessions, restoredSessions,
        mixerRuntime, takePendingFirst,
      } = props
      /* Channels put away with the x live in the PLUGIN scope: not in the persisted
         board ("put away for now" is about this sitting, not a preference) and not in
         component state either, because the panel is remounted whenever the mixer
         takes its centre panel back (ADR-0003). */
      const parked = parkedIds()
      /* The Session whose composer must own the caret once it is on screen. Explicit,
         because the host's InputBar auto-focuses every pane and the last mount wins
         (spec §5.1, requirement 2). */
      const [focusId, setFocusId] = useState(undefined)
      /* The last thing the bar must tell the user (a failed create, a failed archive).
         A failed action must not look like a no-op: the host reports its own through the
         notify service, so ours reports through the bar it already owns. */
      const [notice, setNotice] = useState(undefined)
      /* The pending "this Session is running, stop it and archive?" offer. */
      const [archiveConfirm, setArchiveConfirm] = useState(undefined)
      /* The row whose archive call is in flight, so the action shows 归档中… instead of
         looking like a click that did nothing. */
      const [archivePending, setArchivePending] = useState(undefined)
      /* The archive the bar is currently offering to undo (spec §5.2, issue #12). */
      const [undoArchive, setUndoArchive] = useState(undefined)
      /* "Insert this Session first" is handed over by the apply-scope reclaim watcher:
         the panel those channels belonged to has just been unmounted. */
      const pendingRef = useRef(null)
      if (pendingRef.current === null) pendingRef.current = takePendingFirst() ?? false
      const board = normalizeBoard(useStore(state => state))
      const channels = board.channels
      const weights = board.weights
      /* The latest channel list, for callbacks that resolve a frame later (a create
         promise, the reclaim handover). A closure over `channels` would write back a
         stale order and silently drop anything the user toggled in between. */
      const channelsRef = useRef(channels)
      channelsRef.current = channels
      const weightsRef = useRef(weights)
      weightsRef.current = weights
      /* Channels are ours (spec §4.1): until the user owns a board we show the first
         few Sessions, then the dropdown and the per-pane close button own the set. */
      const list = useSessions(state => state)
      const status = useSessionStatus(snapshot => snapshot)
      const workspaceState = useWorkspaces(state => state)
      const summaries = list && list.byId ? list.byId : {}
      const workspaces = workspaceState && workspaceState.items ? workspaceState.items : []
      const listIds = list && list.ids ? list.ids : []
      const listIdsKey = listIds.join(',')
      const channelsKey = channels.join(',')
      /* Registered conversation views, read straight off the slot registry: the
         plugin can build the tab row even though the store that selects one is out
         of reach. */
      const views = typeof listViews === 'function' ? listViews() : []

      /* Hide the sidebar for the duration of the mixer view. The host cannot go
         below its 56px collapsed rail, so the rail stays (spec §7.1). */
      useEffect(() => {
        sidebar.collapse()
        return () => sidebar.restore()
      }, [sidebar])

      /* Auto-remove a channel whose Session was closed or archived on the left
         (spec §4.1). Two guards keep this from wiping the board: the host list must
         be populated (never prune against a still-loading list), and an archived id
         always counts as gone. */
      const archivedIds = workspaceState && workspaceState.archivedSessionIds
        ? workspaceState.archivedSessionIds
        : []
      const archivedKey = archivedIds.join(',')
      useEffect(() => {
        /* A Session we created stops being pending the moment its row lands; a Session we
           just UNARCHIVED stops being exempt once the host stops calling it archived. */
        for (const id of createdSessions.ids()) if (listIds.includes(id)) createdSessions.forget(id)
        for (const id of restoredSessions.ids()) if (!archivedIds.includes(id)) restoredSessions.forget(id)
        if (channels.length === 0 || listIds.length === 0) return
        const pending = createdSessions.ids()
        /* `archivedSessionIds` lags behind `unarchiveSession` by a snapshot, and without this
           exemption the channel the user just brought back would be pruned away again. */
        const restored = restoredSessions.ids()
        const alive = channels.filter(id => (listIds.includes(id) || pending.includes(id) || restored.includes(id))
          && (!archivedIds.includes(id) || restored.includes(id)))
        if (alive.length !== channels.length) actions.setChannels(alive)
      }, [channelsKey, listIdsKey, archivedKey])

      /* Widths of Sessions that are really gone are dropped here, so the persisted map
         cannot grow forever. A channel closed with the x is NOT in this set as long as
         the Session still exists, so putting it back restores the same proportions.
         While the host list is still empty (cold start) only archived ids count, which
         keeps the board safe (spec §4.1). */
      const weightIds = Object.keys(weights)
      const weightIdsKey = weightIds.join(',')
      useEffect(() => {
        if (weightIds.length === 0) return
        const restored = restoredSessions.ids()
        const stale = weightIds.filter(id => (archivedIds.includes(id) && !restored.includes(id))
          || (listIds.length > 0 && !listIds.includes(id)))
        if (stale.length > 0) actions.dropWeights(stale)
      }, [weightIdsKey, listIdsKey, archivedKey])

      /* The undo offer lives for ARCHIVE_UNDO_MS, like the host's archived toast: a stale
         offer is worse than none, because the Session may have been archived again since. */
      useEffect(() => {
        if (undoArchive === undefined) return undefined
        const timer = setTimeout(() => setUndoArchive(undefined), ARCHIVE_UNDO_MS)
        return () => clearTimeout(timer)
      }, [undoArchive])

      /* The reclaim path remounts this panel (ADR-0003), so "the new Session goes
         first" cannot travel in component state: the apply-scope watcher hands it
         over. Wait for its list row — the host list fills in asynchronously, and the
         pruning effect above must not eat an id it has not seen yet. */
      useEffect(() => {
        const pending = pendingRef.current
        if (pending === false || pending === undefined || pending === '') return
        if (listIds.indexOf(pending) === -1) return
        pendingRef.current = false
        acceptNewChannel(pending)
      }, [pendingRef.current, listIdsKey, channelsKey])

      /* Requirement 2 + Q11(a): the freshly created channel must own the caret. A
         reused blank Session does not remount, and a reclaim remount auto-focuses
         every pane with the LAST one winning, so focus is asserted explicitly.
         Retried across frames on purpose: the pane's composer comes from the host
         factory and may not be in the DOM in the commit that added the channel, and a
         one-shot query would silently drop the intent. */
      const focusTries = useRef(0)
      useEffect(() => {
        if (focusId === undefined) return undefined
        let cancelled = false
        const attempt = () => {
          if (cancelled) return
          const panes = typeof document === 'undefined' || typeof document.querySelectorAll !== 'function'
            ? []
            : [...document.querySelectorAll('[data-mixer-pane]')]
          const pane = panes.find(node => node.getAttribute('data-mixer-pane') === focusId)
          if (pane !== undefined) {
            /* A channel scrolled out of the horizontally scrolling track would otherwise
               take focus off-screen (this is also the jump target from §5.6). */
            const cell = typeof pane.closest === 'function' ? pane.closest('[data-mixer-cell]') : null
            if (cell !== null && typeof cell.scrollIntoView === 'function') {
              cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            }
          }
          const field = pane === undefined
            ? null
            : pane.querySelector('[contenteditable="true"]') ?? pane.querySelector('input, textarea')
          if (field !== null && typeof field.focus === 'function') {
            field.focus()
            focusTries.current = 0
            setFocusId(undefined)
            return
          }
          focusTries.current += 1
          /* Give up quietly rather than stealing focus forever if the pane never
             renders its composer; the intent is bounded, not swallowed. */
          if (focusTries.current > FOCUS_RETRY_FRAMES) {
            focusTries.current = 0
            setFocusId(undefined)
            return
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(attempt)
          else if (typeof setTimeout === 'function') setTimeout(attempt, 16)
        }
        attempt()
        return () => { cancelled = true }
      }, [focusId, channelsKey])

      const visible = channels.length > 0 ? channels : listIds.slice(0, PANE_LIMIT)
      const currentBoard = channels.length > 0 ? channels : visible
      /* Publish what the apply-scope shortcuts need (§5.6): the live channel order and the
         two jump actions. Cleared on unmount so a keypress between panels cannot act on a
         stale list; `step` reads the caret's channel from the DOM, so next/prev wrap around
         from wherever the user actually is. */
      useEffect(() => {
        mixerRuntime.ids = visible
        mixerRuntime.focus = (sessionId) => setFocusId(sessionId)
        mixerRuntime.step = (delta) => {
          const ids = visible
          if (ids.length === 0) return
          const active = typeof document === 'undefined' || document.activeElement === null
            || typeof document.activeElement.closest !== 'function'
            ? null
            : document.activeElement.closest('[data-mixer-pane]')
          const currentId = active === null ? undefined : active.getAttribute('data-mixer-pane')
          const index = currentId === undefined || currentId === null ? -1 : ids.indexOf(currentId)
          const base = index === -1 ? (delta > 0 ? -1 : 0) : index
          const target = ids[(base + delta + ids.length) % ids.length]
          if (target !== undefined) setFocusId(target)
        }
        return () => {
          mixerRuntime.ids = []
          mixerRuntime.focus = () => {}
          mixerRuntime.step = () => {}
        }
      }, [channelsKey, listIdsKey])
      const attention = {}
      const states = {}
      ;[...visible, ...parked].forEach(id => {
        /* Retain every channel we are tracking, including ones closed away from the
           layout: the waiting signal only exists for retained Sessions, so dropping
           the reference on close would silently stop the alerts (spec §4.2). */
        refFor(id)
        const entry = status === undefined ? undefined : status.get(id)
        const pendingKind = visiblePendingKind(entry)
        if (pendingKind !== undefined) attention[id] = { kind: pendingKind }
        /* Executing/thinking: SessionStatus.running is the live observation, the
           Session summary is the Host fallback while the status source is silent. */
        const summary = summaries[id]
        const running = entry !== undefined && entry.running !== undefined
          ? entry.running === true
          : (summary === undefined ? false : summary.running === true)
        const catalog = subagentCatalogOf(list, id)
        states[id] = channelState({
          pendingKind,
          running,
          subagents: runningSubagentCount(catalog, child => child === undefined || child === null
            ? false
            : isSubagentRunning(child.id, status, summaries)),
          completed: entry !== undefined && entry.completionUnread === true,
        })
      })
      const hiddenWaiting = parked.filter(id => attention[id] !== undefined).length
      const toggleChannel = (sessionId) => {
        unpark(sessionId)
        if (currentBoard.includes(sessionId)) {
          actions.setChannels(currentBoard.filter(id => id !== sessionId))
          return
        }
        actions.setChannels([...currentBoard, sessionId])
      }
      const closeChannel = (sessionId) => {
        actions.setChannels(visible.filter(id => id !== sessionId))
        park(sessionId)
      }
      const restoreHidden = () => {
        actions.setChannels([...visible, ...parkedIds()])
        unparkAll()
      }
      /* Requirement 2 (spec §4.1): the new channel goes FIRST, reusing a blank Session
         of the CLICKED workspace when there is one — the host does the same in
         `reuseOrCreateBlank`, so "new session" does not pile up blank Sessions. Every
         workspace row in the panel carries this action, so the workspace is an argument
         (2026-10-20: 「新建落点」 retired, spec §5.2). */
      const acceptNewChannel = (sessionId) => {
        refFor(sessionId)
        unpark(sessionId)
        /* Until the host list catalogues it, this id is exempt from the prune below. */
        createdSessions.note(sessionId)
        actions.setChannels(moveChannel(channelsRef.current, sessionId, 0))
        setFocusId(sessionId)
      }
      const createChannel = (workspaceId) => {
        const targetWorkspace = workspaces.find(workspace => workspace.workspaceId === workspaceId)
        const target = blankTargetFor(list, targetWorkspace, archivedIds)
        if (target !== undefined) {
          setNotice(undefined)
          acceptNewChannel(target)
          return
        }
        /* `ctx.sessions.create`, not `uiWorkspace.startSession`: the host's path is
           `openWorkspace → replaceMain(…, 'reveal') → selectPanel(null)`, which would
           throw the user out of the mixer (ADR-0003). */
        void createSession(workspaceId).then((result) => {
          const sessionId = result === undefined ? undefined : result.sessionId
          if (sessionId === undefined || sessionId === null || sessionId === '') {
            /* Silently doing nothing would be worse than the host path it replaces. */
            setNotice(result === undefined || result.error === undefined
              ? '新建会话失败'
              : `新建会话失败：${errorText(result.error)}`)
            return
          }
          setNotice(undefined)
          acceptNewChannel(sessionId)
        })
      }
      /* Archiving from the panel goes through the same service call the sidebar's row
         action uses. The Host refuses while work is running; that refusal becomes an
         inline "stop and archive" offer rather than a dead click.
         EVERY failure mode is reported in the bar — including a synchronous throw and a
         service that is not there at all. "Click, nothing happens" was the reported
         symptom once already; a handler that only logs to the console is exactly how
         that reads from the user's side. */
      const archiveChannel = (sessionId) => {
        setNotice(undefined)
        setArchiveConfirm(undefined)
        if (typeof archiveSession !== 'function') {
          setNotice('归档不可用：宿主没有提供 archiveSession')
          return
        }
        setArchivePending(sessionId)
        runArchive(sessionId, undefined)
      }
      const stopAndArchiveChannel = (sessionId) => {
        setNotice(undefined)
        setArchiveConfirm(undefined)
        setArchivePending(sessionId)
        runArchive(sessionId, { stopActivity: true })
      }
      /* Archive is destructive and one-way by default; the bar offers the same 6 s undo
         the sidebar's archived toast does (spec §5.2, issue #12). Enough is remembered to
         put the channel back exactly where it was, width included. */
      const noteArchiveUndo = (sessionId) => {
        const index = currentBoard.indexOf(sessionId)
        const summary = summaries[sessionId]
        setUndoArchive({
          sessionId,
          title: summary === undefined ? sessionId.slice(0, 8) : summary.displayTitle,
          index: index === -1 ? undefined : index,
          weight: weights[sessionId],
        })
      }
      const runArchive = (sessionId, options) => {
        let attempt
        try {
          attempt = archiveSession(sessionId, options)
        } catch (error) {
          console.error('[mixer] archive call threw', error)
          setArchivePending(undefined)
          setNotice(`归档失败：${errorText(error)}`)
          return
        }
        Promise.resolve(attempt).then(
          () => { setArchivePending(undefined); noteArchiveUndo(sessionId) },
          (reason) => {
            setArchivePending(undefined)
            /* A follow-up "stop and archive" failure is a plain failure: asking again
               would loop. */
            if (options !== undefined || archiveActivityOf(reason) === undefined) {
              console.error('[mixer] archive rejected', reason)
              setNotice(`归档失败：${errorText(reason)}`)
              return
            }
            setArchiveConfirm({ sessionId })
          },
        )
      }
      /* Undo = the host's own `unarchiveSession` (the exact call the sidebar's archived
         toast makes through `undoArchive`), then put the channel back. A failed undo must
         be visible: the chip is gone by then, so the bar's notice takes over — the same
         "a click that only logs is a dead click" rule as for archive. */
      const undoArchivedChannel = () => {
        const record = undoArchive
        if (record === undefined) return
        setUndoArchive(undefined)
        if (typeof unarchiveSession !== 'function') {
          setNotice('撤销归档不可用：宿主没有提供 unarchiveSession')
          return
        }
        let attempt
        try {
          attempt = unarchiveSession(record.sessionId)
        } catch (error) {
          console.error('[mixer] unarchive call threw', error)
          setNotice(`撤销归档失败：${errorText(error)}`)
          return
        }
        Promise.resolve(attempt).then(
          () => {
            if (record.index === undefined) return
            /* Keep the prune effect from dropping the restored channel again while the host
               snapshot still calls it archived. */
            restoredSessions.note(record.sessionId)
            unpark(record.sessionId)
            const next = [...channelsRef.current]
            const at = Math.max(0, Math.min(record.index, next.length))
            next.splice(at, 0, record.sessionId)
            actions.setChannels(next)
            if (record.weight !== undefined) {
              actions.setWeights({ ...weightsRef.current, [record.sessionId]: record.weight })
            }
          },
          (reason) => {
            console.error('[mixer] unarchive rejected', reason)
            setNotice(`撤销归档失败：${errorText(reason)}`)
          },
        )
      }
      /* One path for both drag gestures: a channel head dragged inside the track and a
         session row dragged in from the sidebar (both publish the SessionId as
         text/plain, see Grid's drop handler). */
      const dropChannel = (sessionId, index) => {
        actions.setChannels(moveChannel(currentBoard, sessionId, index))
        /* Dropping a channel that was put away earlier brings it back. */
        unpark(sessionId)
      }
      /* Dragging one divider only touches its two neighbours. The store persists on
         change, so the write rate is bounded by the drag itself. */
      const resizeChannels = (beforeId, beforeWeight, afterId, afterWeight) => {
        actions.setWeights({ ...weights, [beforeId]: beforeWeight, [afterId]: afterWeight })
      }

      return h('div', { style: CSS.root },
        /* Activation for the SHIPPED composer, which we cannot give a class to. The
           host publishes stable hooks on its own markup, so a scoped rule reaches the
           input card itself:
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
        /* Empty-channel optical lift (round 3). Scoped to our panes and to the hero
           phase, on the host's own stable hook for the composer seat; margin-bottom is
           what moves a flex-centred item up without a transform (see HERO_LIFT_PX).
           The drag ghost clones a hero channel's real body, so it needs the same lift —
           otherwise the picture of an empty channel would sit a half step lower than
           the channel it stands for (spec §5.3). */
        h('style', { key: 'mixer-hero-lift' },
          '[data-mixer-pane] [data-content-phase="hero"] [data-composer-seat],'
          + '[data-mixer-drag-ghost] [data-content-phase="hero"] [data-composer-seat]{'
          + `margin-bottom:${HERO_LIFT_PX}px}`),
        /* The row actions (＋会话 / 归档 / 停止并归档) are inline-styled — this plugin has
           no stylesheet — and inline styles cannot express `:hover` / `:focus-visible`, so
           one injected rule owns those two states. `!important` is how a rule beats the
           inline resting surface; without the rule the buttons keep it, so a host that
           drops the style only loses the states, not the look.
           Hover uses the host's ACCENT wash (`interactive-bg-hover-accent`: 14% ink in the
           light theme, 24% white in the dark one) rather than `button-floating-hover`,
           which only shifts by a couple of percent — on a chip this small that is
           indistinguishable from the row's own hover wash (user feedback 2026-10-20:
           「按钮 hover 能否更高亮些」). Resting stays `button-elevated-fill`, so the pair
           still reads as "row hovered" vs "button hovered". */
        h('style', { key: 'mixer-row-action-states' },
          '[data-mixer-row-action]:hover{'
          + 'background:var(--dsw-alias-interactive-bg-hover-accent)!important;'
          + 'border-color:var(--dsw-alias-border-l3)!important}'
          + '[data-mixer-row-action]:focus-visible{'
          + 'outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:0}'),
        h(TopBar, {
          channels: visible,
          hiddenCount: parked.length,
          hiddenWaiting,
          parked,
          attention,
          onRestoreHidden: restoreHidden,
          backToConversation,
          workspaces,
          sessions: summaries,
          /* Each open drops a stale failure note: the note is about one attempt, not
             about the bar's steady state. */
          onPanelOpened: () => {
            setNotice(undefined)
            setArchiveConfirm(undefined)
            setArchivePending(undefined)
          },
          onToggleChannel: toggleChannel,
          onNewSession: createChannel,
          archived: archivedIds,
          onArchive: archiveChannel,
          onStopAndArchive: stopAndArchiveChannel,
          archiveConfirm: archiveConfirm === undefined ? undefined : archiveConfirm.sessionId,
          archivePending,
          onDismissArchive: () => setArchiveConfirm(undefined),
          undoArchive,
          onUndoArchive: undoArchivedChannel,
          notice,
        }),
        visible.length === 0
          ? h('div', { style: CSS.empty },
              h('div', { style: CSS.emptyTitle }, '调音台里还没有通道'),
              h('div', { style: CSS.emptyBody },
                '用顶栏的工作区下拉勾选要关注的会话，只有勾中的会话会在这里列出。移除的会话不会停止，仍在等你的话顶栏会提示。'))
          : h(Grid, {
              ids: visible, summaries, attention, states,
              SessionProvider, refFor, views, weights,
              onResize: resizeChannels,
              onDropChannel: dropChannel,
              onClose: closeChannel, renderFactorySlot,
            }),
      )
    }

    function HeaderToggle(props) {
      return h('button', {
        style: CSS.button,
        title: '打开调音台（多会话并排 + 统一顶栏）',
        'data-mixer-toggle': '',
        onClick: props.openMixer,
      }, '调音台')
    }

    /**
     * Sidebar collapse for the mixer's lifetime.
     *
     * The host exposes no way to READ the collapsed state: `PanelInfo` carries only
     * `activePanelId`, and `ctx.layout.toggleSidebar()` is a blind toggle. So this
     * seam probes the host frame's own `data-sidebar-collapsed` marker to stay
     * idempotent: collapse only when it is not already collapsed, restore only if we
     * were the ones who collapsed it. The marker exists only while collapsed, so
     * "absent" is the only signal for "expanded"; a host that stops publishing it
     * would leave us blind-toggling, which is exactly why this probe is isolated
     * here and not scattered through the panel. Replace it with the layout read/write
     * API once upstream has one (docs/spec.md §7.1).
     * @param ctx - the plugin context.
     * @returns the collapse/restore pair handed to the panel.
     */
    function createSidebar(ctx) {
      let collapsedByUs = false
      const isCollapsed = () => document.querySelector('[data-sidebar-collapsed]') !== null
      return {
        collapse: () => {
          if (isCollapsed()) return
          ctx.layout.toggleSidebar()
          collapsedByUs = true
        },
        restore: () => {
          if (collapsedByUs && isCollapsed()) ctx.layout.toggleSidebar()
          collapsedByUs = false
        },
      }
    }

    /* Pure seams, exposed so the node tests can pin them down without a browser
       (`npm test`). The host reads `inject` and `apply` from this object and ignores
       every other key. */
    const seams = {
      channelState,
      visiblePendingKind,
      runningSubagentCount,
      subagentCatalogOf,
      normalizeBoard,
      moveChannel,
      heroFor,
      blankTargetFor,
      shouldReclaimPanel,
      archiveActivityOf,
      resizedWeights,
      crumbsFor,
      createBoardStore,
      createSidebar,
      /* Label tables too: `tests/labels.test.mjs` checks them against the sidebar's
         own dictionary, and the pane tooltip reads KIND_LABEL directly. */
      labels: { kinds: KIND_LABEL, states: STATE_LABEL, subagents: subagentsLabel },
    }

    return {
      __test: seams,
      /* Service edges this entry needs. `uiWorkspace` is here for the ARCHIVE action
         (`ctx.uiWorkspace.archiveSession`, the same call the sidebar's row action makes):
         creating a Session still goes through `ctx.sessions.create`, because the host's
         `startSession` would reveal it and leave the mixer (ADR-0003).
         ⚠️ Removing a name from this list while some handler still reads `ctx.<name>`
         does NOT fail loudly: the read only happens when the user clicks, and Cordis
         then throws `cannot get property "x" without inject` — which looks exactly like
         a dead button (docs/plugin-gotchas.md §1; this happened with `uiWorkspace` on
         2026-10-15). `tests/host-contract.test.mjs` now pins the invariant.
         `commandUi` is deliberately NOT here: it is provided later than this entry, so it
         is awaited with ctx.inject below. Declaring it would leave the entry pending on a
         boot that never provides it, and reading it unguarded THROWS in Cordis. */
      inject: ['slots', 'sessions', 'layout', 'uiWorkspace', 'shortcuts'],
      apply(ctx) {
        const refs = new Map()
        const refFor = (sessionId) => {
          let reference = refs.get(sessionId)
          if (reference === undefined) {
            reference = ctx.sessions.retain(sessionId, { source: SOURCE })
            reference.ready.catch((error) => {
              console.error('[mixer] Session open failed', sessionId, error)
            })
            refs.set(sessionId, reference)
          }
          return reference
        }
        /* Closing a channel keeps its reference: the signal that it is waiting on you
           must survive leaving the layout, or the whole point is lost. References also
           outlive the mixer view itself, so they are dropped only on plugin unload. */
        const releaseAll = () => {
          for (const reference of refs.values()) reference.release()
          refs.clear()
        }
        ctx.effect(() => () => releaseAll())

        const boardStore = createBoardStore()
        const sidebar = createSidebar(ctx)

        /* Requirement 2 / ADR-0003: create the Session ourselves. The host's
           `uiWorkspace.startSession` REVEALS the new Session (`replaceMain(…,
           'reveal')` → `selectPanel(null)`, navigation.ts:433) — that is exactly the
           "creating a session throws me back to the regular view" the user reported.
           `ctx.sessions.create` only catalogues it; the channel below is the reveal.
           Failures resolve to `{ error }` rather than rejecting: the host's own path
           surfaces them through its notify service, so this one must tell the user
           too instead of silently doing nothing (spec §5.2). */
        const createSession = (workspaceId) => {
          const options = workspaceId === undefined ? {} : { workspaceId }
          return ctx.sessions.create(options).then(
            sessionId => ({ sessionId }),
            (error) => {
              console.error('[mixer] session create failed', error)
              return { error }
            },
          )
        }

        /**
         * Archive a Session the way the sidebar's own row action does — through the
         * same service the host's row calls (`uiWorkspace.archiveSession`,
         * navigation.ts:272), including its `stopActivity` option for the "work is
         * running" refusal. The host's own toast/confirm surfaces are private to
         * ui-workspace, so the panel renders its own; the pruning of an open channel
         * comes free, because the archive lands in the workspaces snapshot (spec §4.1).
         */
        const archiveSession = (sessionId, options) => ctx.uiWorkspace.archiveSession(sessionId, options)
        /* The host's own unarchive call — the sidebar's archived-toast `undoArchive` uses
           exactly this service method (ui-workspace `index.ts:228`). Called only from the
           undo chip, so a missing method is reported to the user instead of reaching
           Cordis' "without inject" failure path. */
        const unarchiveSession = (sessionId) => ctx.uiWorkspace.unarchiveSession(sessionId)

        /* "Put away with the x" is plugin-scope state: it must outlive a panel
           remount (ADR-0003) without ever being persisted (spec §5.3). */
        const parked = new Set()
        const parkedIds = () => [...parked]
        const park = (sessionId) => { parked.add(sessionId) }
        const unpark = (sessionId) => { parked.delete(sessionId) }
        const unparkAll = () => { parked.clear() }

        /* Sessions THIS plugin created, until the host list catches up with them. The
           prune effect drops channels that are gone from the list, and a freshly
           created id is briefly absent from it — without this exemption the new channel
           would be pruned away the instant it was added. The panel gets one handle
           rather than the three operations as separate props. */
        const created = new Set()
        const createdSessions = {
          note: (sessionId) => { created.add(sessionId) },
          forget: (sessionId) => { created.delete(sessionId) },
          ids: () => [...created],
        }
        /* Sessions we just UNARCHIVED. The host's `archivedSessionIds` snapshot lags the
           `unarchiveSession` promise by a beat, and the panel's prune effect treats a
           "still archived" id as gone — without this exemption the channel the user just
           brought back would be removed again immediately (spec §4.1). An id graduates as
           soon as the snapshot stops calling it archived. */
        const restored = new Set()
        const restoredSessions = {
          note: (sessionId) => { restored.add(sessionId) },
          forget: (sessionId) => { restored.delete(sessionId) },
          ids: () => [...restored],
        }

        /* Shortcuts live in apply scope (registered once, with the plugin) but act on
           React state (which channels exist, which one has the caret). The panel
           publishes those three facts on every render and clears them on unmount, so a
           keypress can never act on a stale list. Same handshake family as
           `createdSessions` / `takePendingFirst` below. */
        const mixerRuntime = {
          ids: [],
          focus: () => {},
          step: () => {},
        }

        /* The reclaim handshake: the panel is about to be unmounted, so "this Session
           goes first and owns the caret" waits here for the next mount. */
        let pendingFirst = undefined
        const takePendingFirst = () => {
          const id = pendingFirst
          pendingFirst = undefined
          return id
        }

        /* Host new-session entrances (the 56px rail's own button, `session.new`)
           cannot be intercepted: they call `selectPanel(null)` on the way out. Take the
           panel back — but only when the host's own reveal marker says it just revealed
           a Session with NO HISTORY, which is what its new-session path produces whether
           it created the Session or REUSED an existing blank one (a blank channel is
           exactly what our own ＋ leaves behind, so a new-id test would miss the most
           common repeat press). A sidebar row click reveals a Session with history and
           stays out. The window only bounds how long the reveal may lag the exit; it is
           not a licence to reclaim later (spec §5.1, ADR-0003). */
        const RECLAIM_WINDOW_MS = 2000
        let leftMixerAt = 0
        let previousPanelId = ctx.layout.panelInfo.getSnapshot().activePanelId
        /* What `mainView` points at right now, as `{ id, blank }`. Read-only: the
           convention is the host's and writing it is forbidden (docs/adr/0001). Two ids
           can be retained for a moment across a hand-off; the blank one is the reveal. */
        const revealedMainView = () => {
          const rows = ctx.sessions.list.getSnapshot().byId ?? {}
          const ids = []
          for (const [id, row] of Object.entries(rows)) {
            const retained = row === null || row === undefined ? undefined : row.retainedBy
            const count = retained === null || retained === undefined ? undefined : retained.mainView
            if (typeof count === 'number' && count > 0) ids.push(id)
          }
          if (ids.length === 0) return undefined
          const blankId = ids.find(id => rows[id].blank === true)
          const chosen = blankId === undefined ? ids[0] : blankId
          return { id: chosen, blank: rows[chosen].blank === true }
        }
        const maybeReclaim = () => {
          const activePanelId = ctx.layout.panelInfo.getSnapshot().activePanelId
          const leftMixer = leftMixerAt !== 0 && Date.now() - leftMixerAt <= RECLAIM_WINDOW_MS
          if (!leftMixer) {
            leftMixerAt = 0
            return
          }
          const revealed = revealedMainView()
          if (!shouldReclaimPanel({ leftMixer, activePanelId, revealed })) return
          pendingFirst = revealed.id
          leftMixerAt = 0
          ctx.layout.selectPanel(PANEL_ID)
        }
        ctx.effect(() => {
          const stopList = ctx.sessions.list.subscribe(() => {
            maybeReclaim()
          })
          const stopPanel = ctx.layout.panelInfo.subscribe(() => {
            const activePanelId = ctx.layout.panelInfo.getSnapshot().activePanelId
            if (previousPanelId === PANEL_ID && activePanelId === null) leftMixerAt = Date.now()
            else if (activePanelId !== null) leftMixerAt = 0
            previousPanelId = activePanelId
            maybeReclaim()
          })
          return () => {
            stopList()
            stopPanel()
          }
        })

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'mixer-toggle',
          order: -20,
          label: '调音台',
          inject: () => ({ openMixer: () => ctx.layout.selectPanel(PANEL_ID) }),
        }, HeaderToggle))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          /* The session-scoped child is what puts SessionProvider in our props;
             without it every pane renders empty and nothing errors
             (docs/plugin-gotchas.md §3). */
          children: { 'mixer.channel': { kind: 'single', scope: 'session' } },
          store: boardStore,
          inject: () => ({
            refFor,
            backToConversation: () => ctx.layout.selectPanel('conversation'),
            createSession,
            archiveSession,
            unarchiveSession,
            restoredSessions,
            parkedIds,
            park,
            unpark,
            unparkAll,
            createdSessions,
            mixerRuntime,
            takePendingFirst,
            sidebar,
            /* Read the registered conversation views for the tab row. Guarded because
               `entries` is not part of the catalogued service face, even though
               shipped plugins (ui-settings-general) call it. */
            listViews: () => {
              try {
                return ctx.slots.entries('conversation.view').map(entry => ({
                  id: entry.options.id,
                  label: typeof entry.options.label === 'function'
                    ? entry.options.label()
                    : (entry.options.label === undefined ? entry.options.id : entry.options.label),
                }))
              } catch (error) {
                console.error('[mixer] conversation.view entries unavailable', error)
                return []
              }
            },
          }),
        }, MixerPanel))

        /* `/mixer`: a Client-owned slash command (ui-commands contract), so the view
           is reachable from any composer without touching the header.

           MUST go through `ctx.inject`, never `if (ctx.commandUi)`: in Cordis a read
           of a not-yet-provided service THROWS ("cannot get property \"commandUi\"
           without inject"), it does not return undefined. This plugin does not inject
           ui-commands, so on a cold boot `apply` runs before `commandUi` exists and
           that read would fail the whole entry. `ctx.inject` waits for the service
           instead, and simply never fires when it never arrives. */
        ctx.inject(['commandUi'], (scope) => {
          scope.commandUi.register({
            name: 'mixer',
            label: () => '调音台视图',
            description: () => '把所有关注的会话并排放在一屏里',
            available: () => true,
            ui: { kind: 'action', run: () => ctx.layout.selectPanel(PANEL_ID) },
          })
        })

        /* Channel jumping through the HOST's own shortcut registry (spec §5.6): the
           bindings appear in DSH's shortcut settings, the user can rebind them, and the
           host arbitrates against the composer and other plugins. `primary+alt` is the
           same "does not collide with text editing" family the host uses for
           `session.new`; `regions` includes `editable` so it works while the caret is in
           a channel's composer, which is where a mixer user actually is.

           Outside the mixer every command `pass`es instead of swallowing the key, and
           inside it a missing channel is `blocked` with a reason (the host's own
           vocabulary), never a silent no-op. */
        const shortcutDefaults = (code) => ({
          'desktop:macos': { code, modifiers: ['primary', 'alt'] },
          'desktop:windows': { code, modifiers: ['primary', 'alt'] },
          'desktop:linux': { code, modifiers: ['primary', 'alt'] },
          'web:macos': { code, modifiers: ['primary', 'alt'] },
          'web:windows': { code, modifiers: ['primary', 'alt'] },
        })
        const mixerActive = () => ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID
        const jumpToChannel = (index) => () => {
          if (!mixerActive()) return { status: 'pass' }
          const target = mixerRuntime.ids[index]
          if (target === undefined) {
            return { status: 'blocked', reason: `调音台里没有第 ${index + 1} 个通道` }
          }
          return { status: 'handled', run: () => mixerRuntime.focus(target) }
        }
        for (let index = 0; index < 9; index += 1) {
          ctx.effect(() => ctx.shortcuts.register({
            id: `mixer.channel.${index + 1}`,
            label: () => `跳到调音台第 ${index + 1} 个通道`,
            aliases: [`jump to channel ${index + 1}`, `channel ${index + 1}`, `第 ${index + 1} 个通道`],
            defaults: shortcutDefaults(`Digit${index + 1}`),
            regions: ['page', 'editable'],
            modals: [],
            resolve: jumpToChannel(index),
          }), `mixer: shortcut mixer.channel.${index + 1}`)
        }
        const stepChannel = (delta) => () => {
          if (!mixerActive()) return { status: 'pass' }
          if (mixerRuntime.ids.length === 0) return { status: 'blocked', reason: '调音台里还没有通道' }
          return { status: 'handled', run: () => mixerRuntime.step(delta) }
        }
        for (const [id, label, aliases, code, delta] of [
          ['mixer.channel.next', '跳到下一个通道', ['next channel', '下一个通道'], 'ArrowRight', 1],
          ['mixer.channel.prev', '跳到上一个通道', ['previous channel', '上一个通道'], 'ArrowLeft', -1],
        ]) {
          ctx.effect(() => ctx.shortcuts.register({
            id,
            label: () => label,
            aliases,
            defaults: shortcutDefaults(code),
            regions: ['page', 'editable'],
            modals: [],
            resolve: stepChannel(delta),
          }), `mixer: shortcut ${id}`)
        }
      },
    }
  },
})
