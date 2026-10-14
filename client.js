/**
 * dsh-mixer — Client half (Web UI).
 *
 * SCAFFOLD: this module deliberately renders nothing yet. The extension point
 * (which slot owns the view toggle, and how N independent conversation panes are
 * driven off one client runtime) is still open — see docs/open-questions.md.
 * Replace the body below once that is settled; do not install this as-is.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mixer',
  factory(require) {
    return {
      inject: [],
      apply() {
        // TODO(dsh-mixer): register the view toggle and the channel grid here.
      },
    };
  },
});
