## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `dtdths/dsh-mixer`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles map to same-named labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Plugin gotchas

Verified the hard way on 2026-10-14, when a Cordis service read inside `apply()` broke the whole Web boot. Details and evidence: `docs/plugin-gotchas.md`.

- **Never `if (ctx.someService)`.** A Cordis read of a service the fiber did not inject THROWS (`cannot get property "x" without inject`), so the guard never runs, the entry goes `FAILED`, and the host boot audit fails the entire page. Use `ctx.inject(['someService'], scope => ...)` or declare it in the module's `inject` list.
- **A cold boot is not HMR.** On an already-booted page every service is up, so a broken plugin can look healthy. Any change touching `apply()` needs a cold-load check.
- **`ctx.shortcuts.register` validates every declared default on all five profiles.** A key that is `reserved` on a platform the user never runs still throws (`Reserved shortcut default: <id>`) and fails the entry, and the fake registry in `boot-check.mjs` accepts anything. `tests/host-contract.test.mjs` runs the host's own `bindingIssue` over the shipped defaults for this.
- **Run `npm run check`** (or `node boot-check.mjs`) before committing or installing. It syntax-checks both halves, runs the seam tests, and boots the real module through a real Cordis Context with its own control, asserting the session-scoped child slot and the board store are still declared.
- The prototype lives on the `spike/mixer-two-pane` branch under `spike/`; the shipped plugin is the root package on `main`. Keep the prototypes' lessons in `docs/spec.md`, not in this file.
