import { buildJobReport, reportToHtml } from './job-report.js';
import { gridCopies, circleCopies, overlappingCopies } from '../engine/instances.js';
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

/**
 * The proposed running order: what it saves and in what order it would run, with
 * nothing done until Apply — and one undo step when it is.
 */
export function showOrderPlan({ setup, plan, nameOf, onApply }) {
  const dialog = el('dialog', { class: 'workflow-dialog order-plan', 'aria-label': 'Optimise the running order' });
  const secs = (v) => `${Math.round(v)} s`;
  dialog.append(el('h2', {}, [`Running order for ${setup.name}`]), dialogCloseButton(dialog),
    el('p', {}, [`Tool changes: ${plan.before.changes} → ${plan.after.changes}. `
      + `Travel between operations: ${secs(plan.before.travelSeconds)} → ${secs(plan.after.travelSeconds)}. `
      + `Saves about ${secs(plan.before.seconds - plan.after.seconds)} in all.`]),
    el('p', {}, ['Operations that cut the same ground, anything that reads what came before it, holes (spot, drill, then tap), '
      + 'commands and the cut that frees the part keep their order; only operations in different places change places.']),
    el('ol', {}, plan.order.map((id) => el('li', {}, [nameOf(id)]))),
    el('button', { onclick: () => { dialog.close(); onApply(); } }, ['Apply']),
    el('button', { onclick: () => dialog.close() }, ['Leave the order as it is']));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * What was recognised on the part and the operations proposed for it, as a
 * checklist. Nothing is added until Apply, and everything ticked is added as one
 * undo step. A proposal whose cutter is not in the rack says so, because the
 * apply will make that cutter.
 *
 * @param toolFor (proposal) => { tool, created } — the cutter it would get
 */
export function showFeaturePlan({ setup, result, toolFor, onApply }) {
  const dialog = el('dialog', { class: 'workflow-dialog feature-plan', 'aria-label': 'Operations for this part' });
  const boxes = [];
  const rows = result.proposals.map((p) => {
    const box = el('input', { type: 'checkbox', 'aria-label': p.label });
    box.checked = p.enabled;
    boxes.push([p, box]);
    const got = toolFor(p);
    const toolText = got ? `${got.created ? 'new ' : ''}T${got.tool.number} ${got.tool.name}` : '';
    return el('li', { class: 'feature-row' }, [
      el('label', {}, [box, ' ', p.label]),
      el('div', { class: 'prop-hint' }, [[p.detail, toolText && `cutter: ${toolText}`].filter(Boolean).join(' · ')]),
      ...p.warnings.map((w) => el('div', { class: 'prop-note warn' }, [w])),
    ]);
  });
  dialog.append(el('h2', {}, [`Operations for ${setup.name}`]), dialogCloseButton(dialog),
    el('p', {}, [result.summary]),
    rows.length ? el('ul', { class: 'feature-list' }, rows) : el('p', {}, [result.warnings.join(' ') || 'Nothing to propose.']),
    el('p', {}, ['These are a starting point: every one is an ordinary operation you can change. Read each toolpath before you cut.']));
  if (rows.length) {
    dialog.append(el('button', { onclick: () => {
      const chosen = boxes.filter(([, box]) => box.checked).map(([p]) => p.id);
      dialog.close();
      onApply(chosen);
    } }, ['Add the ticked operations']));
  }
  dialog.append(el('button', { onclick: () => dialog.close() }, [rows.length ? 'Cancel' : 'Close']));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Copies of the part on the table, as a grid or a circle, with the placements
 * shown before they are made and refused when two of them would touch.
 *
 * @param bounds the part's XY box in the frame the table sees it
 * @param pivot the XY a copy turns about
 * @param current the copies the setup has now
 * @param onApply (copies) => void
 */
export function showArrayDialog({ setup, bounds, pivot, current, clearance = 3, onApply }) {
  const dialog = el('dialog', { class: 'workflow-dialog array-dialog', 'aria-label': 'Copies of the part' });
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[1] - bounds.min[1];
  const num = (label, value, extra = {}) => {
    const input = el('input', { type: 'number', value: String(value), step: 'any', 'aria-label': label, ...extra });
    return { input, row: el('label', { class: 'array-field' }, [label, input]) };
  };
  const kind = el('select', { 'aria-label': 'Layout' }, [
    el('option', { value: 'grid' }, ['Grid']), el('option', { value: 'circle' }, ['Circle'])]);
  const cols = num('Columns (X)', 2, { min: '1', max: '50' });
  const rows = num('Rows (Y)', 1, { min: '1', max: '50' });
  const sx = num('Spacing X (mm)', Math.ceil((width + 10) * 10) / 10);
  const sy = num('Spacing Y (mm)', Math.ceil((depth + 10) * 10) / 10);
  const count = num('Parts in all', 4, { min: '2', max: '200' });
  const radius = num('Circle radius (mm)', Math.ceil(Math.max(width, depth) * 1.5));
  const start = num('Original at (degrees)', 0);
  const turn = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Turn each part to the circle' });
  const gridRows = [cols.row, rows.row, sx.row, sy.row];
  const circleRows = [count.row, radius.row, start.row, el('label', { class: 'array-field' }, ['Turn each to face the centre', turn])];
  const status = el('p', { role: 'status', class: 'array-status' });
  const apply = el('button', { disabled: true }, ['Make the copies']);
  const copiesNow = () => (kind.value === 'grid'
    ? gridCopies({ columns: Number(cols.input.value), rows: Number(rows.input.value), spacingX: Number(sx.input.value), spacingY: Number(sy.input.value) })
    : circleCopies({ count: Number(count.input.value), radius: Number(radius.input.value), startDeg: Number(start.input.value), turn: turn.checked }));
  const refresh = () => {
    for (const r of gridRows) r.style.display = kind.value === 'grid' ? '' : 'none';
    for (const r of circleRows) r.style.display = kind.value === 'circle' ? '' : 'none';
    const copies = copiesNow();
    const all = copies.every((c) => Number.isFinite(c.dx) && Number.isFinite(c.dy) && Number.isFinite(c.rotZ));
    const clash = all ? overlappingCopies(bounds, copies, pivot, clearance) : [];
    let message;
    if (!all) message = 'Those numbers do not make a layout.';
    else if (copies.length === 0) message = 'That is one part: no copies.';
    else if (copies.length + 1 > 200) message = 'More than 200 parts is not a layout.';
    else if (clash.length) message = `Parts ${clash[0][0] + 1} and ${clash[0][1] + 1} are closer than ${clearance} mm (${clash.length} such pair${clash.length === 1 ? '' : 's'}): the cutter has to get between them.`;
    else message = `${copies.length + 1} parts in all: the original and ${copies.length} cop${copies.length === 1 ? 'y' : 'ies'}.`;
    status.textContent = message;
    status.classList.toggle('warn', !!clash.length || !all);
    apply.disabled = !all || copies.length === 0 || clash.length > 0 || copies.length + 1 > 200;
    return copies;
  };
  for (const input of [kind, cols.input, rows.input, sx.input, sy.input, count.input, radius.input, start.input, turn]) {
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);
  }
  apply.addEventListener('click', () => { const copies = refresh(); if (apply.disabled) return; dialog.close(); onApply(copies); });
  dialog.append(el('h2', {}, [`Copies of the part in ${setup.name}`]), dialogCloseButton(dialog),
    el('p', {}, [`The part is ${width.toFixed(1)} × ${depth.toFixed(1)} mm. Every operation in this setup is generated over all of the copies, `
      + 'so one tool change serves every part. They share one work offset.']),
    el('label', { class: 'array-field' }, ['Layout', kind]), ...gridRows, ...circleRows, status,
    apply,
    current?.length ? el('button', { onclick: () => { dialog.close(); onApply([]); } }, [`Remove the ${current.length} copies`]) : el('span'),
    el('button', { onclick: () => dialog.close() }, ['Cancel']));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  refresh();
  dialog.showModal();
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
