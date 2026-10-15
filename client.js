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
     * The host's own "most recently used workspace" rule
     * (`ui-workspace/src/client/navigation.ts:458-475`, `recentWorkspace`), which is
     * what `startSession` falls back to when no workspace is named. Not exported by the
     * service face, so it is mirrored here from the same two facts the plugin has:
     * each workspace's newest Session (`updatedAt`), or its own `createdAt` when the
     * list has not caught up. Ties follow host order, like the original.
     * @param items - the host's workspace items, in host order.
     * @param summaries - the Session list rows by id.
     * @returns the workspace id to fall back to, or undefined with no workspace.
     */
    function recentWorkspaceId(items, summaries) {
      let selected
      let selectedTime = Number.NEGATIVE_INFINITY
      for (const item of items) {
        let latest = Number.NEGATIVE_INFINITY
        const members = Array.isArray(item.sessionIds) ? item.sessionIds : []
        for (const sessionId of members) {
          const summary = summaries === undefined ? undefined : summaries[sessionId]
          if (summary !== undefined && typeof summary.updatedAt === 'number') {
            latest = Math.max(latest, summary.updatedAt)
          }
        }
        if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(item.createdAt)
        if (selected === undefined || latest > selectedTime) {
          selected = item.workspaceId
          selectedTime = latest
        }
      }
      return selected
    }

    /**
     * Where a new Session lands: the workspace owning the first visible channel
     * (matched by cwd), else the host's own "most recently used" fallback (spec §5.2).
     * The mixer has no "current workspace" of its own — the top bar never shows one —
     * so this value answers exactly two questions: where `＋新建会话` creates, and which
     * row the panel's left column preselects.
     * @param workspaces - the host's workspace items.
     * @param summaries - the Session list rows by id.
     * @param firstChannelId - the first visible channel's Session id, if any.
     * @returns a workspace id, or undefined when the host has no workspace.
     */
    function landingWorkspace(workspaces, summaries, firstChannelId) {
      const items = Array.isArray(workspaces) ? workspaces : []
      if (items.length === 0) return undefined
      const summary = firstChannelId === undefined || summaries === undefined
        ? undefined
        : summaries[firstChannelId]
      const current = summary === undefined ? undefined : items.find(item => item.path === summary.cwd)
      return current === undefined ? recentWorkspaceId(items, summaries) : current.workspaceId
    }

    /**
     * The blank Session that "new session" should REUSE instead of creating another
     * one, mirroring the host's own `reuseOrCreateBlank` (navigation.ts:185-198): a
     * blank Session inside the landing workspace, still listed, not archived.
     * @param list - the Sessions list snapshot.
     * @param workspace - the landing workspace item, or undefined.
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
     * "the mixer just went away AND the host revealed a Session it did not have
     * before".
     *
     * Why the mainView half is not optional: a panel going blank with a fresh Session
     * around is NOT enough. Clicking a sidebar row does the same `selectPanel(null)`
     * through the same `replaceMain`, and any Session can appear from elsewhere (a
     * background agent, another window). What only the host's own new-session path
     * produces is a Session that was just catalogued AND is now the `mainView`
     * reference — the reveal is what marks it. Reading the convention is allowed;
     * writing it never is (docs/adr/0001, docs/adr/0003).
     * @param input.leftMixer - the mixer was the active panel and went blank just now.
     * @param input.activePanelId - where the host says the centre panel is now.
     * @param input.newSessionIds - Session ids seen for the first time.
     * @param input.mainViewIds - Session ids currently retained by `mainView`.
     * @returns whether to call `selectPanel('mixer')` again.
     */
    function shouldReclaimPanel(input) {
      const fresh = Array.isArray(input.newSessionIds) ? input.newSessionIds : []
      const revealed = Array.isArray(input.mainViewIds) ? input.mainViewIds : []
      if (input.leftMixer !== true || input.activePanelId !== null) return false
      return fresh.some(id => revealed.indexOf(id) !== -1)
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
      button: {
        font: `12px/1.4 ${SANS}`, padding: '3px 10px', cursor: 'pointer', borderRadius: PILL,
        color: T.fg, background: T.l2, border: `1px solid ${T.b1}`,
      },
      chip: {
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '1px 7px', borderRadius: PILL, background: T.l2,
        border: `1px solid ${T.b1}`, color: T.fg2, font: `10px/1.8 ${SANS}`,
      },
      dot: { width: 7, height: 7, borderRadius: PILL, background: T.warn, flex: '0 0 auto' },
      ddWrap: { position: 'relative' },
      /* The `会话` popover (spec §5.2, requirement 4): two COLUMNS, because the old
         two-LEVEL dropdown made the user pick a workspace before any Session was even
         visible, and buried "new session" one level down. Left column = landing
         workspace only; right column = the channel picker. */
      backdrop: { position: 'fixed', inset: 0, zIndex: 39, background: 'transparent' },
      panel: {
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40,
        display: 'flex', background: T.base, border: `1px solid ${T.b2}`,
        boxShadow: '0 8px 28px rgba(0,0,0,.22)', maxHeight: '62vh',
      },
      panelColLeft: {
        width: 178, flex: '0 0 auto', borderRight: `1px solid ${T.b1}`, padding: 4, overflow: 'auto',
      },
      panelColRight: { width: 320, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 },
      panelHead: { padding: '5px 8px', color: T.fg2, font: `10.5px/1.6 ${SANS}` },
      panelGroup: { padding: '5px 8px 2px', color: T.fg2, font: `10.5px/1.6 ${SANS}` },
      panelRows: { flex: 1, minHeight: 0, overflow: 'auto', padding: 4 },
      panelEmpty: { padding: '4px 8px', color: T.fg2, font: `11.5px/1.6 ${SANS}` },
      panelFoot: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderTop: `1px solid ${T.b1}`,
      },
      panelHint: { color: T.fg2, font: `10.5px/1.6 ${SANS}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      landingRow: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer',
        font: `12px/1.6 ${SANS}`, borderRadius: SURFACE,
      },
      landingRowOn: { background: T.l1 },
      landingTag: {
        flex: '0 0 auto', padding: '1px 6px', borderRadius: PILL, background: T.l2,
        border: `1px solid ${T.b1}`, color: T.fg2, font: `10px/1.7 ${SANS}`,
      },
      searchRow: { padding: '5px 8px', borderBottom: `1px solid ${T.b1}` },
      searchInput: {
        width: '100%', font: `12px/1.6 ${SANS}`, padding: '4px 7px', borderRadius: SURFACE,
        background: T.l1, color: T.fg, border: `1px solid ${T.b1}`, outline: 'none',
      },
      sessionRow: {
        display: 'flex', alignItems: 'center', gap: 7, padding: '3px 6px', cursor: 'pointer',
        font: `11.5px/1.6 ${SANS}`, borderRadius: SURFACE,
      },
      rowWarnDot: { width: 7, height: 7, flex: '0 0 auto', borderRadius: PILL, background: T.warn },
      rowTag: {
        flex: '0 0 auto', padding: '1px 6px', borderRadius: PILL, background: T.l2,
        border: `1px solid ${T.b1}`, color: T.fg2, font: `10px/1.7 ${SANS}`,
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
      crumb: { color: T.fg2, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 },
      crumbCurrent: {
        color: T.fg, fontWeight: 600, fontSize: 14, overflow: 'hidden',
        textOverflow: 'ellipsis', maxWidth: 280,
      },
      crumbSep: { color: T.fg2, opacity: 0.6, fontSize: 12.5 },
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
        font: `12.5px/1.6 ${SANS}`, padding: '6px 11px', cursor: 'pointer', borderRadius: 0,
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
     * Left column = the landing workspace, and nothing else: with the top bar showing
     * no workspace name, this is the only place the question is answered. Right column
     * = the channel picker, with a local title filter and the waiting / 已移出 state on
     * every row.
     */
    function SessionPanel(props) {
      const {
        onClose, workspaces, sessions, channels, parked, attention,
        landingId, landingTitle, onPickLanding, onToggleChannel, onNewSession,
      } = props
      const [query, setQuery] = useState('')
      const needle = query.trim()
      /* Local title filtering on purpose: the host's full-content search is a
         different feature (request-local results, loading/error handling) and is
         recorded as phase 2 (spec §9.1). */
      const matches = sessionId => needle === ''
        || String((sessions[sessionId] === undefined ? '' : sessions[sessionId].displayTitle) ?? '').includes(needle)

      return h(React.Fragment, null,
        h('div', { style: CSS.backdrop, onClick: onClose }),
        h('div', {
          style: CSS.panel,
          'data-mixer-session-panel': '',
          role: 'dialog',
          'aria-label': '会话与新建落点',
        },
          h('div', { style: CSS.panelColLeft, 'data-mixer-landing-column': '' },
            h('div', { style: CSS.panelHead }, '工作区'),
            workspaces.length === 0
              ? h('div', { style: CSS.panelEmpty }, '还没有工作区')
              : workspaces.map(workspace => h('div', {
                  key: workspace.workspaceId,
                  style: {
                    ...CSS.landingRow,
                    ...(workspace.workspaceId === landingId ? CSS.landingRowOn : null),
                  },
                  'data-mixer-landing': workspace.workspaceId,
                  title: `新建会话落在此工作区：${workspace.path}`,
                  onClick: () => onPickLanding(workspace.workspaceId),
                },
                  h('span', {
                    style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, workspace.title),
                  workspace.workspaceId === landingId
                    ? h('span', { style: CSS.landingTag }, '新建落点')
                    : null,
                )),
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
            h('div', { style: CSS.panelRows },
              workspaces.length === 0
                ? h('div', { style: CSS.panelEmpty }, '还没有工作区')
                : workspaces.map(workspace => {
                    const ids = (workspace.sessionIds || []).filter(matches)
                    return h('div', { key: workspace.workspaceId },
                      h('div', { style: CSS.panelGroup }, workspace.title),
                      ids.length === 0
                        ? h('div', { style: CSS.panelEmpty },
                            needle === '' ? '这个工作区还没有会话' : '没有匹配的会话')
                        : ids.map(sessionId => {
                            const summary = sessions[sessionId]
                            const checked = channels.indexOf(sessionId) !== -1
                            const isParked = parked.indexOf(sessionId) !== -1
                            return h('label', {
                              key: sessionId,
                              style: CSS.sessionRow,
                              'data-mixer-session': sessionId,
                            },
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
                            )
                          }),
                    )
                  })),
            h('div', { style: CSS.panelFoot },
              h('button', {
                style: CSS.button,
                'data-mixer-new': '',
                title: landingTitle === undefined
                  ? '新建会话'
                  : `在 ${landingTitle} 新建会话并放到第一位`,
                onClick: onNewSession,
              }, '＋ 在此新建会话'),
              h('span', { style: { flex: 1 } }),
              h('span', { style: CSS.panelHint }, needle === '' ? '勾选即加入通道' : `过滤：${needle}`),
            ),
          ),
        ))
    }

    function TopBar(props) {
      const {
        channels, hiddenWaiting, hiddenCount, parked,
        attention, backToConversation,
        workspaces, sessions, landingId, landingTitle,
        onPickLanding, onToggleChannel, onNewSession, onPanelOpened, createError,
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
            title: '关注的会话、新建落点与新建会话',
          }, `会话${channels.length > 0 ? ` · ${channels.length}` : ''}`),
          panelOpen
            ? h(SessionPanel, {
                onClose: () => setPanelOpen(false),
                workspaces, sessions, channels, parked, attention,
                landingId, landingTitle, onPickLanding, onToggleChannel,
                onNewSession: () => { setPanelOpen(false); onNewSession() },
              })
            : null),

        h('span', { style: { flex: 1 } }),

        /* Attention summary for channels, including the ones put away */
        waitingCount > 0
          ? h('span', { style: CSS.chip }, h('span', { style: CSS.dot }), `${waitingCount} 个通道在等你`)
          : null,
        createError === undefined
          ? null
          : h('span', {
              style: { ...CSS.chip, borderColor: T.warn, color: T.fg },
              title: '宿主没有返回可用的新会话；详情在控制台',
              'data-mixer-create-error': '',
            }, createError),
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

    function Pane(props) {
      const {
        sessionId, summary, summaries, waitingKind, views, state,
        onClose, onDragStateChange, renderFactorySlot,
      } = props
      const isWaiting = waitingKind !== undefined
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
               `draggable` — this head row — so hand it the whole pane instead. The
               snapshot is taken once, right here; HTML5 has no live drag image, which
               is why "跟手" would mean giving up this API (spec §5.3). */
            const pane = typeof event.currentTarget.closest === 'function'
              ? event.currentTarget.closest('[data-mixer-pane]')
              : null
            if (pane !== null && typeof event.dataTransfer.setDragImage === 'function') {
              const rect = pane.getBoundingClientRect()
              const offsetX = Number.isFinite(event.clientX) ? event.clientX - rect.left : 0
              const offsetY = Number.isFinite(event.clientY) ? event.clientY - rect.top : 0
              event.dataTransfer.setDragImage(pane, offsetX, offsetY)
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
            hero: heroFor(summary),
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
        backToConversation, createSession, listViews, sidebar, useStore, actions,
        parkedIds, park, unpark, unparkAll, createdSessions, takePendingFirst,
      } = props
      /* Channels put away with the x live in the PLUGIN scope: not in the persisted
         board ("put away for now" is about this sitting, not a preference) and not in
         component state either, because the panel is remounted whenever the mixer
         takes its centre panel back (ADR-0003). */
      const parked = parkedIds()
      /* Which workspace a new Session lands in. `undefined` = follow the first visible
         channel; a pick in the panel lasts for that one open (spec §5.2). */
      const [landing, setLanding] = useState(undefined)
      /* The Session whose composer must own the caret once it is on screen. Explicit,
         because the host's InputBar auto-focuses every pane and the last mount wins
         (spec §5.1, requirement 2). */
      const [focusId, setFocusId] = useState(undefined)
      /* The last create failure, shown in the top bar. A failed create must not look
         like a no-op: the host's own entrance reports failures through its notify
         service, so ours reports through the bar it already owns. */
      const [createError, setCreateError] = useState(undefined)
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
        /* A Session we created stops being pending the moment its row lands. */
        for (const id of createdSessions.ids()) if (listIds.includes(id)) createdSessions.forget(id)
        if (channels.length === 0 || listIds.length === 0) return
        const pending = createdSessions.ids()
        const alive = channels.filter(id => (listIds.includes(id) || pending.includes(id))
          && !archivedIds.includes(id))
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
        const stale = weightIds.filter(id => archivedIds.includes(id)
          || (listIds.length > 0 && !listIds.includes(id)))
        if (stale.length > 0) actions.dropWeights(stale)
      }, [weightIdsKey, listIdsKey, archivedKey])

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
      /* Requirement 4: the bar shows no workspace name, so this value exists only to
         answer "where does ＋新建会话 land" — the first visible channel's workspace, or
         the one picked in the panel for this open. */
      const landingId = landing === undefined
        ? landingWorkspace(workspaces, summaries, visible[0])
        : landing
      const landingItem = workspaces.find(workspace => workspace.workspaceId === landingId)

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
      /* Requirement 2 (spec §4.1): the new channel goes FIRST, reusing the landing
         workspace's blank Session when there is one — the host does the same in
         `reuseOrCreateBlank`, so "new session" does not pile up blank Sessions. */
      const acceptNewChannel = (sessionId) => {
        refFor(sessionId)
        unpark(sessionId)
        /* Until the host list catalogues it, this id is exempt from the prune below. */
        createdSessions.note(sessionId)
        actions.setChannels(moveChannel(channelsRef.current, sessionId, 0))
        setFocusId(sessionId)
      }
      const createChannel = () => {
        const target = blankTargetFor(list, landingItem, archivedIds)
        if (target !== undefined) {
          setCreateError(undefined)
          acceptNewChannel(target)
          return
        }
        /* `ctx.sessions.create`, not `uiWorkspace.startSession`: the host's path is
           `openWorkspace → replaceMain(…, 'reveal') → selectPanel(null)`, which would
           throw the user out of the mixer (ADR-0003). */
        void createSession(landingId).then((result) => {
          const sessionId = result === undefined ? undefined : result.sessionId
          if (sessionId === undefined || sessionId === null || sessionId === '') {
            /* Silently doing nothing would be worse than the host path it replaces. */
            setCreateError(result === undefined || result.error === undefined
              ? '新建会话失败'
              : `新建会话失败：${errorText(result.error)}`)
            return
          }
          setCreateError(undefined)
          acceptNewChannel(sessionId)
        })
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
          landingId,
          landingTitle: landingItem === undefined ? undefined : landingItem.title,
          /* Each open starts from the derived landing, so a pick lasts one open. */
          onPanelOpened: () => setLanding(undefined),
          onPickLanding: (workspaceId) => setLanding(workspaceId),
          onToggleChannel: toggleChannel,
          onNewSession: createChannel,
          createError,
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
      landingWorkspace,
      blankTargetFor,
      shouldReclaimPanel,
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
      /* Service edges this entry needs at apply time. `uiWorkspace` is deliberately
         gone: creating a Session goes through `ctx.sessions.create` instead, because
         the host's `startSession` reveals it and that reveal leaves the mixer
         (ADR-0003). `commandUi` is deliberately NOT here: it is provided later than
         this entry, so it is awaited with ctx.inject below. Declaring it would leave
         the entry pending on a boot that never provides it, and reading it unguarded
         THROWS in Cordis (docs/plugin-gotchas.md §1: one such read failed the whole
         Web boot). */
      inject: ['slots', 'sessions', 'layout'],
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
           panel back — but ONLY on that conjunction (the mixer just went blank AND a
           brand-new Session appeared with it). A user leaving on purpose looks
           identical on the panel side, so the fresh-Session set carries the weight
           (spec §5.1, ADR-0003). The window only bounds how long the two halves may be
           apart; it is not a licence to reclaim later. */
        const RECLAIM_WINDOW_MS = 2000
        const knownIds = new Set(ctx.sessions.list.getSnapshot().ids ?? [])
        let freshIds = []
        let freshAt = 0
        let leftMixerAt = 0
        let previousPanelId = ctx.layout.panelInfo.getSnapshot().activePanelId
        const noteFreshSessions = () => {
          const ids = ctx.sessions.list.getSnapshot().ids ?? []
          const inMixer = ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID
          for (const id of ids) {
            if (knownIds.has(id)) continue
            knownIds.add(id)
            /* Only ids that appear WHILE the mixer is the panel can be evidence for
               leaving it. A cold boot's list burst (or anything created by a Session we
               made ourselves) arrives while another view is up, and must never summon
               the mixer later. */
            if (!inMixer) continue
            if (created.has(id)) continue
            freshIds.push(id)
          }
          if (freshIds.length > 0) freshAt = Date.now()
        }
        /* The ids the host's own `mainView` convention currently points at. Read-only
           (docs/adr/0001): this is how the reveal marks the Session it created. */
        const mainViewIds = () => {
          const snapshot = ctx.sessions.list.getSnapshot()
          const rows = snapshot.byId ?? {}
          const ids = []
          for (const [id, row] of Object.entries(rows)) {
            const retained = row === null || row === undefined ? undefined : row.retainedBy
            const count = retained === null || retained === undefined ? undefined : retained.mainView
            if (typeof count === 'number' && count > 0) ids.push(id)
          }
          return ids
        }
        const maybeReclaim = () => {
          /* Both halves are recency-bounded: a Session that appeared long ago is not
             evidence for the exit we are looking at. */
          if (freshAt !== 0 && Date.now() - freshAt > RECLAIM_WINDOW_MS) {
            freshIds = []
            freshAt = 0
          }
          const activePanelId = ctx.layout.panelInfo.getSnapshot().activePanelId
          const leftMixer = leftMixerAt !== 0 && Date.now() - leftMixerAt <= RECLAIM_WINDOW_MS
          if (!leftMixer) {
            leftMixerAt = 0
            return
          }
          const revealed = mainViewIds()
          if (!shouldReclaimPanel({
            leftMixer,
            activePanelId,
            newSessionIds: freshIds,
            mainViewIds: revealed,
          })) return
          /* The Session to put first is the one the host REVEALED, not merely the last
             id that happened to appear. */
          const target = freshIds.filter(id => revealed.indexOf(id) !== -1)
          pendingFirst = target[target.length - 1]
          freshIds = []
          freshAt = 0
          leftMixerAt = 0
          ctx.layout.selectPanel(PANEL_ID)
        }
        ctx.effect(() => {
          const stopList = ctx.sessions.list.subscribe(() => {
            noteFreshSessions()
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
            parkedIds,
            park,
            unpark,
            unparkAll,
            createdSessions,
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
      },
    }
  },
})
