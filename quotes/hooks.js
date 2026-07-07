// The `md` export (template.md) — the quote as a blockquote + an attribution line.
// Computed in BOTH onInit and onInput: a one-shot (CLI / headless) export only runs
// onInit, so an export-facing extra must be produced there, not only on input change.
function quoteMd(model) {
  const v = id => String(model.find(i => i.id === id)?.value ?? '').trim();
  const quote = v('quote'), attribution = [v('name'), v('company')].filter(Boolean).join(', ');
  let md = '';
  if (quote) md += quote.split('\n').map(l => (l.trim() ? '> ' + l : '>')).join('\n');
  if (attribution) md += (md ? '\n\n' : '') + '— ' + attribution;
  return md + '\n';
}

function onInit({ model }) {
  const patch = { mdSource: quoteMd(model) };
  // Only apply OS preference when theme is still the manifest default ('light').
  const theme = model.find(i => i.id === 'theme');
  if (theme?.value === 'light' && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches) patch.theme = 'dark';
  return patch;
}
function onInput({ model }) { return { mdSource: quoteMd(model) }; }
