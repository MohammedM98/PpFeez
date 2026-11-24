/**
 * Single-key shortcuts (SPEC 6.10) stay quiet while typing in a field, inside a dialog or menu, or with
 * Ctrl / Alt / Cmd held. Checkboxes and radios don't count as typing.
 */
export function quietKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return true;
  const t = e.target as HTMLElement | null;
  if (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'radio') return true;
  if (t?.closest('textarea, select, [contenteditable=true], [role=dialog], [role=alertdialog], [role=menu], [role=listbox]')) return true;
  return !!document.querySelector('[role=dialog][aria-modal=true]');
}
