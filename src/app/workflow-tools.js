import { opFingerprint, formatTime } from './op-status.js';
import { estimateSeconds } from '../engine/toolpath.js';
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

export function showSetupSheet(doc, stockFor) {
  const dialog = el('dialog', { class: 'workflow-dialog setup-sheet', 'aria-label': 'Setup and tool sheet' });
  dialog.append(el('h1', {}, [doc.project.name]), dialogCloseButton(dialog), el('p', {}, [`Setup and tool sheet · ${new Date().toLocaleString()}`]));
  for (const setup of doc.setups()) {
    const stock = stockFor?.(setup);
    const dimensions = stock ? stock.max.map((v, i) => (v - stock.min[i]).toFixed(2)).join(' × ') + ' mm' : 'not resolved';
    const section = el('section', {}, [el('h2', {}, [setup.name]),
      el('p', {}, [`Machine: ${doc.machineRecord()?.name || doc.machine} · Post: ${doc.postId()} · Work offset: ${setup.wcs ?? 'not specified'}`]),
      el('p', {}, [`Stock dimensions: ${dimensions} · Fixtures: ${(setup.fixtures ?? []).map(f => f.name || f.kind).join(', ') || 'none'}`]),
      el('details', { open: true }, [el('summary', {}, ['Stock definition']), el('pre', {}, [JSON.stringify(setup.stock, null, 2)])])]);
    const table = el('table', {}, [el('thead', {}, [el('tr', {}, ['Operation','Tool','RPM','Cut feed (mm/min)','Estimated time','Status'].map(x => el('th', {}, [x])))])]);
    const body = el('tbody');
    for (const op of setup.operations) {
      const tool = doc.project.tools.find(t => t.id === op.toolId);
      body.append(el('tr', {}, [op.name, tool ? `T${tool.number} ${tool.name} (Ø${tool.diameter ?? '?'} mm)` : 'No tool', tool?.spindleRpm ?? '—', tool?.feedCut ?? '—', doc.toolpaths.has(op.id) ? formatTime(estimateSeconds(doc.toolpaths.get(op.id), doc.rapidFeed())) : '—', !op.enabled ? 'Disabled' : doc.failures.get(op.id) || (doc.toolpaths.has(op.id) ? (doc.fingerprints.get(op.id) === opFingerprint(doc, op, setup) ? 'Generated — verify simulation' : 'Out of date') : 'Not generated')].map(x => el('td', {}, [String(x)]))));
    }
    table.append(body); section.append(table); dialog.append(section);
  }
  dialog.append(el('p', {}, ['Programmed values are shown; verify tool assignments, stock, offsets, and simulation before machining.']), el('button', { onclick: () => window.print() }, ['Print / Save PDF']), el('button', { onclick: () => dialog.close() }, ['Close']));
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
}
