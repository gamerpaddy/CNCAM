// The command palette: every action in the app, found by typing.
//
// The toolbar holds the dozen things done in every job; the other fifty (a
// named view, the projection, a colour scheme, "check a G-code file") are in
// menus, dialogs and a key list nobody reads. This is the one place that
// answers "how do I do X" by letting you say X.
//
// It owns no list of its own to keep in step. The keys come from the table in
// shortcuts.js, the view names from views.js, and the preference rows from the
// settings table — so a shortcut or a setting added there is findable here the
// moment it exists, with the label it already has.

import { el } from './layout.js';
import { shortcuts } from './shortcuts.js';
import { SETTINGS, getSetting, setSetting } from './settings.js';
import { VIEW_PRESETS, allViewsFor, PROJECTIONS, PROJECTION_LABELS } from '../view/views.js';

const MAX_SHOWN = 60;

/**
 * Everything the palette can run, as { group, label, keys?, hint?, run }.
 * Built each time it opens: what is enabled, and which views exist, depends on
 * the job and the machine in front of you.
 */
export function paletteCommands(ctx) {
  const { actions, ui, doc } = ctx;
  const out = [];

  // The key table first: these already have a label and a key worth showing.
  for (const s of shortcuts(ctx)) {
    if (s.alias || s.keys === 'Escape') continue;
    if (s.enabled && !s.enabled()) continue;
    out.push({ group: s.group, label: s.label, keys: s.keys, run: s.run });
  }
  const have = (name) => typeof actions?.[name] === 'function';
  const add = (group, label, name, hint) => {
    if (have(name)) out.push({ group, label, hint, run: () => actions[name]() });
  };

  add('File', 'New project', 'clearProject');
  add('File', 'Open a project file…', 'openProject');
  add('File', 'Projects in this browser…', 'browseProjects');
  add('File', 'Import a drawing (DXF)…', 'importDrawing');
  add('File', 'Check a G-code file…', 'checkGcode',
    'Draw, simulate and check any .nc file against this setup');
  add('File', 'Export G-code — a file per operation…', 'exportOperationsSeparately');
  add('File', 'Setup and tool sheet…', 'showSetupSheet');
  add('Job', 'Add a setup', 'addSetup');
  add('Job', 'Optimise the running order…', 'optimiseOrder',
    'Fewer tool changes and less travel, without moving anything that depends on what came before');
  add('Job', 'Set feeds from the cut (selected operation, or all)', 'optimiseFeeds',
    'Measures how much of the cutter is in the metal along each path and varies the feed to suit');
  add('Tools', 'Add cutters from the library…', 'addToolsFromLibrary');
  add('Tools', 'Make a new cutter…', 'newTool');
  add('Tools', 'Import a tool catalogue…', 'importTools');
  add('Tools', 'Export the tools…', 'exportTools');
  if (have('toggleToolpaths')) {
    out.push({ group: 'View', label: 'Show or hide all toolpaths', run: () => actions.toggleToolpaths() });
  }
  out.push({
    group: 'View',
    label: 'Show or hide the G-code console',
    run: () => ui.setGcodeOpen(ui.gcode.classList.contains('collapsed')),
  });
  out.push({
    group: 'View',
    label: 'Reset the panel sizes',
    run: () => { ui.resetPanels(); ui.setStatus('Panels are back at their default sizes'); },
  });

  // Named views, for the machine in front of you.
  for (const key of allViewsFor(doc.machine)) {
    const preset = VIEW_PRESETS[key];
    if (preset) out.push({ group: 'View', label: `${preset.label} view`, hint: preset.hint, run: () => actions.setView(key) });
  }
  for (const mode of PROJECTIONS) {
    out.push({ group: 'View', label: `Projection: ${PROJECTION_LABELS[mode]}`, run: () => actions.setProjection(mode) });
  }

  // Preferences that are a look rather than a behaviour, straight off the
  // table: one command per choice, applied the way the Options dialog applies it.
  const apply = (setting, value) => () => {
    setSetting(setting.key, value);
    ctx.applySettings?.(setting.key);
    if (setting.key === 'hintStyle') ctx.rerenderProps?.();
    ui.setStatus(`${setting.label}: ${setting.labels?.[value] ?? (value === true ? 'on' : value === false ? 'off' : value)}`);
  };
  for (const setting of SETTINGS) {
    if (!['Appearance', 'Viewport', 'Experimental'].includes(setting.group)) continue;
    if (setting.type === 'checkbox') {
      out.push({
        group: 'Options',
        label: `${getSetting(setting.key) ? 'Hide' : 'Show'}: ${setting.label}`,
        run: apply(setting, !getSetting(setting.key)),
      });
    } else if (setting.type === 'select' && setting.key !== 'projection') {
      for (const option of setting.options) {
        if (String(getSetting(setting.key)) === option) continue;
        out.push({
          group: 'Options',
          label: `${setting.label}: ${setting.labels?.[option] ?? option}`,
          run: apply(setting, option),
        });
      }
    }
  }
  add('Options', 'All options…', 'openOptions');
  add('Options', 'Machines…', 'openMachines');
  add('Help', 'How a job goes together, and every key', 'showShortcuts');
  return out;
}

/** Words that must all appear, earlier is better; null when something is missing. */
export function matchScore(text, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const hay = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    const at = hay.indexOf(word);
    if (at < 0) return null;
    // a match at the start of a word beats one inside it
    score += at + (at === 0 || /\W/.test(hay[at - 1]) ? 0 : 20);
  }
  return score;
}

export function openPalette(ctx) {
  const commands = paletteCommands(ctx);
  const dialog = el('dialog', { class: 'palette-dialog' });
  const input = el('input', {
    type: 'text',
    class: 'palette-input',
    placeholder: 'Type a command — "front view", "light", "simulate"…',
    'aria-label': 'Command',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const list = el('div', { class: 'palette-list', role: 'listbox' });
  let shown = [];
  let at = 0;

  function paint() {
    const ranked = commands
      .map((c) => ({ c, score: matchScore(`${c.group} ${c.label}`, input.value) }))
      .filter((r) => r.score !== null)
      .sort((a, b) => a.score - b.score);
    shown = ranked.slice(0, MAX_SHOWN).map((r) => r.c);
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length
      ? shown.map((c, i) => el('button', {
        type: 'button',
        class: `palette-item${i === at ? ' on' : ''}`,
        role: 'option',
        title: c.hint ?? '',
        // run on press: the dialog closing on blur would eat a click
        onmousedown: (e) => { e.preventDefault(); choose(c); },
        onmousemove: () => { if (at !== i) { at = i; mark(); } },
      }, [
        el('span', { class: 'palette-group' }, [c.group]),
        el('span', { class: 'palette-label' }, [c.label]),
        ...(c.keys ? [el('span', { class: 'palette-keys' }, [c.keys])] : []),
      ]))
      : [el('div', { class: 'tree-empty' }, ['Nothing matches — try fewer words'])]));
  }

  function mark() {
    [...list.children].forEach((child, i) => child.classList.toggle('on', i === at));
    list.children[at]?.scrollIntoView?.({ block: 'nearest' });
  }

  function choose(command) {
    dialog.close();
    // after the dialog is gone: the key handler stands down while one is open
    setTimeout(() => command.run(), 0);
  }

  input.addEventListener('input', () => { at = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[at]) choose(shown[at]);
    }
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove());

  dialog.append(input, list);
  paint();
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  return dialog;
}
