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
