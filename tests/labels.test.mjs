/**
 * Wording parity with the sidebar.
 *
 * Spec §4.3b requires a channel and its sidebar row to describe the same Session the
 * same way, and §1 defers the locale service to phase 2 (v1 hardcodes Simplified
 * Chinese). Hardcoded strings drift silently, which is exactly what happened during
 * the port: `plan-review` was 「等待计划确认」 in the plugin while the sidebar says
 * 「计划待审」. So this file parses the sidebar's own dictionary out of the host
 * checkout and fails on any mismatch, including the rendered dot labels.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { loadPlugin } from './harness.mjs'

const DSH_REPO = process.env.DSH_REPO ?? '/Users/user/Documents/code/deepseek-harness'
const LOCALES = `${DSH_REPO}/packages/client/ui-workspace/src/client/locales.ts`

const { seams } = await loadPlugin()
const { labels, channelState, visiblePendingKind } = seams

/**
 * Extract the Simplified Chinese `status.*` strings from the sidebar's dictionary.
 * @returns key → message (e.g. `waitingApproval` → 等待审批).
 */
function hostStatusLabels() {
  const source = readFileSync(LOCALES, 'utf8')
  const start = source.indexOf('export const zh = {')
  const end = source.indexOf('export const en = {')
  assert.ok(start >= 0 && end > start, `could not locate the zh dictionary in ${LOCALES}`)
  const zh = source.slice(start, end)
  const table = {}
  for (const match of zh.matchAll(/'status\.([A-Za-z.]+)':\s*'([^']*)'/g)) table[match[1]] = match[2]
  assert.ok(Object.keys(table).length >= 8, 'the status table looks unexpectedly small')
  return table
}

const host = hostStatusLabels()
const fill = (template, n) => template.replace('{n}', String(n))

test('labels: every waiting kind uses the sidebar\'s own wording', () => {
  assert.equal(labels.kinds.approval, host.waitingApproval)
  assert.equal(labels.kinds['plan-review'], host.planReview)
  assert.equal(labels.kinds.question, host.waitingAnswer)
})

test('labels: running / completed / idle use the sidebar\'s own wording', () => {
  assert.equal(labels.states.running, host.running)
  assert.equal(labels.states.completed, host.completed)
  assert.equal(labels.states.idle, host.idle)
})

test('labels: the subagent label interpolates like the sidebar\'s one/other forms', () => {
  assert.equal(labels.subagents(1), fill(host['subagentsRunning.one'], 1))
  assert.equal(labels.subagents(4), fill(host['subagentsRunning.other'], 4))
})

test('labels: the rendered dots carry exactly those strings (no second copy can drift)', () => {
  assert.equal(channelState({ pendingKind: undefined, running: true, subagents: 0, completed: false })
    .dots[0].label, host.running)
  assert.equal(channelState({ pendingKind: undefined, running: true, subagents: 2, completed: false })
    .dots[1].label, fill(host['subagentsRunning.other'], 2))
  assert.equal(channelState({ pendingKind: undefined, running: false, subagents: 0, completed: true })
    .dots[0].label, host.completed)
  assert.equal(channelState({ pendingKind: undefined, running: false, subagents: 1, completed: false })
    .dots[0].label, fill(host['subagentsRunning.one'], 1))
})

test('labels: the three whitelisted kinds are the ones the host shows, and only those', () => {
  const shown = ['approval', 'plan-review', 'question']
  assert.deepEqual(Object.keys(labels.kinds).sort(), [...shown].sort())
  for (const kind of shown) {
    assert.equal(visiblePendingKind({ pendingInteraction: { kind } }), kind)
  }
  /* A kind the sidebar hides must not produce a label at all. */
  assert.equal(visiblePendingKind({ pendingInteraction: { kind: 'mystery-domain-kind' } }), undefined)
})
