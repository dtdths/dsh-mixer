/**
 * Loads the real plugin module the way the browser does, so the node tests exercise
 * the same file that ships (no build step, no copy).
 *
 * The module calls `window.__ModuleLoader__.load(definition)` at import time and is
 * cached by the ESM loader, so each call imports it under a fresh query string with
 * the capture installed first. The factory's `require` is a table we control, which
 * is exactly what `dsh.client.external` provides at runtime.
 */
const ReactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
}

/** The real store contract, minimal: spec in, handle out. */
const storeStub = {
  defineStore: (spec) => ({
    spec,
    create: () => ({
      getSnapshot: () => spec.init(),
      subscribe: () => () => {},
      actions: {},
      clearPersisted: () => {},
    }),
  }),
}

/**
 * Import client.js and return the plugin definition its factory produces.
 * @returns {Promise<{ definition: object, seams: object }>} the definition plus the
 *   pure seams the module exposes for tests.
 */
export async function loadPlugin() {
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
  const definition = captured.factory((name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-store') return storeStub
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { StateDot: (props) => ({ type: 'svg', props: { 'data-state': props.state } }) }
    }
    throw new Error(`unexpected require('${name}')`)
  })
  return { definition, seams: definition.__test }
}
