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
- **Run `node spike/boot-check.mjs`** before committing or installing anything under `spike/`. It boots the real module through a real Cordis Context and carries its own control.
