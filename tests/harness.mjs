/**
 * Loads the real plugin module the way the browser does, so the node tests exercise
 * the same file that ships (no build step, no copy).
 *
 * The module calls `window.__ModuleLoader__.load(definition)` at import time and is
 * cached by the ESM loader, so each call imports it under a fresh query string with
 * the capture installed first. The factory's `require` is a table we control, which
 * is exactly what `dsh.client.external` provides at runtime.
 *
 * Two loading modes:
 *   - `loadPlugin()`: stub React. Enough for the pure seams (they never render).
 *   - `loadRendered()`: the host's real React and a faithful mini store engine, plus
 *     a fake host context, so the component tree can be rendered server-side. This is
 *     what catches "the React layer has never actually run" bugs without a browser.
 */
import { createRequire } from 'node:module'

const DSH_REPO = process.env.DSH_REPO ?? '/Users/user/Documents/code/deepseek-harness'

const ReactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
}

/**
 * Mini engine that honours the real store contract: init once, draft-mutating
 * actions, subscribers notified after each write. Independent of the plugin's own
 * fallback engine on purpose, so a test can tell them apart.
 * @returns a `defineStore`-shaped factory.
 */
export function createStoreStub() {
  return {
    defineStore: (spec) => ({
      spec,
      create: () => {
        const state = spec.init()
        const listeners = new Set()
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
    }),
  }
}

/** Import client.js with a module table, returning the definition and module instance. */
async function load(requireTable) {
  let captured
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { captured = definition } },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = { querySelector: () => null, activeElement: null }
  const path = new URL('../client.js', import.meta.url).pathname
  await import(`${path}?t=${Date.now()}-${Math.random()}`)
  if (captured === undefined) throw new Error('client.js never called __ModuleLoader__.load')
  return captured.factory(requireTable)
}

/**
 * Import client.js and return the plugin definition its factory produces.
 * @returns {Promise<{ definition: object, seams: object }>} the definition plus the
 *   pure seams the module exposes for tests.
 */
export async function loadPlugin() {
  const definition = await load((name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-store') return createStoreStub()
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { StateDot: (props) => ({ type: 'svg', props: { 'data-state': props.state } }) }
    }
    throw new Error(`unexpected require('${name}')`)
  })
  return { definition, seams: definition.__test }
}

/**
 * Load with real React and a fake host, then apply the plugin.
 *
 * The returned `render()` helper builds the props the slot registry would hand the
 * panel: the registration's own `inject()` output, the store's `useStore`/`actions`
 * share, and the data hooks over the caller's snapshots.
 * @param options - `withStore: false` drops the store package from the table (the
 *   plugin must degrade to its in-memory board); `viewEntries` seeds the registry.
 * @returns the plugin definition, captured registrations, and the render helper.
 */
export async function loadRendered({ withStore = true, viewEntries = [{ options: { id: 'chat', label: '对话' } }, { options: { id: 'trajectory', label: '轨迹' } }] } = {}) {
  /* The host checkout is a pnpm workspace: react/react-dom live in the store, not at
     the repo root, so resolve them from a workspace package that declares them. */
  const hostRequire = createRequire(`${DSH_REPO}/packages/client/ui-primitives/package.json`)
  const React = hostRequire('react')
  const { renderToStaticMarkup } = hostRequire('react-dom/server')
  const storeModule = createStoreStub()
  const definition = await load((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-store') {
      if (!withStore) throw new Error(`module "${name}" is not in the table`)
      return storeModule
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { StateDot: (props) => React.createElement('svg', { 'data-state': props.state }) }
    }
    throw new Error(`unexpected require('${name}')`)
  })

  const registrations = []
  const commands = []
  const retained = []
  const released = []
  const ctx = {
    inject: (deps, callback) => callback({ commandUi: { register: (contribution) => { commands.push(contribution) } } }),
    effect: () => () => {},
    slots: {
      inject: (key, callback) => { callback() },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
      entries: (name) => (name === 'conversation.view' ? viewEntries : []),
    },
    sessions: {
      retain: (sessionId) => {
        retained.push(sessionId)
        const reference = { ready: Promise.resolve(), release: () => released.push(sessionId) }
        return reference
      },
    },
    layout: { selectPanel: () => {}, toggleSidebar: () => {} },
    uiWorkspace: { startSession: () => {}, openWorkspace: () => {} },
  }
  definition.apply(ctx)

  /**
   * Render the registered `main` panel for one snapshot set.
   * @param input.board - the store state to render.
   * @param input.list - the Sessions list snapshot.
   * @param input.status - Map<SessionId, SessionStatus>.
   * @param input.workspaces - the workspaces snapshot.
   * @returns `{ html, instance, props }`.
   */
  const render = ({ board, list, status, workspaces }) => {
    const main = registrations.find(entry => entry.options.name === 'main')
    if (main === undefined) throw new Error('main panel was not registered')
    const instance = main.options.store.create()
    if (board !== undefined) instance.actions.setChannels(board.channels)
    if (board !== undefined && Object.keys(board.weights).length > 0) instance.actions.setWeights(board.weights)
    const props = {
      ...main.options.inject(),
      useStore: selector => selector(instance.getSnapshot()),
      actions: instance.actions,
      useSessions: selector => selector(list),
      useSessionStatus: selector => selector(status),
      useWorkspaces: selector => selector(workspaces),
      SessionProvider: providerProps => providerProps.children,
      renderFactorySlot: (name, input) => React.createElement('div', {
        'data-factory': name,
        'data-variant': input.variant,
      }),
    }
    return { html: renderToStaticMarkup(React.createElement(main.component, props)), instance, props }
  }

  return { definition, registrations, commands, ctx, render, retained, released, React }
}
