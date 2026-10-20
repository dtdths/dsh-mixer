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

/**
 * jsdom reports no layout, so hand a channel's body a real box: the drag ghost only
 * clones the live body when nothing inside it is laid out outside the channel (§5.3).
 */
function stubBody(pane, { width = 400, height = 900 } = {}) {
  const body = pane.querySelector('[data-mixer-body]')
  body.getBoundingClientRect = () => ({
    left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0,
  })
  return body
}

/**
 * Open the 会话 panel and press a workspace row's hover-only 「＋会话」 (§5.2,
 * 2026-10-20: the create action lives on each workspace row, not in a footer button).
 */
async function createInWorkspace(ui, workspaceId) {
  const { act, window } = ui
  if (ui.$('[data-mixer-session-panel]') === null) {
    act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  }
  const row = ui.$(`[data-mixer-workspace="${workspaceId}"]`)
  assert.ok(row !== null, `missing workspace row ${workspaceId}`)
  act(() => { row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
  const action = ui.$(`[data-mixer-new="${workspaceId}"]`)
  assert.ok(action !== null, 'hovering a workspace must offer its create action')
  await act(async () => {
    action.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
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
     panel lists them immediately, and the workspace column is a jump list plus each
     row's own create action. */
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

test('interaction: a workspace row jumps the right column and creates in that workspace (§5.2)', async () => {
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
  const hover = element => act(() => { element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })

  click(ui.$('[data-mixer-sessions]'))
  const w2 = ui.$('[data-mixer-workspace="w2"]')
  assert.ok(w2 !== null)
  /* 2026-10-20: 「新建落点」 retired — no tag, no preselection, the row itself is the
     target. The action is hover-only, like the archive action on a Session row. */
  assert.doesNotMatch(w2.textContent, /新建落点/)
  assert.equal(ui.$('[data-mixer-new="w2"]'), null, 'the create action is hover-only')

  /* Clicking a row is a JUMP only: the right column scrolls to that workspace, nothing
     navigates and nothing is selected. */
  click(w2)
  assert.deepEqual(ui.window.__scrolls, ['w2'])
  assert.deepEqual(ui.host.selectPanelCalls, [])
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1'])

  /* Its own action creates in THAT workspace, first in the channel row. */
  hover(w2)
  const action = ui.$('[data-mixer-new="w2"]')
  assert.ok(action !== null)
  /* The button carries its OWN hover state, so "the pointer is on the button" reads
     differently from "the row under it is hovered": inline styles cannot express that, so
     one injected rule owns both states (2026-10-20). */
  assert.equal(action.getAttribute('data-mixer-row-action'), '')
  const states = [...ui.document.querySelectorAll('style')]
    .map(node => node.textContent === null ? '' : node.textContent).join('\n')
  assert.match(states, /\[data-mixer-row-action\]:hover/)
  assert.match(states, /interactive-bg-hover-accent/)
  await act(async () => {
    action.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.deepEqual(ui.host.createCalls, [{ workspaceId: 'w2' }])
  assert.deepEqual(ui.instance.getSnapshot().channels, ['created-1', 's1'])
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
  /* `ctx.sessions.create` resolves asynchronously; the helper flushes it. */
  await createInWorkspace(ui, 'w1')

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
  const { act } = ui

  /* The plugin's own ＋ leaves a blank channel behind; that must not make the NEXT
     deliberate exit look like a host navigation. */
  await createInWorkspace(ui, 'w1')
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
  ui.host.setCreateFailure({ code: 'session/writer-held', message: 'writer held' })

  await createInWorkspace(ui, 'w1')

  /* The board is untouched, and the bar carries the reason — the host's own entrance
     reported failures through its notify service, so ours must not be a silent no-op. */
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1', 's2'])
  const notice = ui.$('[data-mixer-notice]')
  assert.ok(notice !== null, 'a failed create must be visible')
  assert.match(notice.textContent, /writer held/)
})

test('interaction: the caret hand-off waits for a composer that paints late (§5.1)', async () => {
  const ui = await loadInteractive({ withComposer: false })
  ui.draw({ board: { channels: ['s1'], weights: {} }, list, status, workspaces })
  const { act, window } = ui
  await createInWorkspace(ui, 'w1')
  /* The channel is there, but its composer is not: nothing may be focused yet, and the
     intent must survive instead of being dropped after one query. */
  assert.ok(ui.$('[data-mixer-pane="created-1"]') !== null)
  assert.equal(ui.document.activeElement.tagName, 'BODY')

  const field = window.document.createElement('input')
  ui.$('[data-mixer-pane="created-1"] [data-factory]').appendChild(field)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
  assert.equal(ui.document.activeElement, field)
})

test('interaction: a blank Session of the clicked workspace is reused, not recreated (§4.1)', async () => {
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
  await createInWorkspace(ui, 'w1')
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

  /* The name is still reachable where it answers a real question: the workspace column. */
  click(ui.$('[data-mixer-sessions]'))
  assert.match(ui.$('[data-mixer-workspace="w1"]').textContent, /主工作区/)
})

test('interaction: archived Sessions are hidden from the panel, like the sidebar (§5.2)', async () => {
  const ui = await loadInteractive()
  const withArchived = {
    items: [{ workspaceId: 'w1', title: '主工作区', path: '/repo', sessionIds: ['s1', 's2', 's3'] }],
    archivedSessionIds: ['s2'],
  }
  ui.draw({ board: { channels: ['s1'], weights: {} }, list, status, workspaces: withArchived })
  const { act, window } = ui
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  /* An archived row is not openable and must not be pickable as a channel, so it is
     simply not listed — the panel mirrors the sidebar's own filter. */
  assert.equal(ui.$('[data-mixer-session="s2"]'), null)
  assert.ok(ui.$('[data-mixer-session="s1"]') !== null)
  assert.ok(ui.$('[data-mixer-session="s3"]') !== null)
  assert.equal(ui.$$('[data-mixer-session-panel] input[type=checkbox]').length, 2)
})

test('interaction: hovering a row offers archive, which archives and closes the channel (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const hover = (element, type) => act(() => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true })) })
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  const row = ui.$('[data-mixer-session="s2"]')
  assert.equal(ui.$('[data-mixer-archive="s2"]'), null, 'the action is hover-only')
  hover(row, 'mouseover')
  const action = ui.$('[data-mixer-archive="s2"]')
  assert.ok(action !== null, 'hovering a row must offer the archive action')
  act(() => { action.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  /* Same service call the sidebar's own row action makes, with no stopActivity option
     unless the Host refused first. */
  assert.deepEqual(ui.host.archiveCalls, [{ sessionId: 's2', options: undefined }])

  /* The archive lands in the workspaces snapshot, and that prunes the open channel. */
  const withArchived = {
    items: [{ workspaceId: 'w1', title: '主工作区', path: '/repo', sessionIds: ['s1', 's2', 's3'] }],
    archivedSessionIds: ['s2'],
  }
  ui.draw({ workspaces: withArchived })
  assert.deepEqual(ui.$$('[data-mixer-pane]').map(node => node.getAttribute('data-mixer-pane')), ['s1'])
})

test('interaction: a running Session asks before archiving, then stops and archives (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const hover = (element, type) => act(() => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true })) })
  /* The Host's refusal for running work: class identity by NAME, because client plugin
     bundles do not share error-class identity (ui-workspace/index.ts:326). */
  ui.host.setArchiveFailure(Object.assign(new Error('session active'), {
    name: 'WorkspaceArchiveError',
    rpcError: { code: 'workspace/session-active', details: { activity: [{ kind: 'running' }] } },
  }))
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  hover(ui.$('[data-mixer-session="s2"]'), 'mouseover')
  await act(async () => {
    ui.$('[data-mixer-archive="s2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  /* A dead click would be worse than the host's own confirm dialog: offer the stop. */
  const confirm = ui.$('[data-mixer-archive-confirm="s2"]')
  assert.ok(confirm !== null, 'the refusal must offer to stop and archive')
  await act(async () => {
    ui.$('[data-mixer-archive-stop="s2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.deepEqual(ui.host.archiveCalls, [
    { sessionId: 's2', options: undefined },
    { sessionId: 's2', options: { stopActivity: true } },
  ])
  assert.equal(ui.$('[data-mixer-archive-confirm="s2"]'), null)
})

test('interaction: an archive that THROWS or is missing says so, never a dead click (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const hover = (element, type) => act(() => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true })) })
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  /* A service that throws synchronously is the exact shape of "I clicked and nothing
     happened" — it must surface in the bar, not only in the console. */
  ui.host.setArchiveThrow(new TypeError('ctx.uiWorkspace.archiveSession is not a function'))
  hover(ui.$('[data-mixer-session="s2"]'), 'mouseover')
  act(() => { ui.$('[data-mixer-archive="s2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.match(ui.$('[data-mixer-notice]').textContent, /archiveSession is not a function/)

  /* And if the action is not even wired, the panel says which piece is missing. */
  ui.host.setArchiveThrow(undefined)
  ui.draw({})
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const stripped = await loadInteractive()
  stripped.draw({ board: { channels: ['s1'], weights: {} }, list, status, workspaces })
  /* Strip the injected action the way a host contract change would. */
  const injected = stripped.host.main.options.inject()
  delete injected.archiveSession
  stripped.host.main.options.inject = () => injected
  stripped.draw({})
  act(() => { stripped.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  hover(stripped.$('[data-mixer-session="s1"]'), 'mouseover')
  act(() => { stripped.$('[data-mixer-archive="s1"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.match(stripped.$('[data-mixer-notice]').textContent, /没有提供 archiveSession/)
})

test('interaction: an in-flight archive shows 归档中… instead of looking inert (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const hover = (element, type) => act(() => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true })) })
  ui.host.setArchiveDelay(40)
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  hover(ui.$('[data-mixer-session="s2"]'), 'mouseover')
  act(() => { ui.$('[data-mixer-archive="s2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  const pending = ui.$('[data-mixer-archive="s2"]')
  assert.equal(pending.textContent, '归档中…')
  assert.equal(pending.disabled, true)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
  /* Settled: back to the resting label. */
  assert.equal(ui.$('[data-mixer-archive="s2"]').textContent, '归档')
})

test('interaction: an archive can be undone from the bar, back where it was (§5.2)', async () => {
  const ui = await loadInteractive()
  /* s2 is the second channel and has a width of its own: both must come back. */
  ui.draw({ board: { channels: ['s1', 's2'], weights: { s2: 2 } }, list, status, workspaces })
  const { act, window } = ui
  const hover = (element, type) => act(() => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true })) })
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  hover(ui.$('[data-mixer-session="s2"]'), 'mouseover')
  await act(async () => {
    ui.$('[data-mixer-archive="s2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.deepEqual(ui.host.archiveCalls, [{ sessionId: 's2', options: undefined }])
  /* The bar offers the same undo the sidebar's archived toast does. */
  assert.match(ui.$('[data-mixer-undo-archive="s2"]').textContent, /已归档「二号会话」/)
  assert.ok(ui.$('[data-mixer-undo-archive-do]') !== null)

  /* The host snapshot catches up: §4.1 prunes the channel… */
  ui.draw({ workspaces: { ...workspaces, archivedSessionIds: ['s2'] } })
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1'])

  /* …and the undo brings the Session AND the channel back where they were, width too —
     even though this snapshot still calls it archived (the "just restored" exemption). */
  await act(async () => {
    ui.$('[data-mixer-undo-archive-do]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.deepEqual(ui.host.unarchiveCalls, ['s2'])
  assert.deepEqual(ui.instance.getSnapshot().channels, ['s1', 's2'])
  assert.equal(ui.instance.getSnapshot().weights.s2, 2)
  assert.equal(ui.$('[data-mixer-undo-archive="s2"]'), null)
})

test('interaction: a refused or unavailable undo says so, never a dead chip (§5.2)', async () => {
  /* The host refuses the unarchive. */
  const ui = await mountTwo()
  const { act, window } = ui
  const hover = (element, type) => act(() => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true })) })
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  hover(ui.$('[data-mixer-session="s2"]'), 'mouseover')
  await act(async () => {
    ui.$('[data-mixer-archive="s2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  ui.host.setUnarchiveFailure(new Error('unarchive rejected'))
  await act(async () => {
    ui.$('[data-mixer-undo-archive-do]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.match(ui.$('[data-mixer-notice]').textContent, /撤销归档失败：unarchive rejected/)
  assert.equal(ui.$('[data-mixer-undo-archive="s2"]'), null)

  /* And a host that never provided the method is named, not silently dead. */
  const stripped = await loadInteractive()
  stripped.draw({ board: { channels: ['s1', 's2'], weights: {} }, list, status, workspaces })
  const strip = stripped
  const doHover = (element, type) => act(() => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true })) })
  act(() => { strip.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  doHover(strip.$('[data-mixer-session="s2"]'), 'mouseover')
  await act(async () => {
    strip.$('[data-mixer-archive="s2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  const injected = strip.host.main.options.inject()
  delete injected.unarchiveSession
  strip.host.main.options.inject = () => injected
  strip.draw({})
  await act(async () => {
    strip.$('[data-mixer-undo-archive-do]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.match(strip.$('[data-mixer-notice]').textContent, /没有提供 unarchiveSession/)
})

test('interaction: only the latest archive is offered for undo (§5.2)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const hover = (element, type) => act(() => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true })) })
  act(() => { ui.$('[data-mixer-sessions]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  hover(ui.$('[data-mixer-session="s2"]'), 'mouseover')
  await act(async () => {
    ui.$('[data-mixer-archive="s2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.ok(ui.$('[data-mixer-undo-archive="s2"]') !== null)
  /* One offer at a time, like the host's single toast. */
  hover(ui.$('[data-mixer-session="s3"]'), 'mouseover')
  await act(async () => {
    ui.$('[data-mixer-archive="s3"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  assert.ok(ui.$('[data-mixer-undo-archive="s3"]') !== null)
  assert.equal(ui.$('[data-mixer-undo-archive="s2"]'), null)
})

test('interaction: the channel-jump shortcuts focus the right channel (§5.6)', async () => {
  const ui = await mountTwo()
  const { act } = ui
  /* The commands are registered with the plugin, once; the panel only supplies the live
     channel order (mixerRuntime). */
  const command = (id) => ui.host.shortcutCommands.find(entry => entry.id === id)
  assert.ok(command('mixer.channel.1') !== null, 'the digit jumps must be registered')
  assert.ok(command('mixer.channel.next') !== null && command('mixer.channel.prev') !== null)
  const resolve = (id, region = 'page') => command(id).resolve({ region, modal: null, target: null })

  /* Outside the mixer the command passes instead of swallowing the key. */
  assert.equal(resolve('mixer.channel.2').status, 'pass')

  act(() => { ui.host.setPanelInfo({ activePanelId: 'mixer' }) })
  const second = resolve('mixer.channel.2', 'editable')
  assert.equal(second.status, 'handled')
  act(() => { second.run() })
  await act(async () => {})
  assert.equal(ui.document.activeElement.closest('[data-mixer-pane]').getAttribute('data-mixer-pane'), 's2')

  /* A channel that is not on screen is blocked with a reason, never a silent no-op. */
  const missing = resolve('mixer.channel.9')
  assert.equal(missing.status, 'blocked')
  assert.match(missing.reason, /没有第 9 个通道/)
})

test('interaction: next/prev wrap around from the focused channel (§5.6)', async () => {
  const ui = await mountTwo()
  const { act } = ui
  act(() => { ui.host.setPanelInfo({ activePanelId: 'mixer' }) })
  const command = id => ui.host.shortcutCommands.find(entry => entry.id === id)
  const run = async (id) => {
    const resolution = command(id).resolve({ region: 'editable', modal: null, target: null })
    assert.equal(resolution.status, 'handled')
    act(() => { resolution.run() })
    await act(async () => {})
    return ui.document.activeElement.closest('[data-mixer-pane]').getAttribute('data-mixer-pane')
  }

  assert.equal(await run('mixer.channel.1'), 's1')
  assert.equal(await run('mixer.channel.next'), 's2')
  /* Two channels: next from the last wraps to the first, prev from the first to the last. */
  assert.equal(await run('mixer.channel.next'), 's1')
  assert.equal(await run('mixer.channel.prev'), 's2')
})

test('interaction: jumping with no channels is blocked, not dead (§5.6)', async () => {
  const ui = await loadInteractive()
  /* No board yet: the fallback list still renders channels, so empty it explicitly. */
  ui.draw({ board: { channels: [], weights: {} }, list: { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }, status, workspaces: { items: [], archivedSessionIds: [] } })
  const { act } = ui
  act(() => { ui.host.setPanelInfo({ activePanelId: 'mixer' }) })
  const next = ui.host.shortcutCommands.find(entry => entry.id === 'mixer.channel.next')
  const resolution = next.resolve({ region: 'page', modal: null, target: null })
  assert.equal(resolution.status, 'blocked')
  assert.match(resolution.reason, /还没有通道/)
})

test('interaction: solo folds the other channels into strips and exits cleanly (§5.7)', async () => {
  const ui = await loadInteractive()
  /* Two channels with different widths: solo must not touch the persisted weights. */
  ui.draw({ board: { channels: ['s1', 's2'], weights: { s1: 2, s2: 1 } }, list, status, workspaces })
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

  /* Enter from the channel head. */
  click(ui.$('[data-mixer-solo="s1"]'))
  const strips = ui.$$('[data-mixer-strip]')
  assert.deepEqual(strips.map(node => node.getAttribute('data-mixer-strip')), ['s2'])
  /* The soloed channel keeps its composer; the folded one is only a strip. */
  assert.ok(ui.$('[data-mixer-pane="s1"]') !== null)
  assert.equal(ui.$('[data-mixer-pane="s2"]'), null)
  assert.equal(ui.$('[data-mixer-strip="s2"]').querySelector('[data-factory]'), null)
  /* Dividers are suspended while solo lasts. */
  assert.equal(ui.$('[data-mixer-resizer]'), null)
  /* The bar offers the way out (Escape is the host's stop-turn key, so it is not used). */
  assert.match(ui.$('[data-mixer-solo-bar]').textContent, /solo：一号会话/)

  /* Clicking a strip solos THAT channel instead. */
  click(ui.$('[data-mixer-strip="s2"]'))
  assert.deepEqual(ui.$$('[data-mixer-strip]').map(node => node.getAttribute('data-mixer-strip')), ['s1'])
  assert.ok(ui.$('[data-mixer-pane="s2"]') !== null)

  /* Exit restores the side-by-side layout and the weights are untouched. */
  click(ui.$('[data-mixer-solo-exit]'))
  assert.deepEqual(ui.$$('[data-mixer-strip]'), [])
  assert.ok(ui.$('[data-mixer-pane="s1"]') !== null && ui.$('[data-mixer-pane="s2"]') !== null)
  assert.deepEqual(ui.instance.getSnapshot().weights, { s1: 2, s2: 1 })
  assert.equal(ui.$('[data-mixer-solo-bar]'), null)
})

test('interaction: a soloed channel that disappears ends the solo (§5.7)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const click = element => act(() => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  click(ui.$('[data-mixer-solo="s1"]'))
  assert.deepEqual(ui.$$('[data-mixer-strip]').map(node => node.getAttribute('data-mixer-strip')), ['s2'])

  /* The host list drops the soloed Session (archived elsewhere): solo must not outlive it. */
  ui.draw({ list: { ...list, ids: ['s2'], byId: { s2: list.byId.s2 } } })
  assert.deepEqual(ui.$$('[data-mixer-strip]'), [])
  assert.equal(ui.$('[data-mixer-solo-bar]'), null)
  assert.ok(ui.$('[data-mixer-pane="s2"]') !== null)
})

test('interaction: the solo shortcut targets the channel holding the caret (§5.7)', async () => {
  const ui = await mountTwo()
  const { act } = ui
  act(() => { ui.host.setPanelInfo({ activePanelId: 'mixer' }) })
  const command = ui.host.shortcutCommands.find(entry => entry.id === 'mixer.channel.solo')
  assert.ok(command !== null, 'the solo command must be registered')

  /* No caret inside a channel: blocked with a reason instead of soloeing something random. */
  const nowhere = command.resolve({ region: 'page', modal: null, target: null })
  assert.equal(nowhere.status, 'blocked')
  assert.match(nowhere.reason, /先把光标放进/)

  /* Put the caret in the second channel's composer, then solo it. */
  const field = ui.$$('[data-mixer-pane="s2"] [data-composer]')[0]
  act(() => { field.focus() })
  const resolution = command.resolve({ region: 'editable', modal: null, target: field })
  assert.equal(resolution.status, 'handled')
  act(() => { resolution.run() })
  assert.deepEqual(ui.$$('[data-mixer-strip]').map(node => node.getAttribute('data-mixer-strip')), ['s1'])
  /* Outside the mixer the same key passes through untouched. */
  act(() => { ui.host.setPanelInfo({ activePanelId: null }) })
  assert.equal(command.resolve({ region: 'page', modal: null, target: null }).status, 'pass')
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
  /* jsdom reports no layout: the stand-in is sized from the pane's own rect. */
  const pane = ui.$('[data-mixer-pane="s1"]')
  pane.getBoundingClientRect = () => ({
    left: 100, width: 420, right: 520, top: 0, bottom: 880, height: 880, x: 100, y: 0,
  })
  const body = stubBody(pane, { width: 420, height: 880 })
  /* The host's width handles are hover-only chrome that may sit a few px outside the
     body: they must not force a skeleton, and they must not ride into the picture. */
  const widthHandle = ui.document.createElement('div')
  widthHandle.setAttribute('data-width-handle', 'left')
  widthHandle.getBoundingClientRect = () => ({
    left: -8, top: 0, width: 0, height: 880, right: -8, bottom: 880, x: -8, y: 0,
  })
  body.appendChild(widthHandle)
  const head = ui.$$('[data-mixer-head]')[0]
  const transfer = fakeDataTransfer(null)
  const start = dragEvent(window, 'dragstart', transfer, { clientX: 140, clientY: 24 })
  act(() => { head.dispatchEvent(start) })
  assert.deepEqual(transfer.written['text/plain'], 's1')
  assert.equal(transfer.effectAllowed, 'move')
  /* Requirement 3: the picture is the WHOLE channel, as a stand-in the same size as
     the pane — never the live pane itself, whose snapshot the browser would stretch
     past the cell once it has a transcript (spec §5.3, 2026-10-20). */
  const image = transfer.written.dragImage
  assert.equal(image.element.getAttribute('data-mixer-drag-ghost'), '')
  assert.notEqual(image.element, pane, 'the live pane must not be the image element')
  assert.equal(image.element.style.position, 'fixed')
  assert.equal(image.element.style.width, '420px')
  assert.equal(image.element.style.height, '880px')
  /* It carries the real header rows, so the ghost still reads as this channel. */
  assert.match(image.element.textContent, /一号会话/)
  assert.match(image.element.textContent, /对话/)
  assert.match(image.element.textContent, /轨迹/)
  /* The offset keeps the ghost under the pointer (`setDragImage`'s x/y). */
  assert.equal(image.x, 40)
  assert.equal(image.y, 24)
  /* Its transcript fits the scroller, so the ghost carries the real body (composer
     and all): only overflowing content has to be replaced by a skeleton. */
  assert.ok(image.element.querySelector('[data-factory="conversation.content"]') !== null)
  assert.ok(image.element.querySelector('[data-composer]') !== null)
  assert.equal(image.element.querySelector('[data-mixer-drag-skeleton]'), null)
  assert.equal(image.element.querySelector('[data-width-handle]'), null)
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

test('interaction: the drag stand-in is withdrawn on the next task (§5.3)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const pane = ui.$('[data-mixer-pane="s1"]')
  pane.getBoundingClientRect = () => ({
    left: 0, width: 400, right: 400, top: 0, bottom: 900, height: 900, x: 0, y: 0,
  })
  const head = () => ui.$$('[data-mixer-head]')[0]
  act(() => { head().dispatchEvent(dragEvent(window, 'dragstart', fakeDataTransfer(null))) })
  const ghost = ui.document.querySelector('[data-mixer-drag-ghost]')
  assert.ok(ghost !== null, 'the image element must be in the document when setDragImage sees it')
  /* Laid out (so it has a layout box to snapshot) but out of sight. */
  assert.equal(ghost.style.left, '-10000px')
  /* A second drag replaces the stand-in instead of stacking them up. */
  act(() => { head().dispatchEvent(dragEvent(window, 'dragstart', fakeDataTransfer(null))) })
  assert.equal(ui.document.querySelectorAll('[data-mixer-drag-ghost]').length, 1)
  /* The browser snapshots synchronously after dragstart, so the next task may drop it. */
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(ui.document.querySelector('[data-mixer-drag-ghost]'), null)
  /* The stand-in never touched the live pane: its body is still mounted. */
  assert.ok(pane.querySelector('[data-mixer-body]') !== null)
})

test('interaction: an empty channel\'s ghost keeps its hero and composer (§5.3)', async () => {
  const ui = await loadInteractive()
  const blankList = {
    ids: ['b1'],
    byId: {
      b1: { id: 'b1', displayTitle: '（空白）', blank: true, running: false, parentId: undefined, cwd: '/repo' },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  ui.draw({
    board: { channels: ['b1'], weights: {} },
    list: blankList,
    status: new Map(),
    workspaces: {
      items: [{ workspaceId: 'w1', title: '主工作区', path: '/repo', sessionIds: ['b1'] }],
      archivedSessionIds: [],
    },
  })
  const { act, window } = ui
  const pane = ui.$('[data-mixer-pane="b1"]')
  pane.getBoundingClientRect = () => ({
    left: 0, width: 400, right: 400, top: 0, bottom: 900, height: 900, x: 0, y: 0,
  })
  stubBody(pane)
  const transfer = fakeDataTransfer(null)
  act(() => { ui.$$('[data-mixer-head]')[0].dispatchEvent(dragEvent(window, 'dragstart', transfer)) })
  const image = transfer.written.dragImage.element
  /* Requirement 1 of round 8: an empty channel's ghost shows what the empty channel
     shows — the host's hero phase (logo/workspace row) plus the composer — because
     none of it overflows, so the browser can snapshot it inside the cell. */
  assert.equal(image.querySelector('[data-factory]').getAttribute('data-hero'), 'yes')
  assert.ok(image.querySelector('[data-composer]') !== null)
  assert.equal(image.querySelector('[data-mixer-drag-skeleton]'), null)
})

test('interaction: a transcript too tall to snapshot becomes a skeleton (§5.3)', async () => {
  const ui = await mountTwo()
  const { act, window } = ui
  const pane = ui.$('[data-mixer-pane="s1"]')
  pane.getBoundingClientRect = () => ({
    left: 0, width: 400, right: 400, top: 0, bottom: 900, height: 900, x: 0, y: 0,
  })
  /* jsdom reports no layout: one descendant laid out below the channel is exactly the
     condition the browser cannot snapshot (spec §5.3). */
  const body = stubBody(pane)
  const transcript = body.querySelector('[data-factory]')
  transcript.getBoundingClientRect = () => ({
    left: 0, top: 880, width: 380, height: 1200, right: 380, bottom: 2080, x: 0, y: 880,
  })
  const transfer = fakeDataTransfer(null)
  act(() => { ui.$$('[data-mixer-head]')[0].dispatchEvent(dragEvent(window, 'dragstart', transfer)) })
  const image = transfer.written.dragImage.element
  /* Requirement 2 (rounds 8-9): the body says "there is a transcript here" with large
     blocks that FILL the height plus a composer silhouette at the bottom, and the
     overflowing live content is NOT cloned in. */
  assert.ok(image.querySelector('[data-mixer-drag-skeleton]') !== null)
  assert.equal(image.querySelector('[data-factory]'), null)
  assert.equal(image.querySelectorAll('[data-mixer-drag-block]').length, 3)
  /* Round 9: the blocks carry MANY text lines (spread over the block height), not a
     couple of thin ones at the top. */
  for (const block of image.querySelectorAll('[data-mixer-drag-block]')) {
    assert.ok(block.children.length >= 6, `expected a dense block, got ${block.children.length} lines`)
  }
  const composer = image.querySelector('[data-mixer-drag-composer]')
  assert.ok(composer !== null)
  /* The composer silhouette is sized like the real one: input line + toolbar chips. */
  assert.equal(composer.children.length, 2)
  assert.ok(composer.children[1].children.length >= 3)
  /* Composer sits last, so the bottom of the picture reads as the input box. */
  const parts = [...image.querySelector('[data-mixer-drag-skeleton]').children]
  assert.equal(parts[parts.length - 1].hasAttribute('data-mixer-drag-composer'), true)
  /* The header is still the real one, so the ghost reads as this channel. */
  assert.match(image.textContent, /一号会话/)
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
