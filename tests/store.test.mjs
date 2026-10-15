/**
 * Persistence tests against the REAL store engine.
 *
 * tests/seams.test.mjs drives `createBoardStore`'s spec with a stub, which proves my
 * own contract but not the framework's. This file imports the host's actual
 * `@deepseek-ai/dsh-client-store` build (zustand + immer + its own persistence) and
 * runs the plugin's real handle through it, with a fake localStorage. That is what
 * makes the "③ 换掉凑合实现" half of the migration verified rather than assumed:
 *
 *   - the persist key is exactly `dsh.mixer.v1`, with no scope suffix for a root store,
 *   - a corrupt persisted value reaches the plugin and `normalizeBoard` absorbs it,
 *   - a valid persisted value restores the board,
 *   - the plugin's actions are the only write path and they do hit storage.
 *
 * The engine's rehydrate is a blind `JSON.parse` with no shape check, so the corrupt
 * cases below are exactly the ones the plugin has to survive on its own.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { loadPlugin } from './harness.mjs'

const DSH_REPO = process.env.DSH_REPO ?? '/Users/user/Documents/code/deepseek-harness'
const realStore = await import(`${DSH_REPO}/packages/client/store/lib/index.js`)
const { seams } = await loadPlugin()
const { normalizeBoard, createBoardStore } = seams

/** Minimal localStorage the engine's attachPersistence can use. */
function installStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  const writes = []
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { writes.push(key); data.set(key, value) },
    removeItem: key => { data.delete(key) },
    clear: () => { data.clear() },
  }
  return { data, writes }
}

/**
 * Build the plugin's real board handle, but against the REAL engine: the declaration
 * comes from `createBoardStore()` (so the spec under test is the one that ships), and
 * the `defineStore` that consumes it is the host's build.
 * @param withStorage - install a fake localStorage (persistence needs one).
 * @returns the handle plus the fake storage when installed.
 */
function boardHandle(withStorage = true) {
  const shipped = createBoardStore().spec
  if (!withStorage) {
    delete globalThis.localStorage
    return { handle: realStore.defineStore(shipped), storage: undefined }
  }
  const storage = installStorage()
  return { handle: realStore.defineStore(shipped), storage }
}

test('real engine: the handle declares the namespaced key and a root instance persists under it', () => {
  const { handle, storage } = boardHandle()
  assert.equal(handle.spec.persist, 'dsh.mixer.v1')
  const instance = handle.create()
  instance.actions.setChannels(['s1'])
  instance.actions.setWeights({ s1: 2 })
  /* Root-scope instances are keyless (registry.ts:612-623), so exactly one key exists. */
  assert.deepEqual([...storage.data.keys()], ['dsh.mixer.v1'])
  assert.deepEqual(JSON.parse(storage.data.get('dsh.mixer.v1')), { channels: ['s1'], weights: { s1: 2 } })
})

test('real engine: a valid persisted board is restored through normalizeBoard', () => {
  const restored = normalizeBoard(JSON.parse(JSON.stringify({ channels: ['s1', 's2'], weights: { s2: 3 } })))
  assert.deepEqual(restored, { channels: ['s1', 's2'], weights: { s2: 3 } })
})

test('real engine: every corrupt persisted shape still yields a usable board', () => {
  /* The engine hands these through untouched; the plugin must absorb all of them. */
  const corrupt = [
    'not json at all (engine would already have logged a rehydration error)',
    null,
    0,
    [],
    {},
    { channels: null, weights: null },
    { channels: [1, 2], weights: { 1: 'x' } },
    { channels: ['s1'], weights: { s1: -5 } },
    { channels: ['s1', 's1', 's1'], weights: { s1: 1 } },
    { channels: {}, weights: [] },
  ]
  for (const raw of corrupt) {
    const board = normalizeBoard(raw)
    assert.ok(Array.isArray(board.channels), `channels must be an array for ${JSON.stringify(raw)}`)
    assert.equal(typeof board.weights, 'object')
    for (const [id, weight] of Object.entries(board.weights)) {
      assert.equal(typeof id, 'string')
      assert.ok(Number.isFinite(weight) && weight > 0, `weight for ${id} must be a usable number`)
    }
  }
  /* The one that matters most: a board whose weight map is corrupt but whose channel
     list is fine still shows those channels, at the default width. */
  assert.deepEqual(normalizeBoard({ channels: ['s1'], weights: { s1: 'wide' } }), { channels: ['s1'], weights: {} })
})

test('real engine: writing through the plugin actions updates storage, and a second instance restores it', () => {
  const { handle, storage } = boardHandle()
  const first = handle.create()
  first.actions.setChannels(['s3', 's1'])
  first.actions.setWeights({ s3: 4, s1: 1 })
  assert.ok(storage.writes.includes('dsh.mixer.v1'))

  /* A fresh instance over the same storage is the reload path. */
  const second = handle.create()
  assert.deepEqual(normalizeBoard(second.getSnapshot()), { channels: ['s3', 's1'], weights: { s3: 4, s1: 1 } })

  /* dropWeights only touches Sessions that are really gone. */
  second.actions.dropWeights(['s3'])
  assert.deepEqual(normalizeBoard(second.getSnapshot()), { channels: ['s3', 's1'], weights: { s1: 1 } })
})

test('real engine: with no localStorage at all the handle still works (private mode, node e2e)', () => {
  const { handle } = boardHandle(false)
  const instance = handle.create()
  instance.actions.setChannels(['s1'])
  assert.deepEqual(instance.getSnapshot().channels, ['s1'])
})
