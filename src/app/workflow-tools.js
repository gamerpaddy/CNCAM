import { buildJobReport, reportToHtml } from './job-report.js';
import { el, dialogCloseButton } from './layout.js';
import { openFile, saveFile } from '../io/files.js';

const KEY = 'cncam.operationPresets.v1';
const ACCEPT = { description: 'Operation presets', mime: { 'application/json': ['.json'] }, extensions: ['.json'] };
export function reusableParams(params) {
  return Object.fromEntries(Object.entries(params ?? {}).filter(([key, value]) =>
    !/id$|ids$|region|pick/i.test(key) && (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))));
}
function readPresets() {
  const items = JSON.parse(localStorage.getItem(KEY) || '[]');
  if (!Array.isArray(items)) throw new Error('Invalid preset library');
  return items.filter(p => p && typeof p.name === 'string' && typeof p.type === 'string' && p.params && typeof p.params === 'object').map(p => {
    const pattern = { finish5Concentric: 'concentric', finish5Spiral: 'spiral', finish5Radial: 'radial' }[p.type];
    return pattern ? { ...p, type: 'finish5', params: { ...p.params, pattern } } : p;
  });
}
export function presetButton(doc, op, app) {
  return el('button', { type: 'button', onclick: () => openPresets(doc, op, app) }, ['Operation presets…']);
}
function openPresets(doc, op, app) {
  const dialog = el('dialog', { class: 'workflow-dialog', 'aria-label': 'Operation presets' });
  const list = el('div');
  const name = el('input', { value: op.name || op.type, 'aria-label': 'Preset name', maxlength: '100' });
  const message = el('p', { role: 'status' });
  const report = e => { message.textContent = e.message; };
  const refresh = () => {
    list.replaceChildren();
    try {
      for (const preset of readPresets().filter(p => p.type === op.type)) {
        const preview = el('details', {}, [el('summary', {}, [preset.name]), el('pre', {}, [JSON.stringify(preset.params, null, 2)])]);
        list.append(el('div', { class: 'preset-row' }, [preview,
          el('button', { onclick: () => {
            const params = reusableParams(preset.params);
            const patch = Object.fromEntries(Object.entries(params).filter(([k, v]) => k in op.params && typeof v === typeof op.params[k]));
            doc.updateItem(op.params, patch, `apply preset ${preset.name}`);
            dialog.close();
            app?.ui?.setStatus(`Applied ${preset.name} — check heights and stepping for this tool and stock`);
          } }, ['Apply']),
          el('button', { onclick: () => { try {
            const next = window.prompt('Preset name', preset.name)?.trim();
            if (!next || next === preset.name) return;
            const presets = readPresets();
            if (presets.some(p => p.type === preset.type && p.name === next)) throw new Error('That name already exists');
            const item = presets.find(p => p.type === preset.type && p.name === preset.name);
            if (item) item.name = next.slice(0, 100);
            localStorage.setItem(KEY, JSON.stringify(presets)); refresh();
          } catch(e) { report(e); } } }, ['Rename']),
          el('button', { onclick: () => { try {
            localStorage.setItem(KEY, JSON.stringify(readPresets().filter(p => p !== preset && !(p.name === preset.name && p.type === preset.type)))); refresh();
          } catch(e) { report(e); } } }, ['Delete'])]));
      }
      if (!list.children.length) list.append(el('p', {}, ['No presets for this operation yet.']));
    } catch(e) { report(e); }
  };
  dialog.append(el('h2', {}, ['Operation presets']), dialogCloseButton(dialog),
    el('p', {}, ['Presets keep parameters only. Tools and geometry selections stay with the job. Review heights before generating.']), name,
    el('button', { onclick: () => { try {
      const label = name.value.trim(); if (!label) throw new Error('Enter a preset name');
      const presets = readPresets().filter(p => !(p.name === label && p.type === op.type));
      presets.push({ name: label, type: op.type, params: reusableParams(op.params) });
      localStorage.setItem(KEY, JSON.stringify(presets)); refresh(); message.textContent = 'Preset saved';
    } catch(e) { report(e); } } }, ['Save current parameters']), message, list,
    el('button', { onclick: async () => { try { await saveFile('operation-presets.json', JSON.stringify(readPresets(), null, 2), ACCEPT); } catch(e) { report(e); } } }, ['Export presets']),
    el('button', { onclick: async () => { try {
      const file = await openFile(ACCEPT); if (!file) return;
      const imported = JSON.parse(new TextDecoder().decode(file.buffer));
      if (!Array.isArray(imported) || imported.length > 1000) throw new Error('Invalid preset library');
      const existing = readPresets();
      for (const p of imported) {
        if (!p || typeof p.name !== 'string' || typeof p.type !== 'string' || !p.params || typeof p.params !== 'object') throw new Error('Invalid preset record');
        const clean = { name: p.name.slice(0,100), type: p.type, params: reusableParams(p.params) };
        const index = existing.findIndex(x => x.name === clean.name && x.type === clean.type);
        if (index >= 0) existing[index] = clean; else existing.push(clean);
      }
      localStorage.setItem(KEY, JSON.stringify(existing)); refresh();
    } catch(e) { report(e); } } }, ['Import presets']),
    el('button', { onclick: () => dialog.close() }, ['Done']));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); refresh(); dialog.showModal();
}

const SHEET_ACCEPT = { description: 'Setup sheet', mime: { 'text/html': ['.html'] }, extensions: ['.html'] };

/**
 * The setup and tool sheet. Every figure comes from buildJobReport, which reads
 * the numbers the program really uses (an operation's own feed over its tool's),
 * so what is printed beside the machine is what the file says.
 */
export function showSetupSheet(doc, stockFor, sim = null) {
  const report = buildJobReport(doc, { stockFor, sim });
  const dialog = el('dialog', { class: 'workflow-dialog setup-sheet', 'aria-label': 'Setup and tool sheet' });
  const table = (head, rows) => el('table', {}, [
    el('thead', {}, [el('tr', {}, head.map(x => el('th', {}, [x])))]),
    el('tbody', {}, rows.map(r => el('tr', {}, r.map(x => el('td', {}, [String(x ?? '—')])))))]);
  dialog.append(el('h1', {}, [report.project]), dialogCloseButton(dialog),
    el('p', {}, [`Setup and tool sheet · ${report.generatedAt} · Machine: ${report.machine} · Post: ${report.post}`]),
    el('p', { class: 'sheet-total' }, [`Total ${report.totals.timeText} — ${report.totals.operations} operations, `
      + `${report.totals.toolChanges} tool change${report.totals.toolChanges === 1 ? '' : 's'}`]));
  if (report.tools.length) {
    dialog.append(el('section', { class: 'sheet-tools' }, [el('h2', {}, ['Tools']),
      table(['T', 'Tool', 'Type', 'Ø mm', 'Flutes', 'Stick-out mm', 'Used by'],
        report.tools.map(t => [`T${t.number}`, t.name, t.kind, t.diameter, t.flutes, t.stickOut, t.operations.join(', ')]))]));
  }
  for (const s of report.setups) {
    dialog.append(el('section', { class: 'sheet-setup' }, [el('h2', {}, [s.name]),
      el('p', {}, [`Work offset: ${s.wcs ?? 'not specified'} · Stock: ${s.stockSize} · Fixtures: ${s.fixtures.join(', ') || 'none'} · Time: ${s.timeText}`]),
      el('details', { open: true }, [el('summary', {}, ['Stock definition']), el('pre', {}, [JSON.stringify(s.stock, null, 2)])]),
      table(['Operation', 'Tool', 'RPM', 'Cut feed (mm/min)', 'Plunge', 'Estimated time', 'Status'],
        s.rows.map(r => [r.name + (r.changesTool ? ' (tool change)' : ''),
          r.tool ? `T${r.tool.number} ${r.tool.name} (Ø${r.tool.diameter ?? '?'} mm)` : (r.command ? 'G-code block' : 'No tool'),
          r.rpm, r.feed, r.plunge, r.timeText, r.status]))]));
  }
  if (report.verify) {
    dialog.append(el('section', { class: 'sheet-verify' }, [el('h2', {}, ['Check of the finished part']),
      el('ul', {}, [...report.verify.lines, ...report.verify.findings].map(l => el('li', {}, [l])))]));
  }
  const status = el('p', { role: 'status' });
  dialog.append(el('p', {}, ['Programmed values are shown; verify tool assignments, stock, offsets, and simulation before machining.']),
    el('button', { onclick: () => window.print() }, ['Print / Save PDF']),
    el('button', { onclick: async () => { try {
      const saved = await saveFile(`${report.project || 'job'} setup sheet.html`, reportToHtml(report), SHEET_ACCEPT);
      status.textContent = saved ? 'Saved as a page that opens in any browser' : 'Not saved';
    } catch (e) { status.textContent = e.message; } } }, ['Save as HTML']),
    el('button', { onclick: () => dialog.close() }, ['Close']), status);
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
}
