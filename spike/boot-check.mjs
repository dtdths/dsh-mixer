/**
 * Cold-boot guard for spike/client.js. Run: node spike/boot-check.mjs
 *
 * Why this exists (round-4 incident, 2026-10-14): `apply()` read `ctx.commandUi`
 * directly, guarded with `!== undefined`. In Cordis, reading a service that the
 * fiber did not inject THROWS ("cannot get property \"commandUi\" without
 * inject"), so the guard never ran. The fiber went FAILED and the host boot audit
 * rejected startup with "web boot: 1 entry did not activate:
 * dsh-mixer-spike: failed" -- the whole Harness page.
 *
 * A "it worked when I smoke tested" claim was possible because a stub ctx always
 * had the property, and HMR re-applies only after every service is up. So this
 * check starts the real module through a real Cordis Context the way the loader
 * does, reads the fiber state, and carries an inline control that reproduces the
 * exact failure mode: if the control stops failing, this check is not proving
 * anything and will say so.
 */
import { Context } from '/Users/user/Documents/code/deepseek-harness/vendor/cordis/lib/index.js'

/* vendor/cordis/src/fiber.ts:147-152 */
const STATE = { 0: 'PENDING', 1: 'LOADING', 2: 'ACTIVE', 3: 'FAILED', 4: 'DISPOSED' }

const ReactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}

async function loadDefinition(path) {
  let captured
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { captured = definition } },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = { querySelector: () => null, activeElement: null }
  await import(`${path}?t=${Date.now()}`)
  if (captured === undefined) throw new Error(`${path} never called __ModuleLoader__.load`)
  return captured.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected require('${name}')`)
  })
}

function makeContext({ withCommandUi }) {
  const root = new Context()
  const registrations = []
  const commands = []
  root.provide('slots', {
    inject: (key, callback) => { callback() },
    register: (options) => { registrations.push(options.name); return () => {} },
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

const definition = await loadDefinition(new URL('./client.js', import.meta.url).pathname)

async function boot({ withCommandUi }) {
  const { root, registrations, commands } = makeContext({ withCommandUi })
  const outcome = await start(root, definition)
  return { ...outcome, registrations, commands: commands.map(c => c.name) }
}

const results = {
  control_expectedToFail: control,
  cold_boot_without_commandUi: await boot({ withCommandUi: false }),
  boot_with_commandUi: await boot({ withCommandUi: true }),
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
  if (!cold.registrations.includes(slot)) failures.push(`cold boot did not register ${slot}`)
}
const warm = results.boot_with_commandUi
if (warm.state !== 'ACTIVE' || warm.rejection !== null) failures.push(`with commandUi the entry ended ${warm.state}`)
if (!warm.commands.includes('mixer')) failures.push('/mixer did not register when commandUi is present')

if (failures.length > 0) { console.error('FAIL:\n- ' + failures.join('\n- ')); process.exit(1) }
console.log('PASS: cold boot without commandUi stays ACTIVE and registers both slots; /mixer appears when it arrives')
