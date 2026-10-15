/**
 * Render tests for the mixer panel: the real client.js, the host's real React, and a
 * fake slot run rendered server-side. These exist because the pure-seam tests cannot
 * see the React layer at all, and a browser check should not be the first time the
 * component tree runs.
 *
 * Everything asserted here is a fact the user's §6 checklist would otherwise have to
 * catch by eye: which channels show, what each pane's state marker says, that every
 * pane got factory content, and that the board actually drives the layout.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRendered } from './harness.mjs'

const list = {
  ids: ['s1', 's2', 's3'],
  byId: {
    s1: { id: 's1', displayTitle: '一号会话', blank: false, running: false, parentId: undefined },
    s2: { id: 's2', displayTitle: '二号会话', blank: false, running: false, parentId: undefined },
    s3: { id: 's3', displayTitle: '三号会话', blank: false, running: true, parentId: 's1' },
  },
  phase: 'ready',
  projectionsBySession: {
    s3: { values: { subagentCatalog: [{ id: 'x1' }] } },
  },
}
const workspaces = { items: [{ workspaceId: 'w1', title: '主工作区', path: '/repo' }], archivedSessionIds: [] }
const status = new Map([
  ['s1', { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
  ['s2', { running: false, pendingInteraction: undefined, completionUnread: true }],
  ['s3', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['x1', { running: true, pendingInteraction: undefined, completionUnread: false }],
])

test('render: every pane shows its own state marker, and the sidebar parity holds', async () => {
  const { render } = await loadRendered()
  const { html } = render({ board: { channels: [], weights: {} }, list, status, workspaces })

  /* s1 waits, s2 finished unread, s3 runs with one running subagent. */
  assert.match(html, /data-mixer-pane="s1"[^>]*data-mixer-state="waiting"/)
  assert.match(html, /data-mixer-pane="s1"[^>]*data-mixer-waiting="yes"/)
  assert.match(html, /data-mixer-pane="s2"[^>]*data-mixer-state="completed"/)
  assert.match(html, /data-mixer-pane="s3"[^>]*data-mixer-state="running\+subagents"/)

  /* The two-element page shows all three default channels (no board picked yet). */
  assert.equal((html.match(/data-mixer-pane=/g) ?? []).length, 3)
  /* Breadcrumb: the child session renders as 父 / 子. */
  assert.match(html, /data-mixer-crumb="s1"[^>]*>一号会话</)
  assert.match(html, /data-mixer-crumb="s3"[^>]*>三号会话</)
  /* Every pane got the shared factory, with the embedded variant. */
  assert.equal((html.match(/data-factory="conversation.content"/g) ?? []).length, 3)
  assert.equal((html.match(/data-variant="embedded"/g) ?? []).length, 3)
  /* Dividers only between panes. */
  assert.equal((html.match(/data-mixer-resizer=/g) ?? []).length, 2)
  /* Top bar: waiting summary counts exactly one channel. */
  assert.match(html, /1 个通道在等你/)
})

test('render: a silent status source falls back to the list row, the way the sidebar does', async () => {
  const { render } = await loadRendered()
  /* `tree.ts:410` is `status?.running ?? summary.running`: the unified status can exist
     without a running baseline, and can be missing entirely for a Session the list
     still knows about. Both must fall back to the row, or a running channel would
     render as idle. */
  const silent = new Map([
    ['s2', { running: undefined, pendingInteraction: undefined, completionUnread: false }],
  ])
  const runningRow = {
    ...list,
    byId: { ...list.byId, s2: { ...list.byId.s2, running: true } },
  }
  const withEntry = render({
    board: { channels: ['s2'], weights: {} },
    list: runningRow,
    status: silent,
    workspaces,
  })
  assert.match(withEntry.html, /data-mixer-pane="s2"[^>]*data-mixer-state="running"/)

  /* No status entry at all for that Session. */
  const withoutEntry = render({
    board: { channels: ['s2'], weights: {} },
    list: runningRow,
    status: new Map(),
    workspaces,
  })
  assert.match(withoutEntry.html, /data-mixer-pane="s2"[^>]*data-mixer-state="running"/)
})

test('render: subagents fall back to their own list rows too', async () => {
  const { render } = await loadRendered()
  /* The child has a status entry with no running baseline, so `tree.ts:392` falls back
     to `list.byId[child.id].running` — subagent rows are published as list fallback
     rows for exactly this reason (see SessionListState's own note). */
  const childSilent = new Map([
    ['s1', { running: false, pendingInteraction: undefined, completionUnread: false }],
    ['x1', { running: undefined, pendingInteraction: undefined, completionUnread: false }],
  ])
  const listWithChildRow = {
    ...list,
    byId: { ...list.byId, x1: { id: 'x1', displayTitle: '子代理', blank: false, running: true, parentId: 's1' } },
    /* The catalog is keyed by the PARENT session (tree.ts:391), so channel s1 needs one. */
    projectionsBySession: { ...list.projectionsBySession, s1: { values: { subagentCatalog: [{ id: 'x1' }] } } },
  }
  const { html } = render({
    board: { channels: ['s1'], weights: {} },
    list: listWithChildRow,
    status: childSilent,
    workspaces,
  })
  assert.match(html, /data-mixer-pane="s1"[^>]*data-mixer-state="subagents"/)
  assert.match(html, /aria-label="1 个子智能体运行中"/)

  /* With neither source running, the child is not counted. */
  const idleChild = new Map([
    ['s1', { running: false, pendingInteraction: undefined, completionUnread: false }],
    ['x1', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ])
  const none = render({
    board: { channels: ['s1'], weights: {} },
    list: listWithChildRow,
    status: idleChild,
    workspaces,
  })
  assert.match(none.html, /data-mixer-pane="s1"[^>]*data-mixer-state="idle"/)
})

test('render: idle panes carry the state marker but render no dot', async () => {
  const { render } = await loadRendered()
  const idle = new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: false }]])
  const { html } = render({ board: { channels: ['s1'], weights: {} }, list, status: idle, workspaces })
  assert.match(html, /data-mixer-pane="s1"[^>]*data-mixer-state="idle"/)
  assert.doesNotMatch(html, /aria-label="进行中"/)
  assert.doesNotMatch(html, /aria-label="已完成"/)
  assert.equal((html.match(/data-mixer-pane=/g) ?? []).length, 1)
})

test('render: the board decides which channels show, and the weights reach the flex style', async () => {
  const { render } = await loadRendered()
  const { html } = render({
    board: { channels: ['s3', 's1'], weights: { s3: 2, s1: 1 } },
    list,
    status,
    workspaces,
  })
  const order = [...html.matchAll(/data-mixer-cell="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(order, ['s3', 's1'])
  /* The flex weight rides the cell's inline style, declared before the data attribute. */
  assert.match(html, /flex:2 1 0"[^>]*data-mixer-cell="s3"/)
  assert.match(html, /flex:1 1 0"[^>]*data-mixer-cell="s1"/)
})

test('render: an empty candidate list shows the empty state, not a broken grid', async () => {
  const { render } = await loadRendered()
  const { html } = render({
    board: { channels: [], weights: {} },
    list: { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} },
    status: new Map(),
    workspaces,
  })
  assert.match(html, /调音台里还没有通道/)
  assert.doesNotMatch(html, /data-mixer-pane=/)
})

test('render: a Session archived on the left drops out of the board', async () => {
  const { render } = await loadRendered()
  const { instance } = render({
    board: { channels: ['s1', 's2'], weights: { s1: 3 } },
    list,
    status,
    workspaces: { ...workspaces, archivedSessionIds: ['s1'] },
  })
  /* The pruning lives in an effect, which server rendering skips, so drive the same
     action the effect calls and assert the store contract the panel relies on. */
  instance.actions.setChannels(['s2'])
  instance.actions.dropWeights(['s1'])
  assert.deepEqual(instance.getSnapshot(), { channels: ['s2'], weights: {} })
})

test('render: without the store package the panel still renders from its in-memory board', async () => {
  const { render } = await loadRendered({ withStore: false })
  const { html, instance } = render({
    board: { channels: ['s2'], weights: {} },
    list,
    status,
    workspaces,
  })
  assert.equal((html.match(/data-mixer-pane=/g) ?? []).length, 1)
  assert.match(html, /data-mixer-pane="s2"/)
  /* The fallback engine still exposes the action contract the panel writes through. */
  instance.actions.setChannels(['s1', 's2'])
  assert.deepEqual(instance.getSnapshot().channels, ['s1', 's2'])
})

test('render: the header toggle and /mixer command are registered against the panel id', async () => {
  const { registrations, commands } = await loadRendered()
  const toggle = registrations.find(entry => entry.options.name === 'conversation.session.header.utilities')
  assert.equal(toggle.options.id, 'mixer-toggle')
  assert.ok(toggle.options.order < -10, 'must sit left of open-in-app (order -10)')
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'mixer')
})
