/**
 * Tests for the sidebar-collapse seam (spec §7.1).
 *
 * The host gives us no way to READ the collapsed state: `PanelInfo` carries only
 * `activePanelId` and `ctx.layout.toggleSidebar()` is a blind toggle. The seam stays
 * idempotent by probing the host frame's own `data-sidebar-collapsed` marker, and this
 * file pins that down with a fake DOM whose marker flips exactly when the host's
 * toggle runs. The failure this prevents is the obvious one: a blind toggle would flip
 * the sidebar every time the user enters and leaves the mixer, which reads as a bug
 * and is silent.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPlugin } from './harness.mjs'

const { seams } = await loadPlugin()
const { createSidebar } = seams

/**
 * Fake host: `data-sidebar-collapsed` exists only while collapsed, and the layout
 * toggle is what flips it.
 * @param collapsed - starting state.
 * @returns the ctx, the live state flag, and the toggle log.
 */
function fakeHost(collapsed) {
  let isCollapsed = collapsed
  const toggles = []
  globalThis.document = { querySelector: selector => (selector === '[data-sidebar-collapsed]' && isCollapsed ? {} : null) }
  const ctx = {
    layout: {
      toggleSidebar: () => {
        toggles.push('toggle')
        isCollapsed = !isCollapsed
      },
    },
  }
  return { ctx, toggles, collapsed: () => isCollapsed }
}

test('sidebar: entering an expanded mixer collapses once, leaving restores once', () => {
  const host = fakeHost(false)
  const sidebar = createSidebar(host.ctx)
  sidebar.collapse()
  assert.equal(host.collapsed(), true)
  assert.equal(host.toggles.length, 1)
  sidebar.restore()
  assert.equal(host.collapsed(), false)
  assert.equal(host.toggles.length, 2)
})

test('sidebar: a sidebar the user already collapsed is left alone, and not restored by us', () => {
  const host = fakeHost(true)
  const sidebar = createSidebar(host.ctx)
  sidebar.collapse()
  assert.deepEqual(host.toggles, [], 'must not toggle what we did not collapse')
  sidebar.restore()
  assert.deepEqual(host.toggles, [], 'the user\'s own collapse must survive leaving the mixer')
  assert.equal(host.collapsed(), true)
})

test('sidebar: leaving without having entered toggles nothing', () => {
  const host = fakeHost(false)
  const sidebar = createSidebar(host.ctx)
  sidebar.restore()
  assert.deepEqual(host.toggles, [])
  assert.equal(host.collapsed(), false)
})

test('sidebar: repeated collapse calls do not stack up toggles', () => {
  const host = fakeHost(false)
  const sidebar = createSidebar(host.ctx)
  sidebar.collapse()
  sidebar.collapse()
  assert.equal(host.toggles.length, 1, 'the marker says we are already collapsed')
  sidebar.restore()
  assert.equal(host.toggles.length, 2)
  assert.equal(host.collapsed(), false)
})

test('sidebar: restore after a collapse is a no-op the second time', () => {
  const host = fakeHost(false)
  const sidebar = createSidebar(host.ctx)
  sidebar.collapse()
  sidebar.restore()
  sidebar.restore()
  assert.equal(host.toggles.length, 2, 'the second restore has nothing of ours to undo')
  assert.equal(host.collapsed(), false)
})
