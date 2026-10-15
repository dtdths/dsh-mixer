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
    s1: { id: 's1', displayTitle: '一号会话', blank: false, running: false, parentId: undefined },
    s2: { id: 's2', displayTitle: '二号会话', blank: false, running: false, parentId: undefined },
    s3: { id: 's3', displayTitle: '三号会话', blank: false, running: false, parentId: undefined },
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
    setData: (type, value) => { written[type] = value },
    getData: type => (type === 'text/plain' ? payload : ''),
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

test('interaction: the dropdown checkbox writes the board store', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  click(ui.$('[data-mixer-workspace]'))
  const dropdown = ui.$('[data-mixer-dropdown]')
  assert.ok(dropdown !== null, 'the workspace button must open the dropdown')
  /* Level 1 is the workspace row; level 2 is its session list. */
  click([...dropdown.querySelectorAll('div')].find(node => node.textContent.startsWith('主工作区')))
  const boxes = [...ui.$('[data-mixer-dropdown]').querySelectorAll('input[type=checkbox]')]
  assert.equal(boxes.length, 3)
  assert.deepEqual(boxes.map(box => box.checked), [true, true, false])

  boxes[2].click()
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1', 's2', 's3'])
  /* And unchecking one removes it again. */
  ui.$('[data-mixer-dropdown]').querySelectorAll('input[type=checkbox]')[1].click()
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1', 's3'])
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
  assert.deepEqual(transfer.written, { 'text/plain': 's1' })
  assert.equal(transfer.effectAllowed, 'move')

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
