/**
 * Interaction tests: the panel mounted into a real jsdom document with
 * `react-dom/client`, then driven with real DOM events.
 *
 * The render tests prove the tree produces the right markup; these prove the wiring
 * behind the markup actually does what spec §5 says when the user acts: closing a
 * channel and putting it back, toggling a channel from the dropdown, pinning a view,
 * the focus marker, divider dragging, and the drag-and-drop payload both ways.
 * Without this layer, every one of those was only ever exercised by hand in a browser.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadInteractive } from './harness.mjs'

const list = {
  ids: ['s1', 's2', 's3'],
  byId: {
    s1: { id: 's1', displayTitle: '一号会话', blank: false, running: false, parentId: undefined, cwd: '/repo' },
    s2: { id: 's2', displayTitle: '二号会话', blank: false, running: false, parentId: undefined, cwd: '/repo' },
    s3: { id: 's3', displayTitle: '三号会话', blank: false, running: false, parentId: undefined, cwd: '/repo' },
  },
  phase: 'ready',
  projectionsBySession: {},
}
const workspaces = {
  items: [{ workspaceId: 'w1', title: '主工作区', path: '/repo', sessionIds: ['s1', 's2', 's3'] }],
  archivedSessionIds: [],
}
const status = new Map()

/** Mount with two channels and return the driving handle. */
async function mountTwo() {
  const ui = await loadInteractive()
  ui.draw({ board: { channels: ['s1', 's2'], weights: {} }, list, status, workspaces })
  assert.equal(ui.$$('[data-mixer-pane]').length, 2)
  return ui
}

/** A drag event React will accept: the native event carries the dataTransfer. */
function dragEvent(window, type, dataTransfer, extra = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value })
  return event
}

/** A dataTransfer stand-in that records what the plugin writes. */
function fakeDataTransfer(payload) {
  const written = {}
  return {
    written,
    types: ['text/plain'],
    effectAllowed: '',
    dropEffect: '',
    dragImage: undefined,
    setData: (type, value) => { written[type] = value },
    getData: type => (type === 'text/plain' ? payload : ''),
    setDragImage: (element, x, y) => { written.dragImage = { element, x, y } },
  }
}

test('interaction: closing a channel parks it, and the top bar puts it back', async () => {
  const ui = await mountTwo()
  const { act, window } = ui

  act(() => { ui.$('[data-mixer-close="s1"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(ui.$$('[data-mixer-pane]').map(node => node.getAttribute('data-mixer-pane')), ['s2'])
  /* Its reference is NOT released: the waiting signal must survive the close (§4.2). */
  assert.ok(ui.host.retained.includes('s1'))
  assert.ok(!ui.host.released.includes('s1'))

  const chip = ui.$('[data-mixer-hidden]')
  assert.ok(chip !== null, 'the top bar must offer the parked channels back')
  assert.match(chip.textContent, /已移出 1 个/)

  act(() => { chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(ui.$$('[data-mixer-pane]').map(node => node.getAttribute('data-mixer-pane')), ['s2', 's1'])
})

test('interaction: the 会话 panel writes the board store, and filters by title (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  click(ui.$('[data-mixer-sessions]'))
  assert.ok(ui.$('[data-mixer-session-panel]') !== null, 'the 会话 button must open the panel')
  /* The old two-LEVEL dropdown needed a workspace click before any Session showed; the
     panel lists them immediately, and the workspace column is only about the landing. */
  const boxes = () => [...ui.$('[data-mixer-session-panel]').querySelectorAll('input[type=checkbox]')]
  assert.equal(boxes().length, 3)
  assert.deepEqual(boxes().map(box => box.checked), [true, true, false])

  click(boxes()[2])
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1', 's2', 's3'])
  /* And unchecking one removes it again. */
  click(boxes()[1])
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1', 's3'])

  /* The local title filter narrows the list without touching the board. React tracks
     the value setter, so go through the native one. */
  const search = ui.$('[data-mixer-search]')
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, '二号')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.equal(boxes().length, 1)
  assert.ok(ui.$('[data-mixer-session="s2"]') !== null)
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1', 's3'])
})

test('interaction: the left column only changes where a new Session lands (§5.2)', async () => {
  const ui = await loadInteractive()
  const twoWorkspaces = {
    items: [
      { workspaceId: 'w1', title: '主工作区', path: '/repo', sessionIds: ['s1'] },
      { workspaceId: 'w2', title: '别的区', path: '/elsewhere', sessionIds: ['s2'] },
    ],
    archivedSessionIds: [],
  }
  ui.draw({ board: { channels: ['s1'], weights: {} }, list, status, workspaces: twoWorkspaces })
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  click(ui.$('[data-mixer-sessions]'))
  /* s1 lives in w1, so w1 is the preselect and carries the tag. */
  assert.match(ui.$('[data-mixer-landing="w1"]').textContent, /新建落点/)
  assert.doesNotMatch(ui.$('[data-mixer-landing="w2"]').textContent, /新建落点/)

  click(ui.$('[data-mixer-landing="w2"]'))
  assert.match(ui.$('[data-mixer-landing="w2"]').textContent, /新建落点/)
  assert.doesNotMatch(ui.$('[data-mixer-landing="w1"]').textContent, /新建落点/)
  /* Picking a workspace must NOT navigate: the removed 「切换到此工作区」 called
     uiWorkspace.openWorkspace(), which reveals and leaves the mixer (ADR-0003). */
  assert.deepEqual(ui.host.selectPanelCalls, [])
  /* Round 3: the left column doubles as a jump list — each pick scrolls the right
     column to that workspace's group. */
  click(ui.$('[data-mixer-landing="w1"]'))
  assert.deepEqual(ui.window.__scrolls, ['w2', 'w1'])
})

test('interaction: the 会话 trigger reads as a button, not as plain text (§5.2)', async () => {
  const ui = await mountTwo()
  const trigger = ui.$('[data-mixer-sessions]')
  /* Round 3, user feedback "无按钮样式": the trigger used to be transparent until it was
     opened. It must carry a visible surface and border at rest. */
  assert.notEqual(trigger.style.background, '')
  assert.notEqual(trigger.style.background, 'transparent')
  assert.match(trigger.style.border, /^1px solid (?!transparent)/)
})

test('interaction: 新建会话 creates through the session service and lands first (§4.1/§5.1)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  click(ui.$('[data-mixer-sessions]'))
  /* `ctx.sessions.create` resolves asynchronously, so the flush has to wait for it. */
  await act(async () => {
    ui.$('[data-mixer-new]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  /* The host's `startSession` would have revealed the Session and blanked the panel;
     `ctx.sessions.create` must be the path instead (ADR-0003). */
  assert.deepEqual(ui.host.createCalls, [{ workspaceId: 'w1' }])
  assert.deepEqual(ui.host.selectPanelCalls, [])
  assert.deepEqual(ui.instance.getSnapshot().channels, ['created-1', 's1', 's2'])
  /* The new channel owns the caret, not the last pane the host auto-focused. */
  const focused = ui.document.activeElement
  assert.equal(focused.getAttribute('data-composer'), '')
  assert.equal(focused.closest('[data-mixer-pane]').getAttribute('data-mixer-pane'), 'created-1')
})

test('interaction: leaving by opening a Session WITH history is never undone by the reclaim (§5.1)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  /* The plugin's own ＋ leaves a blank channel behind; that must not make the NEXT
     deliberate exit look like a host navigation. */
  click(ui.$('[data-mixer-sessions]'))
  await act(async () => {
    ui.$('[data-mixer-new]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  const grown = {
    ids: ['s1', 's2', 's3', 'created-1'],
    byId: { ...list.byId, 'created-1': { id: 'created-1', displayTitle: '（空白）', blank: true, cwd: '/repo' } },
    phase: 'ready',
    projectionsBySession: {},
  }
  act(() => { ui.host.setList(grown) })

  /* The user leaves by opening a Session that HAS history: the host's reveal marker
     points at a non-blank row, so the mixer stays gone. */
  const withHistory = {
    ...grown,
    byId: { ...grown.byId, s2: { ...grown.byId.s2, retainedBy: { mainView: 1 } } },
  }
  act(() => { ui.host.setPanelInfo({ activePanelId: 'mixer' }) })
  act(() => { ui.host.setList(withHistory) })
  act(() => { ui.host.setPanelInfo({ activePanelId: null }) })
  assert.deepEqual(ui.host.selectPanelCalls, [])
})

test('interaction: a failed create says so instead of silently doing nothing (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  ui.host.setCreateFailure({ code: 'session/writer-held', message: 'writer held' })

  click(ui.$('[data-mixer-sessions]'))
  await act(async () => {
    ui.$('[data-mixer-new]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  /* The board is untouched, and the bar carries the reason — the host's own entrance
     reported failures through its notify service, so ours must not be a silent no-op. */
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1', 's2'])
  const notice = ui.$('[data-mixer-create-error]')
  assert.ok(notice !== null, 'a failed create must be visible')
  assert.match(notice.textContent, /writer held/)
})

test('interaction: the caret hand-off waits for a composer that paints late (§5.1)', async () => {
  const ui = await loadInteractive({ withComposer: false })
  ui.draw({ board: { channels: ['s1'], weights: {} }, list, status, workspaces })
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  click(ui.$('[data-mixer-sessions]'))
  await act(async () => {
    ui.$('[data-mixer-new]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  /* The channel is there, but its composer is not: nothing may be focused yet, and the
     intent must survive instead of being dropped after one query. */
  assert.ok(ui.$('[data-mixer-pane="created-1"]') !== null)
  assert.equal(ui.document.activeElement.tagName, 'BODY')

  const field = window.document.createElement('input')
  ui.$('[data-mixer-pane="created-1"] [data-factory]').appendChild(field)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
  assert.equal(ui.document.activeElement, field)
})

test('interaction: a blank Session of the landing workspace is reused, not recreated (§4.1)', async () => {
  const ui = await loadInteractive()
  const withBlank = {
    ids: ['s1', 's2', 'b1'],
    byId: {
      ...list.byId,
      b1: { id: 'b1', displayTitle: '（空白）', blank: true, running: false, parentId: undefined, cwd: '/repo' },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  const ws = {
    items: [{ workspaceId: 'w1', title: '主工作区', path: '/repo', sessionIds: ['s1', 's2', 'b1'] }],
    archivedSessionIds: [],
  }
  ui.draw({ board: { channels: ['s1', 's2'], weights: {} }, list: withBlank, status, workspaces: ws })
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  click(ui.$('[data-mixer-sessions]'))
  click(ui.$('[data-mixer-new]'))
  assert.deepEqual(ui.host.createCalls, [], 'a blank Session of that workspace must be reused')
  assert.deepEqual(ui.instance.getSnapshot().channels, ['b1', 's1', 's2'])
})

test('interaction: the host REUSING a blank Session still keeps the mixer (§5.1)', async () => {
  const ui = await mountTwo()
  const { act } = ui

  /* A plain exit: no reveal marker at all, the mixer must stay gone. */
  act(() => { ui.host.setPanelInfo({ activePanelId: 'mixer' }) })
  act(() => { ui.host.setPanelInfo({ activePanelId: null }) })
  assert.deepEqual(ui.host.selectPanelCalls, [])

  /* The host's own rail button / shortcut REUSES a blank Session (navigation.ts:185-198
     `reuseOrCreateBlank`): no new id appears anywhere, but the host marks the revealed
     Session as its `mainView` reference. A new-id test would miss exactly this — the
     most common repeat press, since our own ＋ leaves a blank Session behind. */
  const blank = { id: 's3', displayTitle: '（空白）', blank: true, running: false, parentId: undefined, cwd: '/repo' }
  const revealed = {
    ...list,
    byId: { ...list.byId, s3: { ...blank, retainedBy: { mainView: 1 } } },
  }
  act(() => { ui.host.setPanelInfo({ activePanelId: 'mixer' }) })
  act(() => { ui.host.setList(revealed) })
  /* The host unmounts the mixer on its way out… */
  act(() => { ui.root.render(null) })
  act(() => { ui.host.setPanelInfo({ activePanelId: null }) })
  assert.deepEqual(ui.host.selectPanelCalls, ['mixer'])
  /* …and the panel comes back with the reused Session first, retained. */
  ui.draw({ list: revealed })
  assert.equal(ui.instance.getSnapshot().channels[0], 's3')
  assert.ok(ui.host.retained.includes('s3'))
})

test('interaction: Esc and a second click both close the 会话 panel (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const trigger = () => ui.$('[data-mixer-sessions]')

  assert.equal(trigger().getAttribute('aria-expanded'), 'false')
  click(trigger())
  assert.ok(ui.$('[data-mixer-session-panel]') !== null)
  assert.equal(trigger().getAttribute('aria-expanded'), 'true')

  act(() => { ui.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(ui.$('[data-mixer-session-panel]'), null)
  assert.equal(trigger().getAttribute('aria-expanded'), 'false')

  /* A second click on the trigger toggles it shut as well. */
  click(trigger())
  assert.ok(ui.$('[data-mixer-session-panel]') !== null)
  click(trigger())
  assert.equal(ui.$('[data-mixer-session-panel]'), null)
  /* And the backdrop (a click outside) closes it. */
  click(trigger())
  assert.ok(ui.$('[data-mixer-session-panel]') !== null)
  click(ui.$('[data-mixer-session-panel]').previousSibling)
  assert.equal(ui.$('[data-mixer-session-panel]'), null)
})

test('interaction: the top bar never names a workspace, the panel does (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  /* Requirement 4: the bar is about the mixer as a whole; a workspace name there would
     claim a concept the mixer does not own. */
  const bar = ui.$('[data-mixer-topbar]')
  assert.ok(bar !== null)
  assert.doesNotMatch(bar.textContent, /主工作区/)
  assert.match(bar.textContent, /调音台/)

  /* The name is still reachable where it answers a real question: the landing column. */
  click(ui.$('[data-mixer-sessions]'))
  assert.match(ui.$('[data-mixer-landing="w1"]').textContent, /主工作区/)
})

test('interaction: a view tab pins the view through the factory seam (§4.4)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui

  /* Unpinned: the factory gets no `views` override at all. */
  assert.equal(ui.factoryCalls.filter(call => call.name === 'conversation.session').length, 0)
  ui.factoryCalls.length = 0
  act(() => {
    ui.$$('[data-mixer-view]').find(tab => tab.getAttribute('data-mixer-view') === 'trajectory')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  const pinned = ui.factoryCalls.filter(call => call.name === 'conversation.session')
  assert.ok(pinned.length > 0, 'pinning must re-render the strict body with the view')
  assert.deepEqual(pinned[0].input, { view: 'trajectory' })
  /* Both panes pin independently; the tab reflects the choice. */
  const active = ui.$$('[data-mixer-view]').filter(tab => tab.style.fontWeight === '600')
  assert.equal(active.length, 2)
})

test('interaction: focusing inside a pane raises its focus marker (§5.3)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const body = ui.$$('[data-mixer-body]')[0]
  assert.equal(ui.$$('[data-mixer-pane]')[0].getAttribute('data-mixer-focused'), 'no')

  act(() => { body.dispatchEvent(new window.Event('focusin', { bubbles: true })) })
  assert.equal(ui.$$('[data-mixer-pane]')[0].getAttribute('data-mixer-focused'), 'yes')
  /* The other pane stays quiet. */
  assert.equal(ui.$$('[data-mixer-pane]')[1].getAttribute('data-mixer-focused'), 'no')

  act(() => { body.dispatchEvent(new window.Event('focusout', { bubbles: true })) })
  assert.equal(ui.$$('[data-mixer-pane]')[0].getAttribute('data-mixer-focused'), 'no')
})

test('interaction: dragging a divider writes proportional weights, clamped at 380px (§5.4)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const track = ui.$('[data-mixer-track]')
  /* jsdom reports no layout, so give the track the width the math needs. */
  Object.defineProperty(track, 'scrollWidth', { value: 1000, configurable: true })
  const handle = ui.$('[data-mixer-resizer="s1|s2"]')
  const pointer = (type, clientX) => handle.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX }))

  act(() => { pointer('pointerdown', 500) })
  act(() => { pointer('pointermove', 600) })
  /* total 2 over 1000px: +100px is +0.2 of the weight budget, and the pair stays sum 2. */
  const moved = ui.instance.getSnapshot().weights
  assert.ok(Math.abs(moved.s1 - 1.2) < 1e-9, `expected ~1.2, got ${moved.s1}`)
  assert.ok(Math.abs(moved.s2 - 0.8) < 1e-9, `expected ~0.8, got ${moved.s2}`)

  /* Drag far past the floor: both sides clamp at 380px of 1000px of a 2-weight total. */
  act(() => { pointer('pointermove', 0) })
  const weights = ui.instance.getSnapshot().weights
  assert.equal(Number(weights.s1.toFixed(4)), 0.76)
  assert.equal(Number(weights.s2.toFixed(4)), 1.24)

  act(() => { pointer('pointerup', 0) })
  /* The drag cleans up after itself. */
  assert.equal(ui.document.body.style.userSelect, '')
})

test('interaction: a channel head drags with the sidebar\'s own payload (§5.4b)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const head = ui.$$('[data-mixer-head]')[0]
  const transfer = fakeDataTransfer(null)
  const start = dragEvent(window, 'dragstart', transfer)
  act(() => { head.dispatchEvent(start) })
  assert.deepEqual(transfer.written['text/plain'], 's1')
  assert.equal(transfer.effectAllowed, 'move')
  /* Requirement 3: the drag image is the WHOLE pane, not the head row the browser
     would snapshot by default. */
  assert.equal(transfer.written.dragImage.element.getAttribute('data-mixer-pane'), 's1')
  /* …and the source pane becomes a quiet placeholder in the meantime. */
  assert.equal(ui.$('[data-mixer-cell="s1"]').style.opacity, '0.4')
  assert.equal(ui.$('[data-mixer-cell="s1"]').getAttribute('data-mixer-dragging'), 'yes')

  /* A cancelled drag (dropped outside, Esc) never reaches the track's drop handler:
     the head's own dragend must clear the placeholder anyway. */
  act(() => { head.dispatchEvent(dragEvent(window, 'dragend', transfer)) })
  assert.equal(ui.$('[data-mixer-cell="s1"]').style.opacity, '')
  assert.equal(ui.$('[data-mixer-cell="s1"]').getAttribute('data-mixer-dragging'), 'no')
  assert.equal(ui.$('[data-mixer-drop-indicator]'), null)

  /* Starting the drag from the head's own close button must be refused. */
  const second = fakeDataTransfer(null)
  const fromButton = dragEvent(window, 'dragstart', second)
  act(() => { ui.$('[data-mixer-close="s1"]').dispatchEvent(fromButton) })
  assert.deepEqual(second.written, {}, 'a drag from the × must not become a channel move')
  assert.ok(fromButton.defaultPrevented)
})

test('interaction: dropping on the track reorders the board (§5.4b)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  /* jsdom gives every cell a zero rect, so the pointer index resolves to "append". */
  const drop = dragEvent(window, 'drop', fakeDataTransfer('s1'), { clientX: 0 })
  act(() => { ui.$('[data-mixer-track]').dispatchEvent(drop) })
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s2', 's1'])

  /* A text-selection drag that is not a known Session must be ignored. */
  const junk = dragEvent(window, 'drop', fakeDataTransfer('not-a-session'), { clientX: 0 })
  act(() => { ui.$('[data-mixer-track]').dispatchEvent(junk) })
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s2', 's1'])
})

test('interaction: a dragged channel opens a same-width slot where it would land (§5.3)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  /* jsdom reports no layout: hand the two cells real geometry BEFORE the drag starts,
     because the pointer math reads the geometry captured at dragstart. */
  const rect = (left, width) => ({
    left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0,
  })
  const cells = ui.$$('[data-mixer-cell]')
  cells[0].getBoundingClientRect = () => rect(0, 400)
  cells[1].getBoundingClientRect = () => rect(400, 400)

  act(() => { ui.$$('[data-mixer-head]')[0].dispatchEvent(dragEvent(window, 'dragstart', fakeDataTransfer(null))) })
  /* Pointer in the left half of the second cell → the slot opens at index 1. */
  act(() => {
    ui.$('[data-mixer-track]').dispatchEvent(dragEvent(window, 'dragover', fakeDataTransfer(null), { clientX: 410 }))
  })
  const slot = ui.$('[data-mixer-drop-indicator]')
  assert.equal(slot.getAttribute('data-mixer-drop-slot'), 'yes')
  /* As wide as the dragged pane plus the 5px band it gave up. */
  assert.equal(slot.style.flex, '0 0 405px')
  /* The order itself is untouched until the drop commits. */
  assert.deepEqual(ui.$$('[data-mixer-cell]').map(node => node.getAttribute('data-mixer-cell')), ['s1', 's2'])
})
