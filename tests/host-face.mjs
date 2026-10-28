/**
 * The one fake **host face**: the services this plugin injects, implemented once.
 *
 * Why it exists: "what the host offers us" used to be modelled three times with different
 * fidelity — a real-Cordis context in `boot-check.mjs`, a plain-object context in
 * `tests/harness.mjs`, and prose in `docs/plugin-gotchas.md`. Adding a service edge meant
 * editing every copy, and the copies had already drifted (only `boot-check.mjs` runs a
 * real Cordis; only the harness drives the two host stores). This module owns the
 * *fixture* half — the service names and their fake behaviour. The *assertions* stay
 * independent: `tests/host-contract.test.mjs` reads the DSH checkout, and `boot-check.mjs`
 * keeps its real Cordis context and its failing control, because a fixture and a sentinel
 * that share one idea of "what the host accepts" cannot catch a wrong idea.
 *
 * Two consumers, on purpose:
 *   - `boot-check.mjs` provides these objects into a real Cordis `Context` (cold boot);
 *   - `tests/harness.mjs` spreads them onto a plain object and drives the failure switches.
 * @module tests/host-face
 */

/**
 * A tiny snapshot store with subscribers — the shape the host's stores publish.
 * @param initial - the first snapshot.
 * @returns `{ getSnapshot, subscribe, set }`.
 */
export function createObservable(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /* Only the fake host calls this: the plugin never writes a host store. */
    set: (next) => {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The host surfaces a fresh list / panel-info snapshot starts from. */
const EMPTY_LIST = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
const NO_PANEL = { activePanelId: null }

/**
 * Build the fake host services plus the call log and the failure switches.
 *
 * The failure switches exist because a failing host is a real path this plugin must
 * report instead of swallowing (spec §5.2: "a click must never do nothing").
 * @param options - `viewEntries` seeds `conversation.view`.
 * @returns the services by name, the call log, the failure switches, and the two stores.
 */
export function createHostFace({ viewEntries = [] } = {}) {
  const calls = {
    registrations: [],
    commands: [],
    retained: [],
    released: [],
    selectPanel: [],
    create: [],
    archive: [],
    unarchive: [],
    openSession: [],
    openResource: [],
    shortcuts: [],
  }
  const failures = {
    create: undefined,
    archive: undefined,
    archiveThrows: undefined,
    archiveDelayMs: 0,
    unarchive: undefined,
    unarchiveThrows: undefined,
    /* A profile that does not ship a service the plugin reads with `ctx.get`: the read
       must degrade to undefined, not throw (`ui-chat/apply.ts:245` is the host's own
       precedent, spec §7.4 / ADR-0004). */
    missingService: undefined,
  }
  const list = createObservable(EMPTY_LIST)
  const panelInfo = createObservable(NO_PANEL)

  const services = {
    /* Slot registry: `inject` runs the registration callback the way a slot does. */
    slots: {
      inject: (key, callback) => { callback() },
      register: (options, component) => {
        calls.registrations.push({ options, component })
        return () => {}
      },
      entries: (name) => (name === 'conversation.view' ? viewEntries : []),
    },
    sessions: {
      retain: (sessionId) => {
        calls.retained.push(sessionId)
        return { ready: Promise.resolve(), release: () => calls.released.push(sessionId) }
      },
      create: (options) => {
        calls.create.push(options)
        if (failures.create !== undefined) return Promise.reject(failures.create)
        return Promise.resolve(`created-${calls.create.length}`)
      },
      list,
    },
    layout: {
      selectPanel: (panelId) => {
        calls.selectPanel.push(panelId)
        panelInfo.set({ activePanelId: panelId })
      },
      toggleSidebar: () => {},
      panelInfo,
    },
    /* The two calls the sidebar's own row action makes (navigation.ts:272 / :277), plus
       the row's own reveal (`openSession`, navigation.ts:276-278) which spec §5.1 uses to
       land 常规视图 on the active channel and spec §7.4 to open a file link from a channel.
       Faithful to the host's own sequence: retain the Session as `mainView` (a list
       publish) and THEN deselect the panel (:506 / :528) — the order the plugin's
       reclaim watcher sees in a browser. */
    uiWorkspace: {
      openSession: (sessionId) => {
        calls.openSession.push(sessionId)
        const snapshot = list.getSnapshot()
        const row = snapshot.byId[sessionId] ?? { id: sessionId }
        list.set({ ...snapshot, byId: { ...snapshot.byId, [sessionId]: { ...row, retainedBy: { mainView: 1 } } } })
        panelInfo.set({ activePanelId: null })
      },
      archiveSession: (sessionId, options) => {
        calls.archive.push({ sessionId, options })
        /* A service that THROWS instead of rejecting: the "click does nothing" class. */
        if (failures.archiveThrows !== undefined) throw failures.archiveThrows
        if (failures.archiveDelayMs > 0) {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              if (failures.archive !== undefined) reject(failures.archive)
              else resolve()
            }, failures.archiveDelayMs)
          })
        }
        if (failures.archive !== undefined) return Promise.reject(failures.archive)
        return Promise.resolve()
      },
      unarchiveSession: (sessionId) => {
        calls.unarchive.push(sessionId)
        if (failures.unarchiveThrows !== undefined) throw failures.unarchiveThrows
        if (failures.unarchive !== undefined) return Promise.reject(failures.unarchive)
        return Promise.resolve()
      },
    },
    /* The right Sidebar's face (`ui-sidebar-right/src/client/index.ts:151`
       `reflect.provide('sidebarRight', controller)`). The plugin never calls it itself —
       it only checks the panel is there before taking a host file link over, because
       inside the mixer every open throws (spec §7.4 / ADR-0004). */
    sidebarRight: {
      openResource: (address, options) => {
        calls.openResource.push({ address, options })
        /* Faithful to the host: `require()` throws while no Session is on screen
           (`ui-sidebar-right/src/client/service.ts:723-733`). */
        if (panelInfo.getSnapshot().activePanelId !== null) {
          throw new Error('sidebarRight: no session surface is mounted')
        }
      },
    },
    /* The host's shortcut registry (spec §5.6). */
    shortcuts: {
      register: (command) => {
        calls.shortcuts.push(command)
        return () => {}
      },
    },
    /* Client-owned slash commands; the host provides this service later than the entry. */
    commandUi: {
      register: (contribution) => {
        calls.commands.push(contribution)
        return () => {}
      },
    },
  }

  return { services, calls, failures, list, panelInfo }
}

/**
 * The service names the plugin declares in its Cordis `inject` list. Kept next to the
 * fixture so "a new edge" is one list, not a scavenger hunt.
 */
export const HOST_SERVICES = ['slots', 'sessions', 'layout', 'uiWorkspace', 'shortcuts']
