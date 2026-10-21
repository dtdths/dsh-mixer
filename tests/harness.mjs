/**
 * Loads the real plugin module the way the browser does, so the node tests exercise
 * the same file that ships (no build step, no copy).
 *
 * The module calls `window.__ModuleLoader__.load(definition)` at import time and is
 * cached by the ESM loader, so each call imports it under a fresh query string with
 * the capture installed first. The factory's `require` is a table we control, which is
 * exactly what `dsh.client.external` provides at runtime.
 *
 * Three loading modes, in increasing fidelity:
 *   - `loadPlugin()`:     stub React. Enough for the pure seams (they never render).
 *   - `loadRendered()`:   the host's real React + `react-dom/server`, so the component
 *                         tree renders to static HTML; plus a faithful mini store engine
 *                         and a fake host context.
 *   - `loadInteractive()`: the same, but into a real jsdom document with
 *                         `react-dom/client`, so clicks, drags and focus can be driven.
 */
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { createHostFace } from './host-face.mjs'

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

/**
 * Resolve a package out of the host checkout's pnpm store, whichever version is
 * installed. The store keeps each dependency under `.pnpm/<name>@<version>…`, so a
 * directory scan keeps this working across upgrades.
 * @param name - package name to find.
 * @param entry - path inside the package to import.
 * @returns the absolute path to import.
 */
function storePath(name, entry) {
  const store = `${DSH_REPO}/node_modules/.pnpm`
  const dir = readdirSync(store).find(candidate => candidate.startsWith(`${name}@`))
  if (dir === undefined) throw new Error(`${name} is not installed in ${store}`)
  return `${store}/${dir}/node_modules/${name}/${entry}`
}

/**
 * The host's real React toolkit, resolved from a workspace package that declares it
 * (the checkout is a pnpm workspace, so react is not at the repo root).
 * @returns React, the server renderer, the client root factory, and `act`.
 */
export function hostModules() {
  const hostRequire = createRequire(`${DSH_REPO}/packages/client/ui-primitives/package.json`)
  const React = hostRequire('react')
  return {
    React,
    renderToStaticMarkup: hostRequire('react-dom/server').renderToStaticMarkup,
    createRoot: hostRequire('react-dom/client').createRoot,
    act: React.act,
  }
}

/**
 * Install a jsdom document as the process globals, with the pointer-capture API the
 * resizer uses (jsdom does not implement it).
 * @returns the JSDOM instance and its window.
 */
export function setupDom() {
  const { JSDOM } = createRequire(storePath('jsdom', 'package.json'))(storePath('jsdom', 'lib/api.js'))
  /* A real URL: jsdom refuses localStorage on the default opaque origin, and the store
     engine reads localStorage while rehydrating. */
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const { window } = dom
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage']) {
    if (window[key] === undefined) continue
    /* Node 24 exposes some of these as getter-only globals (navigator, localStorage),
       so plain assignment throws; define them instead. */
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  /* jsdom has no pointer capture: the resizer calls it on pointerdown. */
  window.Element.prototype.setPointerCapture = () => {}
  window.Element.prototype.releasePointerCapture = () => {}
  window.Element.prototype.hasPointerCapture = () => false
  /* …and no scrollIntoView: the 会话 panel's left column scrolls the right one to the
     picked workspace. Record the calls so a test can prove the jump happened. */
  window.__scrolls = []
  window.Element.prototype.scrollIntoView = function scrollIntoView() {
    window.__scrolls.push(this.getAttribute('data-mixer-group'))
  }
  return { dom, window }
}

/** Import client.js with a module table, returning the plugin definition. */
async function load(requireTable, windowLike) {
  let captured
  const win = windowLike ?? { addEventListener: () => {}, removeEventListener: () => {} }
  win.__ModuleLoader__ = { load: (definition) => { captured = definition } }
  globalThis.window = win
  globalThis.document = win.document ?? { querySelector: () => null, activeElement: null }
  const path = new URL('../client.js', import.meta.url).pathname
  await import(`${path}?t=${Date.now()}-${Math.random()}`)
  if (captured === undefined) throw new Error('client.js never called __ModuleLoader__.load')
  return captured.factory(requireTable)
}

/**
 * The module table the plugin's `require` sees. Mirrors `dsh.client.external`.
 * @param options - real React, whether the store package is present, and the host's
 *   React for the primitives stub.
 * @returns the table function.
 */
function moduleTable({ React, withStore, storeModule }) {
  return (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-store') {
      if (!withStore) throw new Error(`module "${name}" is not in the table`)
      return storeModule
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { StateDot: (props) => React.createElement('svg', { 'data-state': props.state }) }
    }
    throw new Error(`unexpected require('${name}')`)
  }
}

const DEFAULT_VIEW_ENTRIES = [
  { options: { id: 'chat', label: '对话' } },
  { options: { id: 'trajectory', label: '轨迹' } },
]

/**
 * Build the fake host context, apply the plugin through it, and capture what it
 * registered. This is the part that stands in for `dsh web`'s slot registry.
 * @param definition - the plugin definition.
 * @param options - `viewEntries` seeds `conversation.view`.
 * @returns the captures: registrations, commands, retained/released Sessions, ctx.
 */
export function createHost(definition, { viewEntries = DEFAULT_VIEW_ENTRIES } = {}) {
  const face = createHostFace({ viewEntries })
  const disposers = []
  const ctx = {
    inject: (deps, callback) => callback({ commandUi: face.services.commandUi }),
    /* Run the effect body the way Cordis does (its returned disposer is kept), so the
       reclaim watcher really subscribes in tests. */
    effect: (body) => {
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    ...face.services,
  }
  definition.apply(ctx)
  const main = face.calls.registrations.find(entry => entry.options.name === 'main')
  if (main === undefined) throw new Error('main panel was not registered')
  const { failures } = face
  return {
    registrations: face.calls.registrations,
    commands: face.calls.commands,
    ctx,
    retained: face.calls.retained,
    released: face.calls.released,
    main,
    selectPanelCalls: face.calls.selectPanel,
    createCalls: face.calls.create,
    archiveCalls: face.calls.archive,
    unarchiveCalls: face.calls.unarchive,
    shortcutCommands: face.calls.shortcuts,
    setList: face.list.set,
    setPanelInfo: face.panelInfo.set,
    setCreateFailure: (error) => { failures.create = error },
    setArchiveFailure: (error) => { failures.archive = error },
    setArchiveThrow: (error) => { failures.archiveThrows = error },
    setArchiveDelay: (ms) => { failures.archiveDelayMs = ms },
    setUnarchiveFailure: (error) => { failures.unarchive = error },
    setUnarchiveThrow: (error) => { failures.unarchiveThrows = error },
    panelInfo: () => face.panelInfo.getSnapshot(),
    dispose: () => { for (const dispose of disposers) dispose() },
  }
}

/**
 * The props the slot registry would hand the panel: the registration's own `inject()`
 * output, the store's `useStore`/`actions` share, and the data hooks.
 * @param main - the captured `main` registration.
 * @param input - the store instance, snapshots, and the factory stub.
 * @returns the props object.
 */
export function panelProps(main, { instance, list, status, workspaces, renderFactorySlot, React }) {
  return {
    ...main.options.inject(),
    /* A REAL subscription, not a snapshot read: the panel's own writes must re-render
       it the way the host's bound store does. A version bump rather than identity,
       because the engine mutates the draft in place (Object.is would never change). */
    useStore: (selector) => {
      const [, bump] = React.useState(0)
      React.useEffect(() => instance.subscribe(() => bump(version => version + 1)), [])
      return selector(instance.getSnapshot())
    },
    actions: instance.actions,
    useSessions: selector => selector(list),
    useSessionStatus: selector => selector(status),
    useWorkspaces: selector => selector(workspaces),
    SessionProvider: providerProps => providerProps.children,
    renderFactorySlot: renderFactorySlot ?? ((name, input2) => React.createElement('div', {
      'data-factory': name,
      'data-variant': input2.variant,
      'data-phase': input2.phase,
      'data-hero': input2.hero === true ? 'yes' : 'no',
    })),
  }
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
 * Load with real React and a fake host, then render the panel to static HTML.
 * @param options - `withStore: false` drops the store package from the table (the
 *   plugin must degrade to its in-memory board); `viewEntries` seeds the registry.
 * @returns the plugin definition, captured registrations, and the render helper.
 */
export async function loadRendered(options = {}) {
  const { withStore = true, viewEntries = DEFAULT_VIEW_ENTRIES } = options
  const { React, renderToStaticMarkup } = hostModules()
  const storeModule = createStoreStub()
  const definition = await load(moduleTable({ React, withStore, storeModule }))
  const host = createHost(definition, { viewEntries })

  /**
   * Render the registered `main` panel for one snapshot set.
   * @param input.board - the store state to render.
   * @param input.list - the Sessions list snapshot.
   * @param input.status - Map<SessionId, SessionStatus>.
   * @param input.workspaces - the workspaces snapshot.
   * @returns `{ html, instance, props }`.
   */
  const render = ({ board, list, status, workspaces }) => {
    const instance = host.main.options.store.create()
    if (board !== undefined) instance.actions.setChannels(board.channels)
    if (board !== undefined && Object.keys(board.weights).length > 0) instance.actions.setWeights(board.weights)
    const props = panelProps(host.main, { instance, list, status, workspaces, React })
    return { html: renderToStaticMarkup(React.createElement(host.main.component, props)), instance, props }
  }

  return { definition, registrations: host.registrations, commands: host.commands, ctx: host.ctx, render, retained: host.retained, released: host.released, React }
}

/**
 * Load into a real jsdom document so the panel can be mounted and driven.
 * @param options - `withStore` as above; `viewEntries` seeds `conversation.view`.
 * @returns the mount helper plus everything the caller needs to assert.
 */
export async function loadInteractive(options = {}) {
  const { withStore = true, viewEntries = DEFAULT_VIEW_ENTRIES, withComposer = true } = options
  const { window } = setupDom()
  const { React, createRoot, act } = hostModules()
  const storeModule = createStoreStub()
  const definition = await load(moduleTable({ React, withStore, storeModule }), window)
  const host = createHost(definition, { viewEntries })
  const instance = host.main.options.store.create()
  const container = window.document.getElementById('root')
  const root = createRoot(container)
  /* Factory calls, including the `views` seam the pane pins a view through. */
  const factoryCalls = []
  const renderFactorySlot = (name, input, slotOptions) => {
    factoryCalls.push({ name, input })
    if (slotOptions !== undefined && slotOptions.slots !== undefined && slotOptions.slots.views !== undefined) {
      slotOptions.slots.views({
        renderSlot: (slotName, slotInput) => { factoryCalls.push({ name: slotName, input: slotInput }) },
      })
    }
    return React.createElement('div', {
      'data-factory': name,
      'data-variant': input.variant,
      'data-phase': input.phase,
      'data-hero': input.hero === true ? 'yes' : 'no',
      tabIndex: 0,
    }, withComposer ? React.createElement('input', { 'data-composer': '' }) : null)
  }
  let snapshots = { list: undefined, status: new Map(), workspaces: undefined }
  /**
   * Render the panel with the given snapshots (unset keys keep their previous value).
   * A `board` is written through the instance's actions first, the way the persisted
   * store would arrive.
   * @param next - partial snapshot set, optionally with `board`.
   */
  const draw = (next = {}) => {
    if (next.board !== undefined) {
      instance.actions.setChannels(next.board.channels)
      instance.actions.setWeights(next.board.weights ?? {})
    }
    snapshots = { ...snapshots, ...next }
    /* The host's list store feeds BOTH the panel's hooks and the plugin's own
       apply-scope watcher (spec §5.1); one store, so keep them in step. */
    if (next.list !== undefined) host.setList(next.list)
    act(() => {
      root.render(React.createElement(host.main.component, panelProps(host.main, {
        instance,
        ...snapshots,
        renderFactorySlot,
        React,
      })))
    })
  }
  const $ = selector => container.querySelector(selector)
  const $$ = selector => [...container.querySelectorAll(selector)]
  return { window, document: window.document, React, act, root, container, $, $$, draw, instance, factoryCalls, host, renderFactorySlot }
}
