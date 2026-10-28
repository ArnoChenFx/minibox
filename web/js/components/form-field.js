/**
 * A labelled control of a dialog's form: the label above the control and, optionally, trusted HTML help under it. The help
 * sits inside the field so it stays close to the control it explains. Shared by the dialogs that ask for several fields,
 * so a field reads the same in each of them.
 */

import { esc } from "../lib/dom.js";

/** A labelled control. `help` is trusted HTML shown under the control, inside the field so it sits close to it. */
export function field(label, inner, help = "") {
  const hint = help ? `<span class="help">${help}</span>` : "";
  return `<label class="field"><span class="label">${esc(label)}</span>${inner}${hint}</label>`;
}
