/**
 * Seam tests for the mixer. Everything here runs in node against the shipped
 * client.js (tests/harness.mjs loads it with a fake module table), so the pure
 * decisions the UI depends on are pinned without a browser.
 *
 * The state expectations are copied from the host's own sidebar row
 * (`ui-workspace/src/client/rows/Rows.tsx:347-397`), which is the whole point of
 * channelState: the pane and its sidebar row must never disagree.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPlugin } from './harness.mjs'

const { seams } = await loadPlugin()
const {
  channelState,
  visiblePendingKind,
  runningSubagentCount,
  subagentCatalogOf,
  normalizeBoard,
  createChannelLedger,
  moveChannel,
  heroFor,
  blankTargetFor,
  shouldReclaimPanel,
  archiveActivityOf,
  resizedWeights,
  crumbsFor,
  createBoardStore,
} = seams

const stateOf = input => channelState({
  pendingKind: undefined, running: false, subagents: 0, completed: false, ...input,
})

test('channelState: waiting owns the stripe, so it renders no primary dot', () => {
  const state = stateOf({ pendingKind: 'approval' })
  assert.equal(state.key, 'waiting')
  assert.deepEqual(state.dots, [])
})

test('channelState: a running subagent is CO-displayed beside waiting, not instead of it', () => {
  const state = stateOf({ pendingKind: 'plan-review', subagents: 3 })
  assert.equal(state.key, 'subagents')
  assert.equal(state.dots.length, 1)
  assert.equal(state.dots[0].state, 'ongoing')
  assert.equal(state.dots[0].label, '3 个子智能体运行中')
})

test('channelState: running then subagents, two dots, main one larger', () => {
  const state = stateOf({ running: true, subagents: 1 })
  assert.equal(state.key, 'running+subagents')
  assert.deepEqual(state.dots.map(dot => [dot.key, dot.state, dot.size]), [
    ['running', 'ongoing', 12],
    ['subagents', 'ongoing', 10],
  ])
})

test('channelState: waiting outranks running and completed', () => {
  assert.equal(stateOf({ pendingKind: 'question', running: true, completed: true }).key, 'waiting')
})

test('channelState: subagents alone are the primary state', () => {
  const state = stateOf({ subagents: 2 })
  assert.equal(state.key, 'subagents')
  assert.deepEqual(state.dots.map(dot => dot.size), [12])
})

test('channelState: completed is the green dot', () => {
  const state = stateOf({ completed: true })
  assert.equal(state.key, 'completed')
  assert.deepEqual(state.dots.map(dot => [dot.state, dot.label]), [['done', '已完成']])
})

test('channelState: idle renders nothing but still names the state', () => {
  const state = stateOf({})
  assert.equal(state.key, 'idle')
  assert.deepEqual(state.dots, [])
})

test('visiblePendingKind: only the three kinds the sidebar shows', () => {
  assert.equal(visiblePendingKind({ pendingInteraction: { kind: 'approval' } }), 'approval')
  assert.equal(visiblePendingKind({ pendingInteraction: { kind: 'plan-review' } }), 'plan-review')
  assert.equal(visiblePendingKind({ pendingInteraction: { kind: 'question' } }), 'question')
  assert.equal(visiblePendingKind({ pendingInteraction: { kind: 'some-domain-signal' } }), undefined)
  assert.equal(visiblePendingKind({}), undefined)
  assert.equal(visiblePendingKind(undefined), undefined)
})

test('runningSubagentCount: counts through the supplied predicate only', () => {
  assert.equal(runningSubagentCount(undefined, () => true), 0)
  assert.equal(runningSubagentCount([{ id: 'a' }, { id: 'b' }], child => child.id === 'b'), 1)
  assert.equal(runningSubagentCount([{ id: 'a' }], () => false), 0)
})

test('subagentCatalogOf: every missing layer means "no subagents"', () => {
  assert.deepEqual(subagentCatalogOf(undefined, 'a'), [])
  assert.deepEqual(subagentCatalogOf({}, 'a'), [])
  assert.deepEqual(subagentCatalogOf({ projectionsBySession: {} }, 'a'), [])
  assert.deepEqual(subagentCatalogOf({ projectionsBySession: { a: {} } }, 'a'), [])
  assert.deepEqual(subagentCatalogOf({ projectionsBySession: { a: { values: {} } } }, 'a'), [])
  assert.deepEqual(
    subagentCatalogOf({ projectionsBySession: { a: { values: { subagentCatalog: [{ id: 'b' }] } } } }, 'a'),
    [{ id: 'b' }],
  )
})

test('normalizeBoard: bad data falls back, field by field', () => {
  assert.deepEqual(normalizeBoard(undefined), { channels: [], weights: {} })
  assert.deepEqual(normalizeBoard('garbage'), { channels: [], weights: {} })
  assert.deepEqual(normalizeBoard({ channels: 'nope', weights: 7 }), { channels: [], weights: {} })
  assert.deepEqual(
    normalizeBoard({ channels: ['a', 'a', '', 5, null, 'b'], weights: { a: 2, b: 'x', c: 3 } }),
    { channels: ['a', 'b'], weights: { a: 2, c: 3 } },
  )
  assert.deepEqual(
    normalizeBoard({ channels: ['a'], weights: { a: Number.NaN } }),
    { channels: ['a'], weights: {} },
  )
  assert.deepEqual(
    normalizeBoard({ channels: ['a'], weights: { a: -1 } }),
    { channels: ['a'], weights: {} },
  )
  /* Weights of Sessions that are not channels right now survive: a channel closed
     with the x must come back at the same proportions (spec §4.1). */
  assert.deepEqual(normalizeBoard({ channels: ['a'], weights: { b: 4 } }), { channels: ['a'], weights: { b: 4 } })
  assert.deepEqual(normalizeBoard({ channels: [], weights: { b: 4, '': 2, c: 'x' } }), { channels: [], weights: { b: 4 } })
})

test('moveChannel: reorder inside the track corrects the removed cell', () => {
  assert.deepEqual(moveChannel(['a', 'b', 'c'], 'a', 3), ['b', 'c', 'a'])
  assert.deepEqual(moveChannel(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b'])
  /* Dropped back onto its own slot: the cell it would be removed from is compensated,
     so the list is unchanged. */
  assert.deepEqual(moveChannel(['a', 'b', 'c'], 'b', 1), ['a', 'b', 'c'])
  assert.deepEqual(moveChannel(['a', 'b', 'c'], 'b', 2), ['a', 'b', 'c'])
})

test('moveChannel: a Session dragged in from the sidebar is inserted', () => {
  assert.deepEqual(moveChannel(['a', 'b'], 'z', 0), ['z', 'a', 'b'])
  assert.deepEqual(moveChannel(['a', 'b'], 'z', 1), ['a', 'z', 'b'])
  assert.deepEqual(moveChannel(['a', 'b'], 'z', 9), ['a', 'b', 'z'])
})

test('resizedWeights: proportional, both sides clammped at MIN_PANE_W', () => {
  const drag = { startX: 0, contentWidth: 1000, total: 2, beforeWeight: 1, afterWeight: 1 }
  const right = resizedWeights(drag, 100)
  assert.equal(right.beforeWeight, 1.2)
  assert.equal(right.afterWeight, 0.8)
  /* floor = total * (380 / contentWidth) = 0.76 for each side */
  const clampedLeft = resizedWeights(drag, -500)
  assert.equal(Number(clampedLeft.beforeWeight.toFixed(4)), 0.76)
  assert.equal(Number(clampedLeft.afterWeight.toFixed(4)), 1.24)
  const clampedRight = resizedWeights(drag, 500)
  assert.equal(Number(clampedRight.afterWeight.toFixed(4)), 0.76)
  assert.equal(Number(clampedRight.beforeWeight.toFixed(4)), 1.24)
})

test('crumbsFor: ancestry, unknown ids, cycles and the six-level cap', () => {
  const summaries = {
    child: { displayTitle: '子', parentId: 'parent' },
    parent: { displayTitle: '父', parentId: undefined },
  }
  assert.deepEqual(crumbsFor(summaries, 'child'), [
    { id: 'parent', title: '父' },
    { id: 'child', title: '子' },
  ])
  assert.deepEqual(crumbsFor({}, 'abcdefghij'), [{ id: 'abcdefghij', title: 'abcdefgh' }])
  const cycle = { a: { displayTitle: 'A', parentId: 'b' }, b: { displayTitle: 'B', parentId: 'a' } }
  assert.deepEqual(crumbsFor(cycle, 'a').map(crumb => crumb.id), ['b', 'a'])
  let deep = {}
  for (let index = 0; index < 9; index += 1) {
    deep[`s${index}`] = { displayTitle: `S${index}`, parentId: index === 0 ? undefined : `s${index - 1}` }
  }
  assert.equal(crumbsFor(deep, 's8').length, 6)
})

test('createBoardStore: one persisted root board with three write actions', () => {
  const handle = createBoardStore()
  assert.equal(handle.spec.persist, 'dsh.mixer.v1')
  const draft = handle.spec.init()
  assert.deepEqual(draft, { channels: [], weights: {} })
  handle.spec.actions.setChannels(draft, ['a', 'b'])
  handle.spec.actions.setWeights(draft, { a: 2, b: 1 })
  assert.deepEqual(draft, { channels: ['a', 'b'], weights: { a: 2, b: 1 } })
  /* dropWeights removes exactly the Sessions that are really gone, so a channel
     closed with the x keeps its width. */
  handle.spec.actions.dropWeights(draft, ['a'])
  assert.deepEqual(draft.weights, { b: 1 })
  assert.deepEqual(draft.channels, ['a', 'b'])
})

test('archiveActivityOf: only the Host\'s running-work refusal, by error NAME', () => {
  /* The host's own check (ui-workspace/index.ts:326) goes by name on purpose. */
  const refusal = Object.assign(new Error('active'), {
    name: 'WorkspaceArchiveError',
    rpcError: { code: 'workspace/session-active', details: { activity: [{ kind: 'running' }] } },
  })
  assert.deepEqual(archiveActivityOf(refusal), [{ kind: 'running' }])
  /* Same refusal without an activity list is still a refusal. */
  const bare = Object.assign(new Error('active'), {
    name: 'WorkspaceArchiveError',
    rpcError: { code: 'workspace/session-active' },
  })
  assert.deepEqual(archiveActivityOf(bare), [])
  /* Any other failure is a plain failure, not a stop-and-archive offer. */
  assert.equal(archiveActivityOf(new Error('nope')), undefined)
  assert.equal(archiveActivityOf(Object.assign(new Error('x'), { name: 'WorkspaceArchiveError' })), undefined)
  assert.equal(archiveActivityOf(Object.assign(new Error('x'), {
    name: 'WorkspaceArchiveError',
    rpcError: { code: 'workspace/unknown' },
  })), undefined)
  assert.equal(archiveActivityOf(undefined), undefined)
  assert.equal(archiveActivityOf('boom'), undefined)
  assert.equal(archiveActivityOf({ name: 'WorkspaceArchiveError' }), undefined)
})

/*
 * Requirement 1 (spec §4.4): an empty channel must be handed the host's hero phase,
 * because that phase is what centres the composer. Pinning `hero: false` is the bug
 * this replaces, so the fallbacks matter as much as the hero case.
 */
test('heroFor: a blank Session gets the host hero phase, everything else stays docked', () => {
  assert.deepEqual(heroFor({ blank: true }), { phase: 'hero', hero: true })
  assert.deepEqual(heroFor({ blank: false }), { phase: 'active', hero: false })
  /* An unknown row is not hero on purpose: one frame of the wrong layout is worse
     than the docked bar. */
  assert.deepEqual(heroFor(undefined), { phase: 'active', hero: false })
  assert.deepEqual(heroFor(null), { phase: 'active', hero: false })
  assert.deepEqual(heroFor({}), { phase: 'active', hero: false })
})

/*
 * Spec §4.1, the two bugs this ledger exists for: a channel pruned the instant it was
 * created, and a channel pruned again right after its archive was undone.
 */
test('createChannelLedger: exemptions graduate when the host agrees, and prune once', () => {
  const ledger = createChannelLedger()
  const board = ['s1', 's2']

  /* A freshly created id is briefly absent from the host list: it must survive. */
  ledger.note('new', 'born')
  assert.deepEqual(ledger.survivors(['new', 's1'], ['s1'], []), ['new', 's1'])
  /* …and stops being exempt the moment its row lands. */
  ledger.graduate(['new', 's1'], [])
  assert.equal(ledger.reasonOf('new'), undefined)
  assert.deepEqual(ledger.survivors(['new', 's1'], ['s1'], []), ['s1'])

  /* A just-unarchived id is still called archived by the host snapshot: it must survive
     that snapshot, and its width must survive too. */
  ledger.note('back', 'returned')
  assert.deepEqual(ledger.survivors(['back', 's1'], ['back', 's1'], ['back']), ['back', 's1'])
  assert.deepEqual(ledger.staleWeights({ s1: 1, back: 2, gone: 3 }, ['back', 's1'], ['back', 'gone']), ['gone'])
  /* The exemption ends once the snapshot stops calling it archived. */
  ledger.graduate(['back', 's1'], [])
  assert.equal(ledger.reasonOf('back'), undefined)

  /* Realities the ledger keeps honouring: an empty host list prunes nothing, an archived
     id is gone, and a channel put away with the x keeps its width. */
  assert.deepEqual(ledger.survivors(board, [], ['s1']), board)
  assert.deepEqual(ledger.survivors(board, ['s1', 's2'], ['s1']), ['s2'])
  assert.deepEqual(ledger.staleWeights({ s1: 1, gone: 2 }, ['s1'], []), ['gone'])
})

/*
 * Requirement 2 (spec §4.1): "new session" reuses a blank Session of the workspace
 * whose row was clicked before creating one, mirroring the host's reuseOrCreateBlank.
 */
test('blankTargetFor: reuses a listed, unarchived blank Session of that workspace only', () => {
  const workspace = { workspaceId: 'w1', path: '/a', sessionIds: ['b1', 'b2', 's1'] }
  const base = {
    ids: ['s1', 'b1', 'b2'],
    byId: {
      s1: { id: 's1', blank: false, cwd: '/a' },
      b1: { id: 'b1', blank: true, cwd: '/a' },
      b2: { id: 'b2', blank: true, cwd: '/other' },
    },
  }
  assert.equal(blankTargetFor(base, workspace, []), 'b1')
  /* The blank Session was archived: it is gone, do not reuse it. */
  assert.equal(blankTargetFor(base, workspace, ['b1']), undefined)
  /* A blank Session of another directory, or outside the workspace's own list, is
     not ours to reuse. */
  assert.equal(blankTargetFor({ ids: ['b2'], byId: base.byId }, workspace, []), undefined)
  assert.equal(blankTargetFor(base, { ...workspace, sessionIds: ['s1'] }, []), undefined)
  /* No target workspace, no list, or no blank row: create instead of reusing. */
  assert.equal(blankTargetFor(base, undefined, []), undefined)
  assert.equal(blankTargetFor(undefined, workspace, []), undefined)
  assert.equal(blankTargetFor({ ids: ['s1'], byId: base.byId }, workspace, []), undefined)
})

/*
 * Requirement 2 (spec §5.1 / ADR-0003): reclaiming the centre panel must fire ONLY on
 * the host's new-session transition. A user leaving on purpose blanks the panel through
 * the very same `replaceMain(…, 'reveal')`, so the "the host revealed a Session with no
 * history" half carries all the weight — and it must cover the REUSE branch, which is
 * why blankness, not novelty, is the marker.
 */
test('shouldReclaimPanel: only a revealed blank Session, never a plain exit', () => {
  const fire = { leftMixer: true, activePanelId: null, revealed: { id: 'n1', blank: true } }
  assert.equal(shouldReclaimPanel(fire), true)
  /* The host reused an existing blank Session: no new id at all, still our case. */
  assert.equal(shouldReclaimPanel({ ...fire, revealed: { id: 'old', blank: true } }), true)
  /* A sidebar row click reveals a Session that has history: stay out. */
  assert.equal(shouldReclaimPanel({ ...fire, revealed: { id: 's1', blank: false } }), false)
  /* Nothing revealed at all. */
  assert.equal(shouldReclaimPanel({ ...fire, revealed: undefined }), false)
  /* The mixer was not the panel that just went away. */
  assert.equal(shouldReclaimPanel({ ...fire, leftMixer: false }), false)
  /* Another panel was selected in between (plugins/schedules): not our business. */
  assert.equal(shouldReclaimPanel({ ...fire, activePanelId: 'plugins' }), false)
  /* Missing/garbage input must not throw or reclaim. */
  assert.equal(shouldReclaimPanel({}), false)
  assert.equal(shouldReclaimPanel({ leftMixer: true, activePanelId: null }), false)
  assert.equal(shouldReclaimPanel({ ...fire, revealed: { blank: true } }), false)
  assert.equal(shouldReclaimPanel({ ...fire, revealed: { id: '', blank: true } }), false)
  assert.equal(shouldReclaimPanel({ ...fire, revealed: { id: 'n1' } }), false)
})
