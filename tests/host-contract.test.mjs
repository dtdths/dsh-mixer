/**
 * Host-contract drift sentinel.
 *
 * The plugin's every assumption about DSH is written down somewhere in this repo
 * (docs/spec.md §11), but prose does not fail when the host moves. This file turns
 * those assumptions into assertions that read the checkout named by `DSH_REPO`, so
 * pulling a new DSH branch and running `DSH_REPO=/that/checkout npm test` tells you
 * which contract moved, instead of leaving you to notice that a state dot is wrong.
 *
 * Read the nature of these checks carefully, because it bounds what they prove:
 *   - the platform-table check is REAL: it parses the shell's own source of truth and
 *     fails if a module we `require` is no longer shared into the frozen module table;
 *   - the inject-edge check is REAL: it fails if a package edge names a package that
 *     does not exist, or whose manifest name disagrees;
 *   - the rest are ANCHOR checks: exact snippets in the host that our code mirrors or
 *     depends on. They prove the host still contains the mechanism we verified, not
 *     that it still behaves the same. A hit means "re-read it"; a miss means "the
 *     host moved, re-verify before trusting the plugin".
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHost, loadPlugin } from './harness.mjs'

const DSH_REPO = process.env.DSH_REPO ?? '/Users/user/Documents/code/deepseek-harness'
const require = createRequire(import.meta.url)
const manifest = require('../package.json')
const client = manifest.dsh.client

const read = relative => readFileSync(`${DSH_REPO}/${relative}`, 'utf8').replaceAll('\r\n', '\n')

/**
 * Collect the string literals of an exported const array from a host module.
 * @param relative - path under the checkout.
 * @param name - the exported const to read.
 * @returns its string entries.
 */
function stringArray(relative, name) {
  const source = read(relative)
  const start = source.indexOf(`export const ${name} = [`)
  assert.ok(start >= 0, `${name} is gone from ${relative}`)
  const end = source.indexOf(']', start)
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1])
}

test('host contract: the shell still shares every module we require', () => {
  /* Source of truth for the frozen module table (the loader seeds from this list and
     packages/client/web/src/seed.ts imports every entry). */
  const platform = stringArray('packages/client/web/src/platform.ts', 'PLATFORM_MODULES')
  assert.ok(platform.length >= 5, 'PLATFORM_MODULES looks unexpectedly small')
  for (const name of client.external) {
    assert.ok(
      platform.includes(name),
      `dsh.client.external names ${name}, which the shell no longer shares into the module table`
        + ` (PLATFORM_MODULES: ${platform.join(', ')})`,
    )
  }
  /* The seed table is what the loader actually resolves against, so check it too. */
  const seed = read('packages/client/web/src/seed.ts')
  const body = seed.slice(seed.indexOf('export function getStaticModules'), seed.indexOf('} satisfies Record<PlatformModule, unknown>'))
  const seeded = [...body.matchAll(/^\s*'([^']+)':/gm)].map(match => match[1])
  for (const name of client.external) {
    assert.ok(seeded.includes(name), `seed.ts no longer serves a value for ${name}`)
  }
})

test('host contract: every inject edge names a real client package', () => {
  for (const edge of client.inject) {
    const dir = edge.replace('@deepseek-ai/dsh-client-', '').replace('@deepseek-ai/dsh-', '')
    const candidates = [
      `packages/client/${dir}/package.json`,
      `packages/api/${dir}/package.json`,
      `packages/boot/${dir}/package.json`,
    ]
    const found = candidates.find(relative => existsSync(`${DSH_REPO}/${relative}`))
    assert.ok(found !== undefined, `dsh.client.inject names ${edge}, which is no longer a package in the checkout`)
    assert.equal(
      JSON.parse(read(found)).name,
      edge,
      `${found} now declares a different package name than the inject edge ${edge}`,
    )
  }
})

test('plugin contract: every ctx.<service> the client reads is in the Cordis inject list', async () => {
  /* The 2026-10-15 incident this pins: `uiWorkspace` was dropped from `inject` while a
     click handler still read `ctx.uiWorkspace`. Nothing failed at boot — Cordis only
     throws `cannot get property "x" without inject` when the read actually happens, so
     the user saw a button that did nothing (docs/plugin-gotchas.md §1). This is a static
     check, and it is REAL: it fails on the exact edit that caused it.
     Cordis's own context members are not services and are allowed without an edge. */
  const CORDIS_MEMBERS = new Set([
    'effect', 'inject', 'on', 'get', 'set', 'provide', 'scope', 'dispose', 'is',
    'parallel', 'waterfall', 'bail', 'emit', 'start', 'stop', 'root', 'fiber',
  ])
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    /* Comments talk ABOUT this trap (`if (ctx.commandUi)` is the documented counter-
       example), so they must not count as reads. */
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1')
  const services = new Set()
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) services.add(match[1])
  /* `inject` here is the SHIPPED list: load it through the harness rather than copying. */
  const { definition } = await loadPlugin()
  const declared = definition.inject
  for (const name of services) {
    if (CORDIS_MEMBERS.has(name)) continue
    assert.ok(
      declared.includes(name),
      `client.js reads ctx.${name} but the module's inject list is [${declared.join(', ')}]:`
        + ' the read will throw "cannot get property'
        + ` \"${name}\" without inject"` + ' at click time, not at boot',
    )
  }
  /* …and the list must not keep edges nothing reads any more (the same edit in reverse,
     which would leave the entry waiting on a service it does not use). */
  for (const name of declared) {
    assert.ok(services.has(name), `the inject list declares ${name}, which client.js never reads`)
  }
})

test('host contract: the slot registry still offers the store and session-child seats we register with', () => {
  const slots = read('packages/client/ui-slots/src/index.ts')
  assert.match(slots, /store\?: StoreDecl/, 'the registration option `store` is gone: the board store could not be declared')

  const scoped = read('packages/client/ui-renderer/src/client/scoped-slots.tsx')
  assert.match(scoped, /kit\['useStore'\] = observableHook\(store\)/, 'a declared store no longer hands the component `useStore`')
  assert.match(scoped, /kit\['actions'\] = store\.actions/, 'a declared store no longer hands the component `actions`')
  assert.match(
    scoped,
    /kit\['SessionProvider'\] = scopeAreaProvider\(adapter\)/,
    'a non-root child scope no longer injects SessionProvider: every pane would render empty, silently',
  )
})

test('host contract: a root store instance is still created without a key (persist key unsuffixed)', () => {
  const registry = read('packages/client/ui-renderer/src/client/registry.ts')
  assert.match(
    registry,
    /record\.scope === 'root' \? handle\.create\(\) : handle\.create\(key\)/,
    'root/scope store instantiation changed: the persisted key may no longer be `dsh.mixer.v1`',
  )
})

test('host contract: the sidebar row state we mirror still comes from the same four facts', () => {
  const tree = read('packages/client/ui-workspace/src/client/tree.ts')
  assert.match(tree, /status\?\.running \?\? s\.running/, 'the running fallback (status ?? list row) moved')
  assert.match(tree, /status\?\.completionUnread === true/, 'the completed-unread source moved')
  assert.match(tree, /values\.subagentCatalog/, 'the subagent catalog projection moved: the second dot would stop lighting')

  const rows = read('packages/client/ui-workspace/src/client/rows/Rows.tsx')
  /* The four facts the row state is computed from, verbatim. (Some anchors below are
     intentionally "present somewhere in the file" rather than unique: the point is
     that the mechanism still exists, not that it occurs once.) */
  assert.match(
    rows,
    /node: Pick<SessionNode, 'pendingInteraction' \| 'running' \| 'runningSubagentCount' \| 'completed'>/,
    'the four facts behind the sidebar row state changed shape',
  )
  for (const kind of ['approval', 'plan-review', 'question']) {
    assert.match(rows, new RegExp(`case '${kind}'`), `the sidebar no longer treats ${kind} as visible waiting`)
  }
})

test('host contract: the turn navigator is still hidden by a container query we override', () => {
  const navigator = read('packages/client/ui-chat/src/client/chat/TurnNavigator.module.css')
  assert.match(navigator, /@container \(max-width: 900px\)/, 'the host breakpoint moved: RAIL_MIN_PANE_W needs re-deriving')
  assert.match(navigator, /container-type: inline-size/, 'the rail no longer establishes the container our @container rule targets')
})

test('host contract: the archive-undo we mirror still exists, with the same hold', () => {
  /* Our undo chip calls the same service method the sidebar's archived toast does
     (`undoArchive: unarchiveSession`), and holds the offer for the same 6 s. */
  const navigation = read('packages/client/ui-workspace/src/client/navigation.ts')
  assert.match(navigation, /unarchiveSession\(sessionId: SessionId\): Promise<void>/,
    'uiWorkspace.unarchiveSession moved: the mixer undo chip has nothing to call')
  const index = read('packages/client/ui-workspace/src/client/index.ts')
  assert.match(index, /undoArchive: unarchiveSession/,
    'the sidebar undo no longer maps to unarchiveSession: the mixer would drift from the host action')
  const toast = read('packages/client/ui-workspace/src/client/session-actions/RowActionToast.tsx')
  assert.match(toast, /LONG_TOAST_HOLD_MS = 6000/,
    'the archived-toast hold moved: ARCHIVE_UNDO_MS mirrors this number')
  const locales = read('packages/client/ui-workspace/src/client/locales.ts')
  assert.match(locales, /'toast\.archivedUndo': '撤销'/, 'the host undo wording moved')
})

test('host contract: the shortcut registry we bind channel jumps with still looks the same', () => {
  /* §5.6: the plugin registers 11 commands against this registry. If the shape moves, the
     jumps either stop binding or stop being rebindable — both silent from the UI. */
  const types = read('packages/client/shortcuts/src/client/types.ts')
  assert.match(types, /register\(command: ShortcutCommand\): \(\) => void/,
    'Shortcuts.register moved: the channel jumps would stop binding')
  assert.match(types, /export interface ShortcutCommand \{/, 'ShortcutCommand moved')
  assert.match(types, /readonly regions: readonly ShortcutRegion\[\]/, 'the regions field moved')
  assert.match(types, /export type ShortcutRegion = 'page' \| 'editable' \| 'terminal'/,
    'the regions we register for moved')
  assert.match(types, /readonly modals: readonly string\[\]/, 'the modals field moved')
})

test('host contract: the host registry accepts every shortcut default we register', async (t) => {
  /* The 2026-10-20 boot failure this pins: `primary+alt+ArrowRight` is reserved on
     Desktop Linux, and `ShortcutRegistry.register` validates every declared default for
     ALL five profiles regardless of the device in use — so it threw
     `Reserved shortcut default: mixer.channel.next` and the whole entry went FAILED
     (`web boot: 1 entry did not activate`). The fake registry in `tests/harness.mjs`
     accepts anything, so only the host's own rules can catch this. They are executed
     from the checkout (Node >= 22.18 strips the types); older Node skips. */
  const source = `${DSH_REPO}/packages/client/shortcuts/src`
  let rules
  try {
    rules = {
      ...(await import(pathToFileURL(`${source}/binding.ts`).href)),
      ...(await import(pathToFileURL(`${source}/configuration.ts`).href)),
    }
  } catch (error) {
    if (error.code === 'ERR_UNKNOWN_FILE_EXTENSION' || error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
      t.skip(`this Node cannot import the host's TypeScript sources (${error.code})`)
      return
    }
    throw error
  }

  const { definition } = await loadPlugin()
  const { shortcutCommands } = createHost(definition)
  const profiles = [
    ['desktop', 'macos'], ['desktop', 'windows'], ['desktop', 'linux'],
    ['web', 'macos'], ['web', 'windows'],
  ]
  assert.equal(shortcutCommands.length, 11, 'cold boot must register all 11 channel jumps')

  for (const [runtime, platform] of profiles) {
    const accepted = []
    for (const command of shortcutCommands) {
      const declared = rules.resolveShortcutDefault(command, runtime, platform)
      if (declared === undefined) continue
      const label = `${command.id} = ${declared.code} on ${runtime}:${platform}`
      const binding = rules.normalizeBinding(declared, platform)
      if (runtime === 'web') {
        assert.ok(rules.isWebBindingAllowed(binding, platform),
          `${label}: the host throws \`Unsupported Web shortcut\` at registration`)
      }
      assert.equal(rules.bindingIssue(binding, runtime, platform), null,
        `${label}: the host throws \`Reserved shortcut default\` at registration, failing the entry at cold boot`)
      /* register() also rejects two of OUR commands sharing one combination. */
      for (const other of accepted) {
        assert.ok(!rules.overlappingBindings(binding, other.binding),
          `${label} collides with ${other.command.id} on ${runtime}:${platform}`)
      }
      accepted.push({ command, binding })
    }
  }
})
