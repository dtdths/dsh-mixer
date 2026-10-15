/**
 * Cold-boot guard for client.js. Run: node boot-check.mjs (or `npm run boot-check`).
 *
 * Why this exists (round-4 incident, 2026-10-14): `apply()` read `ctx.commandUi`
 * directly, guarded with `!== undefined`. In Cordis, reading a service the fiber did
 * not inject THROWS ("cannot get property \"commandUi\" without inject"), so the guard
 * never ran. The fiber went FAILED and the host boot audit rejected startup with
 * "web boot: 1 entry did not activate: dsh-mixer: failed" -- the whole Harness page.
 *
 * A "it worked when I smoke tested" claim was possible because a stub ctx always had
 * the property, and HMR re-applies only after every service is up. So this check
 * starts the real module through a real Cordis Context the way the loader does, reads
 * the fiber state, and carries an inline control that reproduces the exact failure
 * mode: if the control stops failing, this check is not proving anything and says so.
 *
 * It also asserts the two registration facts that fail silently at runtime:
 *   - `main` declares a session-scoped child slot (without it every pane renders
 *     empty and nothing errors, docs/plugin-gotchas.md §3),
 *   - `main` carries the board store (which is what gives the panel `useStore`).
 *
 * Writing throwaway checks against this module, two rules that cost real time:
 *   1. The module destructures React hooks (useState, useEffect, ...) from the React
 *      stub AT FACTORY TIME. Install any hook stub before calling `captured.factory`.
 *   2. `apply()` may read services only through `ctx.inject`. A stub ctx must
 *      therefore provide `inject(deps, callback)`, or apply() throws.
 *
 * The DSH checkout to boot against comes from `DSH_REPO` (default: this machine's
 * checkout). Point it at another checkout after switching DSH branches, so the guard
 * boots the module against the Cordis actually in use:
 *   DSH_REPO=/path/to/other/deepseek-harness node boot-check.mjs
 */
const DSH_REPO = process.env.DSH_REPO ?? '/Users/user/Documents/code/deepseek-harness'
/* Dynamic import: the context has to come from the checkout DSH_REPO names, and a
   static import specifier cannot read the environment. */
const { Context } = await import(`${DSH_REPO}/vendor/cordis/lib/index.js`)

/* vendor/cordis/src/fiber.ts:147-152 */
const STATE = { 0: 'PENDING', 1: 'LOADING', 2: 'ACTIVE', 3: 'FAILED', 4: 'DISPOSED' }

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
 * Load the module the way the browser does: install a `window.__ModuleLoader__`
 * capture, import the real file, then call its factory with a module table we
 * control. Both degradation lanes are exercised: the mixer must survive the
 * primitives OR the store package being absent.
 * @param path - module path.
 * @param options - which optional externals the fake table serves.
 * @returns the captured plugin definition.
 */
async function loadDefinition(path, { withPrimitives = true, withStore = true } = {}) {
  let captured
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { captured = definition } },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = { querySelector: () => null, activeElement: null }
  await import(`${path}?t=${Date.now()}-${withPrimitives ? 'p' : 'n'}-${withStore ? 's' : 'x'}`)
  if (captured === undefined) throw new Error(`${path} never called __ModuleLoader__.load`)
  return captured.factory((name) => {
    if (name === 'react') return ReactStub
    /* `dsh.client.external` packages arrive through this table. */
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (!withPrimitives) throw new Error(`module "${name}" is not in the table`)
      return { StateDot: (props) => ({ type: 'svg', props: { 'data-state': props.state } }) }
    }
    if (name === '@deepseek-ai/dsh-client-store') {
      if (!withStore) throw new Error(`module "${name}" is not in the table`)
      return {
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
    }
    throw new Error(`unexpected require('${name}')`)
  })
}

function makeContext({ withCommandUi }) {
  const root = new Context()
  const registrations = []
  const commands = []
  root.provide('slots', {
    inject: (key, callback) => { callback() },
    register: (options) => { registrations.push(options); return () => {} },
  })
  root.provide('sessions', { retain: () => ({ ready: Promise.resolve(), release: () => {} }) })
  root.provide('layout', { selectPanel: () => {}, toggleSidebar: () => {} })
  root.provide('uiWorkspace', { startSession: () => {}, openWorkspace: () => {} })
  if (withCommandUi) {
    root.provide('commandUi', { register: (contribution) => { commands.push(contribution); return () => {} } })
  }
  return { root, registrations, commands }
}

/** Start a plugin the way the loader does; settle it and read the fiber state. */
async function start(root, definition) {
  let rejection = null
  const fiber = root.inject(definition.inject, (scope) => definition.apply(scope))
  try {
    await fiber
  } catch (thrown) {
    rejection = thrown && thrown.message ? thrown.message : String(thrown)
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  return { state: STATE[fiber.state] ?? fiber.state, rejection }
}

/* Control: the round-4 failure mode, in one line. It MUST fail as FAILED with the
   "without inject" message, or this check cannot detect the class of bug at all. */
const controlRoot = makeContext({ withCommandUi: false }).root
const control = await start(controlRoot, { inject: ['slots'], apply: (ctx) => { void ctx.commandUi } })

const path = new URL('./client.js', import.meta.url).pathname
const definition = await loadDefinition(path)
/* Same entry with one optional external missing at a time: the guarded requires must
   degrade, never fail the entry. */
const withoutPrimitives = await loadDefinition(path, { withPrimitives: false })
const withoutStore = await loadDefinition(path, { withStore: false })

async function boot({ withCommandUi }, loaded = definition) {
  const { root, registrations, commands } = makeContext({ withCommandUi })
  const outcome = await start(root, loaded)
  return { ...outcome, registrations, commands: commands.map(c => c.name) }
}

const results = {
  control_expectedToFail: control,
  cold_boot_without_commandUi: await boot({ withCommandUi: false }),
  boot_with_commandUi: await boot({ withCommandUi: true }),
  boot_without_primitives: await boot({ withCommandUi: true }, withoutPrimitives),
  boot_without_store: await boot({ withCommandUi: true }, withoutStore),
}
console.log(JSON.stringify(results, null, 2))

const expectedSlots = ['conversation.session.header.utilities', 'main']
const failures = []
if (control.state !== 'FAILED' || !(control.rejection || '').includes('without inject')) {
  failures.push('control did not reproduce the failure mode, this check proves nothing')
}
const cold = results.cold_boot_without_commandUi
if (cold.state !== 'ACTIVE' || cold.rejection !== null) {
  failures.push(`REGRESSION: cold boot without commandUi ended ${cold.state} (${cold.rejection})`)
}
if (cold.commands.length !== 0) failures.push('commandUi absent: the slash command should simply not register')
for (const slot of expectedSlots) {
  if (!cold.registrations.some(entry => entry.name === slot)) failures.push(`cold boot did not register ${slot}`)
}
const main = cold.registrations.find(entry => entry.name === 'main')
if (main === undefined) {
  failures.push('cold boot registered no main panel')
} else {
  const child = main.children === undefined ? undefined : main.children['mixer.channel']
  if (child === undefined || child.scope !== 'session') {
    failures.push('main panel lost its session-scoped child slot: every pane would render empty, silently')
  }
  if (main.store === undefined) failures.push('main panel lost its board store: the board would not persist')
}
for (const [label, outcome] of [['without ui-primitives', results.boot_without_primitives], ['without the store', results.boot_without_store]]) {
  if (outcome.state !== 'ACTIVE' || outcome.rejection !== null) {
    failures.push(`a missing module failed the entry (${label}): ${outcome.state} (${outcome.rejection})`)
  }
}
const warm = results.boot_with_commandUi
if (warm.state !== 'ACTIVE' || warm.rejection !== null) failures.push(`with commandUi the entry ended ${warm.state}`)
if (!warm.commands.includes('mixer')) failures.push('/mixer did not register when commandUi is present')

if (failures.length > 0) { console.error('FAIL:\n- ' + failures.join('\n- ')); process.exit(1) }
console.log('PASS: cold boot stays ACTIVE without commandUi, both slots and the store are declared, '
  + 'both optional modules degrade, and /mixer appears when commandUi arrives')
