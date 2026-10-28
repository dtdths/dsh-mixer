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
  createHostCalls,
  createChannelDom,
  createViewState,
  moveChannel,
  heroFor,
  blankTargetFor,
  shouldReclaimPanel,
  exitTargetOf,
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
 * Spec §9.0j: the channel DOM vocabulary had no owner — "find the channel", "which channel
 * has the caret" and "focus its field" were hand-written three times.
 */
test('createChannelDom: one owner for channel lookup, caret and focus', () => {
  const focused = []
  const selections = []
  const ranges = []
  const fieldFor = () => ({ focus: () => focused.push('field') })
  /* The two composer shapes: a plain field whose caret must land after the draft, and the
     host's rich contenteditable whose Range must collapse at the end of its contents. */
  const typedField = {
    value: '草稿两行',
    focus: () => focused.push('typed'),
    setSelectionRange: (start, end) => selections.push([start, end]),
  }
  const richField = {
    isContentEditable: true,
    focus: () => focused.push('rich'),
  }
  const richPane = {
    getAttribute: () => 'c',
    querySelector: selector => (selector === '[contenteditable="true"]' ? richField : null),
    closest: () => null,
  }
  const typedPane = {
    getAttribute: () => 't',
    querySelector: selector => (selector === 'input, textarea' ? typedField : null),
    closest: () => null,
  }
  const paneFor = id => ({
    getAttribute: name => (name === 'data-mixer-pane' ? id : null),
    querySelector: selector => (selector === '[contenteditable="true"]' ? fieldFor() : null),
    closest: selector => (selector === '[data-mixer-cell]' ? null : null),
  })
  const paneA = paneFor('a')
  const paneB = paneFor('b')
  const fieldB = { closest: selector => (selector === '[data-mixer-pane]' ? paneB : null) }
  const doc = {
    querySelectorAll: selector => (selector === '[data-mixer-pane]' ? [paneA, paneB, typedPane, richPane] : []),
    activeElement: fieldB,
    createRange: () => ({
      selectNodeContents: node => ranges.push(['select', node]),
      collapse: atEnd => ranges.push(['collapse', atEnd]),
    }),
    getSelection: () => ({ removeAllRanges: () => ranges.push(['remove']), addRange: () => ranges.push(['add']) }),
  }
  const dom = createChannelDom(doc)

  /* Which channel an element belongs to (and nothing when it belongs to none). */
  assert.equal(dom.channelOf(fieldB), 'b')
  assert.equal(dom.channelOf({ closest: () => null }), undefined)
  assert.equal(dom.channelOf(null), undefined)
  assert.equal(dom.caretChannel(), 'b')

  /* Focus reveals first and reports whether the field was there at all: the panel's
     frame retry depends on that `false`. */
  assert.equal(dom.focus('a'), true)
  assert.equal(focused.length, 1)
  assert.equal(dom.focus('missing'), false)
  assert.equal(focused.length, 1)

  /* Jumping to a channel continues the draft: the caret lands AFTER the existing text,
     in both composer shapes (user feedback 2026-10-21). */
  assert.equal(dom.focus('t'), true)
  assert.deepEqual(selections, [[typedField.value.length, typedField.value.length]])
  assert.equal(dom.focus('c'), true)
  assert.deepEqual(ranges.filter(step => step[0] === 'collapse'), [['collapse', false]])

  /* Without a document (server rendering) every read is empty instead of throwing. */
  const headless = createChannelDom({})
  assert.equal(headless.caretChannel(), undefined)
  assert.equal(headless.focus('a'), false)
})

/*
 * Spec §9.0j: solo / 移出 / 重挂交接 were six handles with no way to announce a change,
 * so the panel mirrored them and a second writer could forget the mirror.
 */
test('createViewState: one module owns solo, put-away and the remount hand-off', () => {
  const view = createViewState()
  let notifications = 0
  const stop = view.subscribe(() => { notifications += 1 })

  assert.deepEqual(view.snapshot(), { solo: undefined, parked: [], firstInLine: undefined })

  /* Solo is one value: setting the same id again is not a change. */
  view.setSolo('s1')
  view.setSolo('s1')
  assert.equal(notifications, 1)
  assert.equal(view.snapshot().solo, 's1')

  /* Put away is a set, and its mutations announce themselves — the bar no longer updates
     only because an unrelated board write happened to notify. */
  view.park('s2')
  view.park('s2')
  assert.deepEqual(view.parkedIds(), ['s2'])
  assert.equal(notifications, 2)
  view.unpark('gone')
  assert.equal(notifications, 2)
  view.unpark('s2')
  assert.equal(notifications, 3)
  view.park('s3')
  view.clearParked()
  assert.deepEqual(view.parkedIds(), [])
  assert.equal(notifications, 5)

  /* The remount hand-off is read exactly once (ADR-0003). */
  view.handOff('s9')
  assert.equal(view.take(), 's9')
  assert.equal(view.take(), undefined)

  /* Publishing the channel order and jump commands never notifies: it happens on every
     render, and a notification there would schedule another render. */
  const before = notifications
  view.publish(['s1'], { focus: () => {}, step: () => {} })
  assert.equal(notifications, before)
  assert.deepEqual(view.channels(), ['s1'])

  stop()
  view.setSolo(undefined)
  assert.equal(notifications, before)
})

/*
 * Spec §5.2: one runner owns "a click must never do nothing". Each failure mode is
 * proved here once, instead of once per host action.
 */
test('createHostCalls: missing method, sync throw, rejection and refusal all report', async () => {
  const notices = []
  const pending = []
  const confirmations = []
  const run = createHostCalls({
    notify: text => notices.push(text),
    pending: id => pending.push(id),
  })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  /* The service method is not there at all. */
  run({ label: '归档', available: false, unavailable: '归档不可用：宿主没有提供 archiveSession', call: () => undefined })
  assert.deepEqual(notices, [undefined, '归档不可用：宿主没有提供 archiveSession'])
  assert.deepEqual(pending, [])

  /* A synchronous throw is the exact shape of "I clicked and nothing happened". */
  notices.length = 0
  run({ label: '归档', pendingId: 's1', call: () => { throw new TypeError('boom') } })
  assert.equal(notices[notices.length - 1], '归档失败：boom')
  assert.deepEqual(pending, ['s1', undefined])

  /* A rejection, with the in-flight marker cleared on the way out. */
  notices.length = 0
  pending.length = 0
  run({ label: '新建会话', call: () => Promise.reject(new Error('writer held')) })
  await settle()
  assert.equal(notices[notices.length - 1], '新建会话失败：writer held')

  /* A refusal the site understands becomes an offer, not an error line. */
  notices.length = 0
  run({
    label: '归档',
    call: () => Promise.reject(Object.assign(new Error('session active'), {
      name: 'WorkspaceArchiveError',
      rpcError: { code: 'workspace/session-active' },
    })),
    confirmWhen: reason => archiveActivityOf(reason) !== undefined,
    onConfirm: () => confirmations.push('s1'),
  })
  await settle()
  assert.deepEqual(confirmations, ['s1'])
  assert.deepEqual(notices, [undefined])

  /* Success hands the result to the site and clears the pending marker. */
  pending.length = 0
  let done
  run({ label: '归档', pendingId: 's2', call: () => Promise.resolve('ok'), onDone: result => { done = result } })
  await settle()
  assert.equal(done, 'ok')
  assert.deepEqual(pending, ['s2', undefined])
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

test('shouldReclaimPanel: a deliberate exit is never undone, not even onto a blank Session', () => {
  const fire = { leftMixer: true, activePanelId: null }
  /* The host's own new-session entrance reveals a blank Session with no user gesture:
     that is the case the reclaim exists for (spec §5.1, requirement 2). */
  assert.equal(shouldReclaimPanel({ ...fire, revealed: { id: 'fresh', blank: true } }), true)
  /* The user pressed 常规视图 (or clicked a file link) and landed on a blank Session —
     the mixer must stay gone. Before v1.6 this bounced the user back into the mixer and
     made the mixer impossible to leave while the main Session was blank (spec §5.1). */
  assert.equal(
    shouldReclaimPanel({ ...fire, revealed: { id: 'fresh', blank: true }, userInitiatedExit: true }),
    false,
  )
  /* The latch is not a blanket permission: a non-gesture exit still reclaims. */
  assert.equal(
    shouldReclaimPanel({ ...fire, revealed: { id: 'fresh', blank: true }, userInitiatedExit: false }),
    true,
  )
  /* …and it never resurrects a reclaim that had no reason to fire. */
  assert.equal(
    shouldReclaimPanel({ ...fire, revealed: { id: 's1', blank: false }, userInitiatedExit: true }),
    false,
  )
})

test('exitTargetOf: 常规视图 lands on the channel the user is working in (§5.1)', () => {
  /* Nothing activated since the mixer opened: keep the pre-v1.6 landing (the host's own
     mainView, i.e. `selectPanel(null)`), because "the last one rendered" is not a choice
     — the host auto-focuses every pane's composer on mount (spec §5.1). */
  assert.equal(exitTargetOf({ activeChannelId: undefined, channels: ['s1', 's2'] }), undefined)
  /* One explicit activation: that channel's Session takes over the regular view. */
  assert.equal(exitTargetOf({ activeChannelId: 's2', channels: ['s1', 's2'] }), 's2')
  /* The active channel left the board (archived, closed away, auto-pruned): revealing a
     Session that is no longer a channel would be a guess — fall back to the plain exit. */
  assert.equal(exitTargetOf({ activeChannelId: 's9', channels: ['s1', 's2'] }), undefined)
  /* Garbage input must not throw and must not invent a target. */
  assert.equal(exitTargetOf({}), undefined)
  assert.equal(exitTargetOf({ activeChannelId: 's1' }), undefined)
  assert.equal(exitTargetOf({ activeChannelId: '', channels: [''] }), undefined)
  assert.equal(exitTargetOf({ activeChannelId: 's1', channels: undefined }), undefined)
})

test('createViewState: the active channel is an explicit signal and never re-renders', () => {
  const view = createViewState()
  assert.equal(view.activeChannel(), undefined, 'nothing is active before the user acts')
  let renders = 0
  view.subscribe(() => { renders += 1 })
  view.setActive('s2')
  assert.equal(view.activeChannel(), 's2')
  /* Activation is read when the user leaves; notifying here would make a pointerdown
     re-render every channel (the same discipline as `publish`). */
  assert.equal(renders, 0)
  view.setActive(undefined)
  assert.equal(view.activeChannel(), undefined)
})

