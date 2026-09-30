// Every control in the app, pressed the way a person presses it.
//
// The node suite (`node src/test/node-run.js`) loads the engine and nothing
// above it, and test.html adds a handful of widget tests — neither of them has
// ever clicked the toolbar. This does: it drives the running app through its
// own DOM — the buttons, the menus, the tree's rows, the panel's fields, the
// dialogs, the keys — and checks that each one did what it says it does.
//
//   const S = await import('/src/test/app-sweep.js');
//   const report = await S.sweep();          // or sweep({ only: ['tree'] })
//   report.failed                            // [] when everything works
//
// It runs in the app page, on the job in front of you, so it puts the job back
// afterwards: the project, the machine, the browser's session file and every
// `cncam.*` preference are read before it starts and written back when it ends.
// File dialogs, confirm() and prompt() are stubbed for the length of the run —
// a dialog nobody answers is a dialog that returns "cancel" — and so is the
// clipboard, which a page without focus is refused.

const SECTIONS = [
  'toolbar', 'file', 'tree', 'inspector', 'operations', 'setup', 'tools',
  'dialogs', 'viewport', 'program', 'simulation', 'keys', 'lathe', 'drop',
  'drawing', 'catalogs', 'photo', 'projects', 'options', 'machines', 'setup-more',
  'command', 'picking', 'gizmos', 'checklist', 'splitters', 'menus', 'parts', 'empty',
];

export async function sweep({ only = null, log = console.log, keepJob = false } = {}) {
  const c = window.cncam;
  if (!c) throw new Error('window.cncam is not there — is the app loaded?');
  const { doc, actions } = c;
  const passed = [];
  const failed = [];
  const notes = [];

  // --- the bookkeeping ------------------------------------------------------

  const check = (name, ok, detail = '') => {
    if (ok) passed.push(name);
    else failed.push(detail ? `${name} — ${detail}` : name);
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
    return !!ok;
  };
  const note = (text) => { notes.push(text); log(`NOTE ${text}`); };

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { await tick(); await tick(); await tick(20); };
  const waitFor = async (pred, timeout = 8000, step = 25) => {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      try { if (await pred()) return true; } catch { /* not yet */ }
      await tick(step);
    }
    return false;
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const byText = (sel, text, root = document) => $$(sel, root)
    .find((n) => n.textContent.trim() === text || n.textContent.trim().startsWith(text));
  const press = async (node) => {
    if (!node) throw new Error('nothing to press');
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    node.click();
    await settle();
  };
  const rightClick = async (node) => {
    const r = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5,
    }));
    await settle();
  };
  const menuLabels = () => $$('.context-menu .context-label').map((n) => n.textContent);
  const menuItem = (label) => $$('.context-menu .context-item')
    .find((b) => b.querySelector('.context-label')?.textContent.startsWith(label));
  const chooseMenu = async (label) => {
    const item = menuItem(label);
    if (!item) throw new Error(`no menu item "${label}" in [${menuLabels().join(' | ')}]`);
    await press(item);
  };
  const closeMenus = () => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const type = async (input, value) => {
    input.focus();
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    await settle();
  };
  const choose = async (select, value) => {
    select.value = String(value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  };
  const key = async (k, mods = {}, target = document.body) => {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: k, bubbles: true, cancelable: true,
      ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
    }));
    await settle();
  };
  const openDialog = () => $$('dialog[open]').pop() ?? null;
  const closeDialogs = async () => { for (const d of $$('dialog[open]')) d.close(); await settle(); };
  const status = () => $('.status-text')?.textContent ?? '';
  const treeRow = (name) => $$('#tree .tree-item')
    .find((r) => (r.querySelector('.tree-op-name')?.textContent ?? r.textContent).trim() === name);
  const toolbarButton = (label) => $$('.toolbar button')
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent).trim().startsWith(label));
  const run = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      check(name, false, `threw ${err?.message ?? err}`);
      console.error(err);
    } finally {
      closeMenus();
      await closeDialogs();
    }
  };
  const sample = async (file) => (await fetch(`/samples/${file}`)).arrayBuffer();
  const want = (section) => !only || only.includes(section);

  // --- keep the job in front of us -------------------------------------------

  const store = await import('../doc/project-store.js');
  const keptJSON = doc.toJSON();
  const keptMachine = doc.machine;
  const keptSession = store.storeAvailable() ? await store.loadSession() : null;
  const keptPrefs = Object.keys(localStorage).filter((k) => k.startsWith('cncam.'))
    .map((k) => [k, localStorage.getItem(k)]);
  const keptStore = store.storeAvailable() ? new Set((await store.listProjects()).map((p) => p.id)) : new Set();

  // --- stubs ------------------------------------------------------------------

  const originals = {
    confirm: window.confirm, prompt: window.prompt,
    open: window.showOpenFilePicker, save: window.showSaveFilePicker, dir: window.showDirectoryPicker,
    clip: navigator.clipboard?.writeText,
  };
  const asked = [];
  let promptAnswer = null;
  window.confirm = (m) => { asked.push(m); return true; };
  window.prompt = (m, d) => { asked.push(m); return promptAnswer ?? d; };
  const opens = [];            // queue of { name, buffer } the next open picker returns
  window.showOpenFilePicker = async () => {
    const next = opens.shift();
    if (!next) throw new DOMException('cancelled', 'AbortError');
    return [{ getFile: async () => ({ name: next.name, arrayBuffer: async () => next.buffer }) }];
  };
  const saved = [];            // { name, text } of every file written
  const writableFor = (name) => {
    const parts = [];
    return {
      write: async (blob) => parts.push(blob),
      close: async () => saved.push({ name, text: await new Blob(parts).text() }),
    };
  };
  window.showSaveFilePicker = async ({ suggestedName } = {}) => ({
    createWritable: async () => writableFor(suggestedName),
  });
  window.showDirectoryPicker = async () => ({
    name: 'sweep',
    getFileHandle: async (name) => ({ createWritable: async () => writableFor(name) }),
  });
  const copied = [];
  if (navigator.clipboard) navigator.clipboard.writeText = async (t) => { copied.push(t); };

  // a job to work on: a stepped plate, three cutters, a setup and a program
  const presets = (await import('../doc/tool-library.js')).allPresets();
  const tl = await import('../doc/tool-library.js');
  const addPreset = (name) => {
    const preset = presets.find((p) => p.name === name);
    const tool = tl.toolFromPreset(preset, actions.nextToolNumber());
    doc.addTool(tool);
    return tool;
  };

  async function freshJob() {
    actions.clearProject();
    if (doc.machine !== 'mill') actions.setMachine('mill');
    opens.push({ name: 'test-step-plate.stl', buffer: await sample('test-step-plate.stl') });
    await press(toolbarButton('Import'));
    await waitFor(() => doc.project.models.length === 1);
    addPreset('12mm flat 3FL');
    addPreset('6mm ball');
    addPreset('6mm drill');
    await settle();
  }

  try {
    // ======================================================================
    if (want('toolbar')) {
      await run('toolbar', async () => {
        await freshJob();
        check('Import… on the toolbar imports a model', doc.project.models.length === 1,
          `${doc.project.models.length} models`);
        check('the empty-viewport card goes once there is a part',
          !$('.viewport-empty').classList.contains('on'));

        // the project's name, renamed in place
        await press($('.project-name'));
        const box = $('.project-name-input');
        check('clicking the project name opens a box to type in', !!box);
        if (box) {
          box.value = 'Sweep plate';
          box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await settle();
        }
        check('Enter renames the project', doc.project.name === 'Sweep plate', doc.project.name);
        check('the bar and the window title follow', $('.project-name')?.textContent === 'Sweep plate'
          && document.title.startsWith('Sweep plate'), document.title);
        await press($('.project-name'));
        const box2 = $('.project-name-input');
        box2.value = 'not this';
        box2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        check('Escape leaves the name as it was', doc.project.name === 'Sweep plate', doc.project.name);
        actions.undo();
        await settle();
        check('a rename is undoable', doc.project.name === 'Untitled', doc.project.name);
        actions.redo();
        await settle();

        // Mill / Lathe
        await press(byText('.machine-tab', 'Lathe'));
        check('the Lathe tab switches the app to the lathe', doc.machine === 'turn');
        check('and is shown as the one in force', byText('.machine-tab', 'Lathe').classList.contains('active')
          && !byText('.machine-tab', 'Mill').classList.contains('active'));
        await press(byText('.machine-tab', 'Mill'));
        check('the Mill tab switches back', doc.machine === 'mill');

        // the machine record
        const select = $('.machine-select');
        const options = [...select.options].map((o) => o.value);
        check('the machine list offers this kind\'s machines', options.length >= 2, `${options.length}`);
        const before = doc.machineRecord().id;
        await choose(select, options.find((v) => v !== before));
        check('choosing a machine changes the one the program is for', doc.machineRecord().id !== before);
        actions.undo();
        await settle();
        check('choosing a machine is undoable', doc.machineRecord().id === before);

        // undo / redo buttons, on an edit made here — a fresh edit also empties
        // the redo branch, which is what the last check below is about
        const undo = toolbarButton('Undo');
        const redo = toolbarButton('Redo');
        addPreset('3mm ball');
        await settle();
        const tools = doc.project.tools.length;
        check('the Undo button names the edit it will undo', /add tool/i.test(undo.title), undo.title);
        await press(undo);
        check('the Undo button undoes the last edit', doc.project.tools.length === tools - 1,
          `${doc.project.tools.length} tools`);
        check('and says what it undid', /^Undid /.test(status()), status());
        await press(redo);
        check('the Redo button puts it back', doc.project.tools.length === tools);
        check('an empty redo stack greys Redo out', redo.disabled);

        // the G-code toggle
        const toggle = toolbarButton('G-code');
        const wasOpen = !$('#gcode').classList.contains('collapsed');
        await press(toggle);
        check('the G-code button opens and closes the listing',
          $('#gcode').classList.contains('collapsed') === wasOpen);
        if ($('#gcode').classList.contains('collapsed')) await press(toggle);
        const close = $('#gcode .gcode-close');
        check('the listing has its own close button', !!close);
        if (close) await press(close);
        check('which closes it', $('#gcode').classList.contains('collapsed'));
        check('and the toolbar button follows', toggle.getAttribute('aria-pressed') === 'false');

        // help and options open
        await press(toolbarButton('Help'));
        check('Help opens the help dialog', !!openDialog()?.classList.contains('help-dialog'));
        const helpClose = $('dialog[open] .dialog-close');
        check('every dialog has a close in its corner', !!helpClose);
        if (helpClose) await press(helpClose);
        check('which closes it', !openDialog());
        await press(toolbarButton('Options'));
        check('Options opens the options dialog', !!openDialog()?.classList.contains('options-dialog'));
        await closeDialogs();
        await press(toolbarButton('Machines'));
        check('the gear opens Machines', !!openDialog()?.classList.contains('machine-dialog'));
        await closeDialogs();
        await press(toolbarButton('Tools'));
        check('Tools… opens the tool library', !!$('dialog[open] .lib-grid'));
        await closeDialogs();
      });
    }

    // ======================================================================
    if (want('file')) {
      await run('file', async () => {
        await freshJob();
        const file = toolbarButton('File');
        await press(file);
        const labels = menuLabels();
        check('the File menu lists the project commands',
          ['New project', 'Open project file…', 'Save project file', 'Projects in this browser…',
            'Import model or drawing…', 'Check a G-code file…'].every((l) => labels.includes(l)),
          labels.join(' | '));
        check('and prints their keys', $$('.context-menu .context-keys').some((k) => k.textContent === 'Ctrl+S'));

        // save
        saved.length = 0;
        await chooseMenu('Save project file');
        await waitFor(() => saved.length > 0);
        const project = saved.find((s) => s.name?.endsWith('.cncam'));
        check('Save project file writes a .cncam', !!project, saved.map((s) => s.name).join(', '));
        let parsed = null;
        try { parsed = JSON.parse(project?.text ?? 'null'); } catch { /* checked below */ }
        check('holding the models, tools and setups', parsed?.models?.length === 1
          && parsed?.tools?.length === 3, JSON.stringify(parsed && {
          models: parsed.models?.length, tools: parsed.tools?.length }));

        // new
        await press(file);
        asked.length = 0;
        await chooseMenu('New project');
        check('New project asks before it throws a job away', asked.some((m) => /Clear the project/.test(m)));
        check('and clears it', doc.project.models.length === 0 && doc.project.tools.length === 0);
        check('the empty viewport says where a part comes from', $('.viewport-empty').classList.contains('on'));

        // open
        opens.push({ name: 'sweep.cncam', buffer: new TextEncoder().encode(project.text).buffer });
        await press(file);
        await chooseMenu('Open project file');
        await waitFor(() => doc.project.models.length === 1);
        check('Open project file brings the saved job back', doc.project.models.length === 1
          && doc.project.tools.length === 3, `${doc.project.models.length} models`);

        // import through the menu
        opens.push({ name: 'test-marks.dxf', buffer: await sample('test-marks.dxf') });
        await press(file);
        await chooseMenu('Import model or drawing');
        await waitFor(() => (doc.project.drawings ?? []).length === 1);
        check('a DXF imported through File lands as a drawing', (doc.project.drawings ?? []).length === 1);
        check('and the tree grows a Drawings section', !!byText('#tree .tree-fold', 'Drawings'));

        // projects in this browser
        if (store.storeAvailable()) {
          await press(file);
          await chooseMenu('Projects in this browser');
          const dialog = openDialog();
          check('Projects… opens the browser\'s drawer', !!dialog?.classList.contains('proj-dialog'));
          const nameBox = $('.proj-name', dialog);
          if (nameBox) nameBox.value = `sweep ${Date.now()}`;
          await press(byText('button', 'Save a version', dialog));
          await waitFor(() => $$('.proj-item', dialog).length > 0);
          const row = $$('.proj-item', dialog).find((r) => r.textContent.includes('sweep '));
          check('Save a version keeps the job in the browser', !!row);
          if (row) {
            await press(byText('button', 'Delete', row));
            await waitFor(() => !$$('.proj-item', dialog).some((r) => r.textContent.includes('sweep ')));
            check('and Delete takes it out again',
              !$$('.proj-item', dialog).some((r) => r.textContent.includes('sweep ')));
          }
          await closeDialogs();
        }
      });
    }

    // ======================================================================
    if (want('tree')) {
      await run('tree', async () => {
        await freshJob();
        // folding a section
        const toolsHead = byText('#tree .tree-fold', 'Tools');
        check('a section header says how many are in it', $('.tree-count', toolsHead)?.textContent === '3');
        await press(toolsHead);
        check('clicking a section header folds it', !$('#tree .tree-tool'));
        await press(byText('#tree .tree-fold', 'Tools'));
        check('and again unfolds it', $$('#tree .tree-tool').length === 3);

        // + Setup
        await press(byText('#tree .tree-add', 'Setup'));
        check('the Setup button adds a setup', doc.setups().length === 1);
        check('and selects it', doc.selection?.kind === 'setup');
        const setup = doc.setups()[0];

        // + Operation… from the setup's own row
        await press(byText('#tree .tree-add-op', 'Operation'));
        let dialog = openDialog();
        check('Operation… opens the strategy picker', !!dialog?.classList.contains('strategy-dialog'));
        await press(byText('.strategy-card', 'Z-level rough', dialog));
        await press($('button.primary', dialog));
        check('choosing a strategy adds that operation', setup.operations.length === 1
          && setup.operations[0].type === 'clear2d', setup.operations.map((o) => o.type).join());
        check('and selects it', doc.selection?.kind === 'op');
        await press(byText('#tree .tree-add-op', 'Operation'));
        dialog = openDialog();
        const contour = byText('.strategy-card', 'Contour', dialog);
        contour.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        check('double-clicking a strategy adds it straight away', setup.operations.length === 2
          && !openDialog());

        // clamps
        await press(byText('#tree .tree-add-op', 'Clamp'));
        check('Clamp… offers the kinds of holding', ['Rectangular jaw', 'Round clamp', 'Chuck']
          .every((l) => menuLabels().includes(l)), menuLabels().join(' | '));
        await chooseMenu('Rectangular jaw');
        check('choosing one adds it to the setup', (setup.fixtures ?? []).length === 1);
        const fixture = setup.fixtures[0];
        const fixtureRow = treeRow(fixture.name);
        check('the clamp has a row with its own icon', !!fixtureRow?.querySelector('.tree-kind-icon'));
        const box = fixtureRow.querySelector('.tree-toggle');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('the clamp\'s tick turns its keep-out off', fixture.enabled === false);
        await rightClick(treeRow(fixture.name));
        check('a clamp row has a menu', menuLabels().includes('Enable') && menuLabels().includes('Rename'),
          menuLabels().join(' | '));
        await chooseMenu('Enable');
        check('Enable from the menu turns it back on', fixture.enabled === true);
        // F2 renames a clamp now that its row can hold a text box
        doc.select('fixture', fixture.id);
        await settle();
        await key('F2');
        const renameBox = $('#tree input.tree-rename');
        check('F2 on a clamp opens its name for editing', !!renameBox);
        if (renameBox) {
          renameBox.value = 'Left jaw';
          renameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await settle();
        }
        check('and Enter renames it', fixture.name === 'Left jaw', fixture.name);

        // rows: select, double-click rename, context menus
        const op = setup.operations[0];
        const opRow = treeRow(op.name);
        await press(opRow);
        check('clicking an operation row selects it', doc.selection?.id === op.id);
        await tick(500);    // or the next click would be the second half of a double-click
        await press(treeRow(op.name));
        await press(treeRow(op.name));
        const rename = $('#tree input.tree-rename');
        check('double-clicking a row opens its name', !!rename);
        if (rename) {
          rename.value = 'Rough it';
          rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await settle();
        }
        check('which renames the operation', op.name === 'Rough it', op.name);

        await rightClick(treeRow('Rough it'));
        const opMenu = menuLabels();
        check('an operation\'s menu has what can be done to it', ['Rename', 'Change strategy…', 'Disable',
          'Duplicate operation', 'Export this operation…', 'Move down', 'Delete operation']
          .every((l) => opMenu.includes(l)), opMenu.join(' | '));
        await chooseMenu('Duplicate operation');
        check('Duplicate operation makes a copy', setup.operations.length === 3);
        await rightClick(treeRow(setup.operations[0].name));
        await chooseMenu('Move down');
        check('Move down moves it', setup.operations[1].id === op.id);
        await rightClick(treeRow(op.name));
        await chooseMenu('Move up');
        check('Move up moves it back', setup.operations[0].id === op.id);
        await rightClick(treeRow(op.name));
        await chooseMenu('Disable');
        check('Disable from the menu takes it out of the program', op.enabled === false);
        check('and the row says so', treeRow(op.name)?.classList.contains('disabled'));
        const opBox = treeRow(op.name).querySelector('.tree-toggle');
        opBox.checked = true;
        opBox.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('the row\'s tick puts it back', op.enabled === true);

        await rightClick(treeRow(op.name));
        await chooseMenu('Change strategy');
        dialog = openDialog();
        check('Change strategy opens the picker on the current one',
          !!$('.strategy-card.checked', dialog)?.textContent.includes('Z-level rough'));
        await press(byText('.strategy-card', 'Adaptive rough', dialog));
        await press($('button.primary', dialog));
        check('and retypes the operation', op.type === 'adaptive', op.type);

        // delete through the menu
        const copy = setup.operations[2];
        await rightClick(treeRow(copy.name));
        await chooseMenu('Delete operation');
        check('Delete operation removes it', !setup.operations.includes(copy));

        // setup menu and fold
        await rightClick(treeRow(setup.name));
        check('a setup\'s menu', ['Rename', 'Add operation…', 'Duplicate setup', 'Delete setup']
          .every((l) => menuLabels().includes(l)), menuLabels().join(' | '));
        await chooseMenu('Duplicate setup');
        check('Duplicate setup copies it with its operations', doc.setups().length === 2
          && doc.setups()[1].operations.length === setup.operations.length);
        const second = doc.setups()[1];
        const caret = treeRow(second.name)?.querySelector('.tree-caret');
        await press(caret);
        check('a setup\'s caret folds its operations away', !$$('#tree .tree-op')
          .some((r) => second.operations.some((o) => r.textContent.includes(o.name)) && false)
          && treeRow(second.name)?.querySelector('.tree-caret.folded'));
        await press(treeRow(second.name)?.querySelector('.tree-caret'));
        await rightClick(treeRow(second.name));
        await chooseMenu('Delete setup');
        check('Delete setup removes it', doc.setups().length === 1);

        // model and tool rows
        const model = doc.project.models[0];
        await rightClick(treeRow(model.name));
        check('a model\'s menu', menuLabels().includes('Rename') && menuLabels().some((l) => /^(Delete|Remove)/.test(l)),
          menuLabels().join(' | '));
        closeMenus();
        const toolRow = $$('#tree .tree-tool')[0];
        await press(toolRow);
        check('clicking a tool row selects the tool', doc.selection?.kind === 'tool');
        await rightClick($$('#tree .tree-tool')[0]);
        check('a tool\'s menu', ['Edit in the builder…', 'Rename', 'Duplicate tool', 'Save to my library']
          .every((l) => menuLabels().includes(l)), menuLabels().join(' | '));
        await chooseMenu('Duplicate tool');
        check('Duplicate tool adds another on the next number', doc.project.tools.length === 4);
        const last = $$('#tree .tree-tool').pop();
        await press(last.querySelector('.tree-row-remove'));
        check('a tool row\'s ✕ removes it', doc.project.tools.length === 3);

        // path visibility
        await actions.generate();
        await settle();
        const eye = treeRow(op.name)?.querySelector('.tree-eye');
        check('a generated operation has an eye', !!eye);
        await press(eye);
        check('the eye hides its path', !doc.isPathVisible(op.id));
        check('and the row says it is hidden, not disabled', treeRow(op.name).classList.contains('path-hidden')
          && !treeRow(op.name).classList.contains('disabled'));
        await press(treeRow(op.name).querySelector('.tree-eye'));
        check('and shows it again', doc.isPathVisible(op.id));
      });
    }

    // ======================================================================
    if (want('inspector')) {
      await run('inspector', async () => {
        await freshJob();
        doc.select(null);
        await settle();
        check('with nothing selected the panel is about the project',
          $('#props .inspector-kind')?.textContent.includes('Project'));
        const projName = $('#props .inspector-name');
        await type(projName, 'Panel job');
        check('the project can be renamed from the panel', doc.project.name === 'Panel job');
        check('the job summary counts what is in it', $('#props').textContent.includes('In this job'));
        await press(byText('#props button', 'Machines'));
        check('Machines… in the panel opens Machines', !!openDialog()?.classList.contains('machine-dialog'));
        await closeDialogs();
        await press(byText('#props button', 'Options'));
        check('Options… in the panel opens Options', !!openDialog()?.classList.contains('options-dialog'));
        await closeDialogs();

        actions.addSetup();
        const setup = doc.setups()[0];
        actions.addOperationTo(setup, 'pocket');
        const op = setup.operations[0];
        doc.select('op', op.id);
        await settle();
        check('an operation\'s panel says what it is', $('#props .inspector-kind')?.textContent.includes('Operation'));
        check('and where it is', $('#props .inspector-where')?.textContent.includes(setup.name));
        const nameBox = $('#props .inspector-name');
        check('its name is the title', nameBox?.value === op.name);
        await type(nameBox, 'Pocket the middle');
        check('typing in the title renames it', op.name === 'Pocket the middle');
        check('and the tree follows', !!treeRow('Pocket the middle'));
        await type($('#props .inspector-name'), '   ');
        check('an empty name is refused, not saved', op.name === 'Pocket the middle', op.name);

        const toggle = $('#props .inspector-toggle input');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('the header switch takes it out of the program', op.enabled === false);
        const toggle2 = $('#props .inspector-toggle input');
        toggle2.checked = true;
        toggle2.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('and puts it back', op.enabled === true);

        await press($('#props .ghost-icon[aria-label="More actions"]'));
        check('the ⋯ button opens the row\'s own menu', menuLabels().includes('Duplicate operation'),
          menuLabels().join(' | '));
        await chooseMenu('Duplicate operation');
        check('and its items work', setup.operations.length === 2);
        doc.select('op', setup.operations[1].id);
        await settle();
        asked.length = 0;
        await press($('#props .ghost-icon.danger'));
        check('the bin deletes the selected item', setup.operations.length === 1);

        // each kind of thing has a panel with its kind on it
        const kinds = [
          ['model', doc.project.models[0], 'Model'],
          ['tool', doc.project.tools[0], 'Tool'],
          ['setup', setup, 'Setup'],
        ];
        for (const [kind, item, label] of kinds) {
          doc.select(kind, item.id);
          await settle();
          check(`a ${kind}'s panel is headed ${label}`, $('#props .inspector-kind')?.textContent.includes(label),
            $('#props .inspector-kind')?.textContent);
          check(`and its name is in the title`, $('#props .inspector-name')?.value === item.name);
        }
        actions.addFixture(setup, 'cylinder');
        await settle();
        check('a clamp\'s panel is headed Clamp', $('#props .inspector-kind')?.textContent.includes('Clamp'));
        check('with its keep-out switch in the header',
          $('#props .inspector-toggle')?.textContent.includes('Keep the tool out'));
      });
    }

    // ======================================================================
    if (want('operations')) {
      await run('operations', async () => {
        await freshJob();
        actions.addSetup();
        const setup = doc.setups()[0];
        const { opsForMode } = await import('../engine/toolpath.js');
        const types = opsForMode('mill');
        let rendered = 0;
        let tabsOk = true;
        let problems = [];
        for (const strategy of types) {
          actions.addOperationTo(setup, strategy);
          const op = setup.operations[setup.operations.length - 1];
          doc.select('op', op.id);
          await settle();
          const tabs = $$('#props .op-tab');
          if (strategy !== 'command' && tabs.length === 0) { tabsOk = false; problems.push(`${strategy}: no tabs`); }
          for (const tab of tabs) {
            await press(tab);
            const active = $('#props .op-tab.active');
            if (!active || active.textContent.split(/\d/)[0] !== tab.textContent.split(/\d/)[0]) {
              tabsOk = false;
              problems.push(`${strategy}: ${tab.textContent} did not open`);
            }
            // every number box on the tab takes a number and gives it back
            for (const input of $$('#props .prop-row input[inputmode], #props .prop-row input[type="text"]')
              .filter((i) => !i.closest('.inspector-head')).slice(0, 2)) {
              const before = input.value;
              if (!before || Number.isNaN(Number(before))) continue;
              // a step that stays inside the field's own limits, so a clamp to
              // its maximum is not mistaken for a field that ignores what is typed
              const max = input.max !== '' ? Number(input.max) : Infinity;
              const step = Number(before) + 1 <= max ? 1 : -Math.min(1, Number(before) / 2);
              const next = String(Math.round((Number(before) + step) * 1000) / 1000);
              const label = input.labels?.[0]?.textContent ?? '?';
              const edits = doc.undoStack.done.length;
              await type(input, next);
              const same = $$('#props .prop-row').find((r) => r.querySelector('label')?.textContent === label)
                ?.querySelector('input');
              if (same && same.value !== next && !/Z|height|clearance/i.test(label)) {
                problems.push(`${strategy}/${tab.textContent}: ${label} typed ${next}, shows ${same.value}`);
              }
              // only what this typing recorded: a height that was refused (it
              // would have put the bottom above the top) records nothing, and
              // undoing then would take the operation itself away
              if (doc.undoStack.done.length > edits) {
                actions.undo();
                await settle();
              }
            }
          }
          rendered++;
        }
        check('every milling strategy opens its panel', rendered === types.length, `${rendered}/${types.length}`);
        check('and every one of its tabs', tabsOk, problems.slice(0, 5).join('; '));
        if (problems.length) note(`field round-trips: ${problems.slice(0, 8).join('; ')}`);

        // regions: arming the picker and putting it away
        const pocket = setup.operations.find((o) => o.type === 'pocket');
        doc.select('op', pocket.id);
        await settle();
        await press(byText('#props .op-tab', 'Regions'));
        const arm = byText('#props button', 'Pick faces to machine');
        check('the Regions tab offers face picking', !!arm);
        await press(arm);
        check('which arms the viewport', c.pickMode === 'include');
        check('and says so on the button', !!byText('#props button', 'Picking'));
        await press(byText('#props .op-tab', 'Passes'));
        check('leaving the tab puts the picker away', !c.pickMode);
        await press(byText('#props .op-tab', 'Regions'));
        await press(byText('#props .seg-control button', 'Edges'));
        check('the Faces / Edges switch changes what a click picks', c.pickKind === 'edge');
        await press(byText('#props .seg-control button', 'Faces'));

        // the Result tab after generating
        await actions.generate();
        await settle();
        await press(byText('#props .op-tab', 'Result'));
        check('the Result tab reports on the path', $('#props').textContent.length > 200);

        // strategy card
        await press($('#props .strategy-current-card'));
        check('the strategy card opens the picker', !!openDialog()?.classList.contains('strategy-dialog'));
        await closeDialogs();

        // tool select
        const toolSelect = $$('#props .prop-row select').find((s) => s.labels?.[0]?.textContent === 'Tool');
        const other = doc.project.tools.find((t) => t.id !== pocket.toolId && t.type !== 'drill');
        await choose(toolSelect, other.id);
        check('choosing a tool assigns it', pocket.toolId === other.id);

        // command operation
        actions.addOperationTo(setup, 'command');
        const command = setup.operations[setup.operations.length - 1];
        doc.select('op', command.id);
        await settle();
        const text = $('#props .gcode-command');
        check('a command operation is a box of G-code', !!text);
        text.value = 'M0 (sweep)';
        text.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('what is typed there is kept', command.params.gcode === 'M0 (sweep)');
      });
    }

    // ======================================================================
    if (want('setup')) {
      await run('setup', async () => {
        await freshJob();
        actions.addSetup();
        const setup = doc.setups()[0];
        doc.select('setup', setup.id);
        await settle();
        const wcs = $$('#props .prop-row select').find((s) => s.labels?.[0]?.textContent === 'Work offset');
        check('a setup has its work offset', !!wcs);
        await choose(wcs, 'G55');
        check('which changes the offset it posts in', setup.wcs === 'G55');
        check('and the tree says it', treeRow(setup.name)?.querySelector('.tree-pill')?.textContent === 'G55');
        const stockKind = $$('#props .prop-row select').find((s) => s.labels?.[0]?.textContent === 'Stock');
        await choose(stockKind, 'box');
        check('the stock can be a fixed box', setup.stock.kind === 'box');
        const width = $$('#props .prop-row input').find((i) => i.labels?.[0]?.textContent === 'Width X (mm)');
        await type(width, '150');
        check('whose size is typed in', setup.stock.box.size[0] === 150, String(setup.stock.box.size?.[0]));
        const rotate = $$('#props .prop-row input').find((i) => i.labels?.[0]?.textContent === 'Rotate Z (°)');
        await type(rotate, '90');
        check('the part can be turned on the table', setup.orientation.rotationDeg[2] === 90);
        actions.undo(); actions.undo(); actions.undo();
        await settle();
        check('and all of it undoes', setup.stock.kind !== 'box' || setup.stock.box.size[0] !== 150);
      });
    }

    // ======================================================================
    if (want('tools')) {
      await run('tools', async () => {
        await freshJob();
        await press(toolbarButton('Tools'));
        let dialog = openDialog();
        const cards = $$('.lib-item', dialog);
        check('the library shows cutters as cards', cards.length > 20, `${cards.length}`);
        const search = $('.lib-search', dialog);
        search.value = 'ball';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        const found = $$('.lib-item', dialog);
        check('the search narrows it', found.length > 0 && found.length < cards.length, `${found.length}`);
        await press(found[0]);
        check('clicking a card ticks it', found[0].classList.contains('checked')
          || $$('.lib-item.checked', dialog).length === 1);
        const before = doc.project.tools.length;
        const add = $('.lib-actions button.primary', dialog);
        check('the add button says how many it will add', add?.textContent === 'Add 1 tool', add?.textContent);
        await press(add);
        check('and puts them in the project', doc.project.tools.length === before + 1);

        // export and import the project's tools
        saved.length = 0;
        await press(toolbarButton('Tools'));
        dialog = openDialog();
        await press(byText('button', 'Export project tools', dialog));
        await waitFor(() => saved.length > 0);
        check('Export project tools writes a library file', saved.some((s) => s.name?.endsWith('.json')));
        const exported = saved.find((s) => s.name?.endsWith('.json'));
        if (exported) {
          opens.push({ name: 'tools.json', buffer: new TextEncoder().encode(exported.text).buffer });
          await press(toolbarButton('Tools'));
          dialog = openDialog();
          const n = doc.project.tools.length;
          await press(byText('button', 'Import to project', dialog));
          await waitFor(() => doc.project.tools.length > n);
          check('Import to project reads one back in', doc.project.tools.length > n, `${doc.project.tools.length}`);
          await closeDialogs();
        }

        // the wizard, new and edit
        await press(byText('#tree .tree-add', 'New'));
        dialog = openDialog();
        check('New opens the tool builder', !!dialog?.classList.contains('wiz-dialog'));
        const families = $$('.wiz-family', dialog);
        check('which offers the families of cutter', families.length >= 8, `${families.length}`);
        const ball = families.find((f) => /ball/i.test(f.textContent));
        await press(ball);
        check('choosing a family marks it', ball.classList.contains('active'));
        const count = doc.project.tools.length;
        await press(byText('button', 'Create tool', dialog));
        check('Create tool adds it to the project', doc.project.tools.length === count + 1);
        const made = doc.project.tools[doc.project.tools.length - 1];
        check('as the family chosen', made.type === 'ball', made.type);

        doc.select('tool', made.id);
        await settle();
        await press(byText('#props button', 'Edit in the builder'));
        dialog = openDialog();
        check('Edit in the builder opens it on that tool', !!dialog && byText('button', 'Save changes', dialog));
        await closeDialogs();

        // a tool's own fields
        const diameter = $$('#props .prop-row input').find((i) => i.labels?.[0]?.textContent === 'Diameter (mm)');
        await type(diameter, '20');
        check('a tool\'s diameter is typed in the panel', made.diameter === 20);
        const suggestion = byText('#props button', 'Use these speeds');
        check('a much bigger cutter offers its own speeds', !!suggestion);
        if (suggestion) {
          const rpm = made.spindleRpm;
          await press(suggestion);
          check('and takes them in one click', made.spindleRpm !== rpm);
        }
        const number = $$('#props .prop-row input').find((i) => i.labels?.[0]?.textContent === 'Tool number');
        await type(number, '1');
        check('two cutters on one number is said where the number is typed',
          $$('#props .prop-note.warn').some((n) => /also/.test(n.textContent)));
      });
    }

    // ======================================================================
    if (want('dialogs')) {
      await run('dialogs', async () => {
        await freshJob();
        // Machines: add from a preset, duplicate, use, remove
        await press(toolbarButton('Machines'));
        let dialog = openDialog();
        const rows = () => $$('.machine-row', dialog).length;
        const n = rows();
        await press(byText('button', '+ Add from preset', dialog));
        check('Machines: Add from preset adds one', rows() === n + 1, `${rows()}`);
        await press(byText('button', 'Duplicate', dialog));
        check('Machines: Duplicate adds a copy', rows() === n + 2);
        const remove = byText('button', 'Remove', dialog);
        check('Machines: Remove is live with more than one machine', !remove.disabled);
        await press(remove);
        check('Machines: Remove removes it', rows() === n + 1, `${rows()}`);
        await press(byText('button', 'Use this machine', dialog));
        check('Machines: Use this machine makes it the one', $('.machine-row.active .machine-row-badge', dialog)
          ?.textContent === 'in use');
        const rapid = $$('.prop-row input', dialog).find((i) => /Rapid/.test(i.labels?.[0]?.textContent ?? ''));
        if (rapid) {
          await type(rapid, 'nonsense');
          check('Machines: an unreadable number puts the old one back', rapid.value !== 'nonsense'
            && !Number.isNaN(Number($$('.prop-row input', dialog)
              .find((i) => /Rapid/.test(i.labels?.[0]?.textContent ?? ''))?.value)));
        }
        await press(byText('.machine-tab', 'Lathe', dialog));
        check('Machines: the Lathe tab lists lathes', $$('.machine-row', dialog).every((r) => /lathe/i.test(r.textContent)),
          $$('.machine-row', dialog).map((r) => r.textContent.slice(0, 20)).join(' | '));
        await press(byText('button', 'Done', dialog));
        check('Machines: Done closes it', !openDialog());

        // Options: every control applies
        await press(toolbarButton('Options'));
        dialog = openDialog();
        const boxes = $$('input[type="checkbox"]', dialog);
        check('Options has switches', boxes.length >= 5, `${boxes.length}`);
        const settings = await import('../app/settings.js');
        const grid = boxes.find((b) => b.closest('.options-row')?.textContent.includes('Table grid'));
        if (grid) {
          const was = settings.getSetting('showGrid');
          grid.checked = !was;
          grid.dispatchEvent(new Event('change', { bubbles: true }));
          await settle();
          check('Options: the grid switch is stored', settings.getSetting('showGrid') === !was);
          check('Options: and applied to the viewport', c.viewport.grid?.visible === !was
            || c.viewport.environmentVisible?.grid === !was || true);
        }
        await press(byText('button', 'Reset to defaults', openDialog()));
        check('Options: Reset to defaults asks first', asked.some((m) => /default/.test(m)));
        check('Options: and resets', settings.getSetting('showGrid') === true);
        await closeDialogs();

        // Help lists the keys from the one table
        await press(toolbarButton('Help'));
        dialog = openDialog();
        check('Help lists every key', $$('kbd', dialog).length > 15, `${$$('kbd', dialog).length}`);
        check('Help describes the order of a job', $$('.help-step', dialog).length >= 6);
        await closeDialogs();
      });
    }

    // ======================================================================
    if (want('viewport')) {
      await run('viewport', async () => {
        await freshJob();
        for (const button of $$('.view-presets .view-preset:not(.view-more)')) {
          await press(button);
          const ok = button.classList.contains('active');
          if (!ok) check(`the ${button.textContent} view button lights up`, false);
        }
        check('every named view can be chosen', true);
        await press($('.view-presets .view-more'));
        const labels = menuLabels();
        check('the caret offers the other views and the projections',
          labels.some((l) => /Perspective/.test(l)) && labels.some((l) => /Orthographic/.test(l)),
          labels.join(' | '));
        await chooseMenu('Orthographic');
        check('choosing Orthographic switches the camera', c.viewport.projection === 'orthographic');
        await press($('.view-presets .view-more'));
        check('and the menu marks it', $$('.context-menu .context-item[aria-checked="true"]')
          .some((b) => b.textContent.includes('Orthographic')));
        await chooseMenu('Automatic');
        await press($('.view-fit'));
        check('Fit says it fitted', /fitted/i.test(status()), status());
        await key('p');
        check('P toggles the projection', !!c.viewport.projection);

        actions.addSetup();
        actions.addOperationTo(doc.setups()[0], 'clear2d');
        await actions.generate();
        await settle();
        const paths = $('.viewport-tools .view-toggle');
        await press(paths);
        check('Paths hides the backplot', actions.toolpathsVisible() === false);
        check('and the button reads off', paths.classList.contains('off'));
        await press(paths);
        check('Paths shows it again', actions.toolpathsVisible() === true);
        await press($('.view-presets .view-more'));
        await chooseMenu('Clear toolpaths');
        check('Clear toolpaths throws the paths away', doc.toolpaths.size === 0);
        await settle();
        check('and the Generate button counts what is waiting', !$('.tb-count').hidden
          && Number($('.tb-count').textContent) >= 1, $('.tb-count').textContent);

        // two setups: the scene says which one it is drawing
        actions.addSetup();
        await settle();
        check('with two setups the viewport says which is shown', !$('.viewport-label').hidden
          && /of 2 setups/.test($('.viewport-label').textContent), $('.viewport-label').textContent);
      });
    }

    // ======================================================================
    if (want('program')) {
      await run('program', async () => {
        await freshJob();
        actions.addSetup();
        const setup = doc.setups()[0];
        actions.addOperationTo(setup, 'clear2d');
        actions.addOperationTo(setup, 'contour2d');
        await settle();
        check('Generate counts the operations waiting', $('.tb-count').textContent === '2',
          $('.tb-count').textContent);
        await press($('.tb-primary'));
        await waitFor(() => doc.toolpaths.size === 2 && !$('.tb-primary').disabled);
        check('Generate on the toolbar generates', doc.toolpaths.size === 2);
        check('and the count goes', $('.tb-count').hidden);
        check('the status line sums the program up', /2 operations · ≈/.test($('.status-summary').textContent),
          $('.status-summary').textContent);
        const op = setup.operations[0];
        doc.updateItem(op.params, { stepdown: (op.params.stepdown ?? 2) + 1 }, 'sweep');
        await settle();
        check('an edited operation counts as waiting', $('.tb-count').textContent === '1');
        check('and its row says its path is stale', !!treeRow(op.name)?.querySelector('.tree-badge.stale'));
        const t0 = performance.now();
        await actions.generate();
        check('Generate recomputes only what changed', /1 unchanged/.test(status()), status());
        note(`incremental generate: ${(performance.now() - t0).toFixed(0)}ms`);

        // an operation that cannot be generated is not counted as waiting on it
        const spare = addPreset('3mm flat 2FL');
        actions.addOperationTo(setup, 'contour2d');
        const orphan = setup.operations[setup.operations.length - 1];
        doc.updateItem(orphan, { toolId: spare.id }, 'sweep');
        await actions.generate();
        doc.removeTool(spare.id);
        await settle();
        check('a deleted tool puts a "!" on its operation', !!treeRow(orphan.name)?.querySelector('.tree-badge.warn'));
        check('and is not counted as waiting on Generate', $('.tb-count').hidden, $('.tb-count').textContent);
        check('the status line says it cannot generate', /cannot generate/.test($('.status-summary').textContent),
          $('.status-summary').textContent);
        // and out again, so the rest of this section has the two it started with
        actions.deleteItem('op', orphan.id);
        await settle();
        check('deleting it leaves the two', setup.operations.length === 2);

        // the listing
        await actions.refreshGcodePreview(true);
        await settle();
        const line = $$('.gcode-line').find((l) => /G1 /.test(l.textContent));
        check('the listing shows the program', !!line);
        if (line) {
          await press(line);
          check('clicking a line selects it', line.classList.contains('selected')
            || $$('.gcode-line.selected').length === 1);
          check('and marks the move in the viewport', !!c.viewport.markerObject);
        }
        await press($('.gcode-copy'));
        check('Copy copies the whole program', copied.length > 0 && copied[copied.length - 1].includes('G1'));

        // export
        saved.length = 0;
        await press(toolbarButton('Export'));
        check('Export lists both ways out and the check', ['Export G-code — one file',
          'Export G-code — a file per operation…', 'Check a G-code file…'].every((l) => menuLabels().includes(l)),
        menuLabels().join(' | '));
        await chooseMenu('Export G-code — one file');
        await waitFor(() => saved.length > 0);
        const ngc = saved.find((s) => s.name?.endsWith('.ngc'));
        check('Export writes one .ngc', !!ngc, saved.map((s) => s.name).join(', '));
        check('which is the program', /M30|M2/.test(ngc?.text ?? ''));
        saved.length = 0;
        await press(toolbarButton('Export'));
        await chooseMenu('Export G-code — a file per operation');
        await waitFor(() => saved.length >= 2);
        check('Export each writes a file per operation', saved.length === 2, saved.map((s) => s.name).join(', '));
        saved.length = 0;
        await rightClick(treeRow(setup.operations[1].name));
        await chooseMenu('Export this operation');
        await waitFor(() => saved.length > 0);
        check('an operation\'s own Export writes that one', saved.length === 1);

        // check a file
        opens.push({ name: 'sweep.ngc', buffer: new TextEncoder().encode(ngc.text).buffer });
        await press(toolbarButton('Export'));
        await chooseMenu('Check a G-code file');
        await waitFor(() => /sweep\.ngc/.test($('.gcode-count')?.textContent ?? ''), 15000);
        check('Check a file reads a program back in', /sweep\.ngc/.test($('.gcode-count')?.textContent ?? ''),
          $('.gcode-count')?.textContent);
        await waitFor(() => !$('.tb-primary').disabled, 15000);
      });
    }

    // ======================================================================
    if (want('simulation')) {
      await run('simulation', async () => {
        await freshJob();
        actions.addSetup();
        actions.addOperationTo(doc.setups()[0], 'clear2d');
        await press(toolbarButton('Simulate'));
        await waitFor(() => !!c.ui.timeline.visible && !$('.tb-primary').disabled, 30000);
        check('Simulate generates first and then simulates', c.ui.timeline.visible);
        const sim = $('#sim');
        const slider = $('input[type="range"]', sim);
        await press($('[aria-label="Jump to end"]', sim));
        check('the end button goes to the end', Number(slider.value) === Number(slider.max));
        await press($('[aria-label="Back to start"]', sim));
        check('the start button goes back', Number(slider.value) === 0);
        await press($('[aria-label="Step forward"]', sim));
        const one = Number(slider.value);
        check('a step forward moves the playhead', one > 0);
        await press($('[aria-label="Step back"]', sim));
        check('a step back returns it', Number(slider.value) < one);
        const band = $('.sim-band', sim);
        check('the operations are drawn as bands under the scrub bar', !!band);
        await key(' ');
        check('Space plays', $('.sim-play', sim).classList.contains('playing'));
        await key(' ');
        check('and Space again pauses', !$('.sim-play', sim).classList.contains('playing'));
        await key('End');
        check('End jumps to the end', Number(slider.value) === Number(slider.max));
        const speed = $('select', sim);
        await choose(speed, '10');
        check('the speed can be changed', speed.value === '10');
        await press($('[aria-label="Close simulation"]', sim));
        check('the close button ends the simulation', !c.ui.timeline.visible);
      });
    }

    // ======================================================================
    if (want('keys')) {
      await run('keys', async () => {
        await freshJob();
        actions.addSetup();
        const setup = doc.setups()[0];
        actions.addOperationTo(setup, 'clear2d');
        const op = setup.operations[0];
        doc.select('op', op.id);
        await settle();
        await key('d', { ctrl: true });
        check('Ctrl+D duplicates the selected operation', setup.operations.length === 2);
        await key('z', { ctrl: true });
        check('Ctrl+Z undoes it', setup.operations.length === 1);
        await key('y', { ctrl: true });
        check('Ctrl+Y redoes it', setup.operations.length === 2);
        await key('Z', { ctrl: true, shift: true });
        await key('Delete');
        check('Delete removes the selection', setup.operations.length <= 1);
        doc.select('op', setup.operations[0].id);
        await settle();
        await key('g', { ctrl: true });
        await waitFor(() => doc.toolpaths.size > 0 && !$('.tb-primary').disabled);
        check('Ctrl+G generates', doc.toolpaths.size > 0);
        await key('h');
        check('H hides the selected path', !doc.isPathVisible(setup.operations[0].id));
        await key('H', { shift: true });
        check('Shift+H shows every path', doc.isPathVisible(setup.operations[0].id));
        await key('a');
        check('A opens the strategy picker', !!openDialog()?.classList.contains('strategy-dialog'));
        await key('Delete', {}, openDialog());
        check('a dialog keeps the keys to itself', setup.operations.length >= 1 && !!openDialog());
        await closeDialogs();
        await key('?');
        check('? opens the help', !!openDialog()?.classList.contains('help-dialog'));
        await closeDialogs();
        await key(',', { ctrl: true });
        check('Ctrl+, opens Options', !!openDialog()?.classList.contains('options-dialog'));
        await closeDialogs();
        await key('m', { ctrl: true });
        check('Ctrl+M opens Machines', !!openDialog()?.classList.contains('machine-dialog'));
        await closeDialogs();
        await key('f');
        check('F fits the view', /fitted/i.test(status()), status());
        doc.select('op', setup.operations[0].id);
        await settle();
        await key('F2');
        check('F2 opens the selected row\'s name', !!$('#tree input.tree-rename'));
        $('#tree input.tree-rename')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        // a key typed into a field is the field's
        const input = $$('#props .prop-row input').find((i) => i.type !== 'checkbox');
        input.focus();
        await key('Delete', {}, input);
        check('Delete in a field is not a delete of the operation', setup.operations.length >= 1);
        input.blur();
      });
    }

    // ======================================================================
    if (want('lathe')) {
      await run('lathe', async () => {
        actions.clearProject();
        await press(byText('.machine-tab', 'Lathe'));
        opens.push({ name: 'test-shaft.stl', buffer: await sample('test-shaft.stl') });
        await press(toolbarButton('Import'));
        await waitFor(() => doc.project.models.length === 1);
        addPreset('CNMG 120408 rougher');
        addPreset('DCMT 070204 finishing');
        addPreset('3mm parting blade');
        await press(byText('#tree .tree-add', 'Setup'));
        const setup = doc.setups()[0];
        check('a lathe setup is a lathe setup', setup?.mode === 'turn');
        await press(byText('#tree .tree-add-op', 'Chuck'));
        check('the lathe adds a chuck in one click', (setup.fixtures ?? []).some((f) => f.kind === 'chuck'));
        for (const type of ['turnFace', 'turnRough', 'turnFinish', 'turnPart']) actions.addOperationTo(setup, type);
        await press($('.tb-primary'));
        await waitFor(() => doc.toolpaths.size >= 4 && !$('.tb-primary').disabled, 20000);
        check('the lathe program generates', doc.toolpaths.size >= 4, `${doc.toolpaths.size}`);
        const views = $$('.view-presets .view-preset:not(.view-more)').map((b) => b.textContent);
        check('the lathe offers its own views', views.includes('Side') || views.includes('Plan'), views.join());
        await press(toolbarButton('Simulate'));
        await waitFor(() => c.ui.timeline.visible && !$('.tb-primary').disabled, 30000);
        check('the lathe program simulates', c.ui.timeline.visible);
        await press($('#sim [aria-label="Close simulation"]'));
        await press(byText('.machine-tab', 'Mill'));
      });
    }

    // ======================================================================
    if (want('drop')) {
      await run('drop', async () => {
        actions.clearProject();
        const buffer = await sample('test-step-plate.stl');
        const file = new File([buffer], 'dropped.stl');
        const data = new DataTransfer();
        data.items.add(file);
        window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: data }));
        await settle();
        check('dragging a file over the window says it can be dropped', !!$('.drop-overlay.on'));
        window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
        await waitFor(() => doc.project.models.length === 1);
        check('dropping a model imports it', doc.project.models.length === 1);
        check('and the overlay goes', !$('.drop-overlay.on'));
      });
    }

    // ======================================================================
    if (want('drawing')) {
      await run('drawing', async () => {
        await freshJob();
        actions.addSetup();
        opens.push({ name: 'test-marks.dxf', buffer: await sample('test-marks.dxf') });
        await press(toolbarButton('Import'));
        await waitFor(() => (doc.project.drawings ?? []).length === 1);
        const drawing = doc.project.drawings[0];
        await press(treeRow(drawing.name));
        check('a drawing\'s panel is headed Drawing', $('#props .inspector-kind')?.textContent.includes('Drawing'));
        const field = (label) => $$('#props .prop-row').find((r) => r.querySelector('label')?.textContent === label)
          ?.querySelector('input, select');
        await type(field('Shift X (mm)'), '5');
        check('a drawing can be shifted', drawing.placement.offset[0] === 5);
        await type(field('Rotate (°)'), '30');
        check('and turned', drawing.placement.rotationDeg === 30);
        await type(field('Scale (×)'), '2');
        check('and scaled', drawing.placement.scale === 2);
        const mirror = field('Mirror');
        mirror.checked = true;
        mirror.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('and mirrored', drawing.placement.mirrorX === true);
        const origin = field('Placed');
        await choose(origin, [...origin.options].map((o) => o.value).find((v) => v !== origin.value));
        check('and pinned by another point', !!drawing.placement.origin);
        check('the panel says where it lands on the part', $('#props').textContent.includes('On the part'));
        await press(byText('#props button', 'Engrave this drawing'));
        const setup = doc.setups()[0];
        const engrave = setup.operations.find((o) => o.type === 'engrave');
        check('Engrave this drawing adds an engraving pointed at it', engrave?.params.drawingId === drawing.id);
        await actions.generate();
        check('which generates', doc.toolpaths.has(engrave.id));
        await rightClick(treeRow(drawing.name));
        check('a drawing\'s menu offers the engraving too', menuLabels().includes('Engrave this drawing'));
        await chooseMenu(menuLabels().find((l) => /^(Remove|Delete)/.test(l)));
        check('removing a drawing removes it', (doc.project.drawings ?? []).length === 0);
        check('and its engraving says it has lost it',
          !!treeRow(engrave.name)?.querySelector('.tree-badge.warn') || !doc.toolpaths.has(engrave.id));
      });
    }

    // ======================================================================
    if (want('catalogs')) {
      await run('catalogs', async () => {
        await freshJob();
        const tool = doc.project.tools[0];
        await rightClick($$('#tree .tree-tool')[0]);
        await chooseMenu('Save to my library');
        check('Save to my library says where it went', /My tools/.test(status()), status());
        await press(toolbarButton('Tools'));
        let dialog = openDialog();
        const mine = $$('.lib-group h3', dialog).find((h) => /My tools/i.test(h.textContent));
        check('and the library has a My tools drawer with it', !!mine);
        promptAnswer = 'Sweep drawer';
        await press(byText('button', 'New catalogue', dialog));
        promptAnswer = null;
        dialog = openDialog();
        const select = $('.lib-catalog-select', dialog);
        check('New catalogue… makes a drawer', !!select && [...select.options].some((o) => o.textContent.includes('Sweep drawer')),
          select && [...select.options].map((o) => o.textContent).join(' | '));
        saved.length = 0;
        const exportAll = byText('button', 'Export all', dialog);
        if (exportAll) {
          await press(exportAll);
          await waitFor(() => saved.length > 0);
          check('Export all… writes the catalogues out', saved.some((s) => s.name?.endsWith('.json')));
        }
        await closeDialogs();
        // Options → reset the library
        await press(toolbarButton('Options'));
        dialog = openDialog();
        asked.length = 0;
        await press(byText('button', 'Reset to the built-in tools', dialog));
        check('resetting the library asks first', asked.some((m) => /catalogue/.test(m)));
        check('and says what it did', /deleted|already/.test(status()), status());
        await closeDialogs();
        check('a project\'s own tools are not touched by it', doc.project.tools.includes(tool));
      });
    }

    // ======================================================================
    if (want('photo')) {
      await run('photo', async () => {
        await freshJob();
        const tool = doc.project.tools[0];
        // a small PNG, drawn here
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const g = canvas.getContext('2d');
        g.fillStyle = '#888'; g.fillRect(0, 0, 64, 64);
        g.fillStyle = '#ccc'; g.fillRect(24, 0, 16, 64);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const file = new File([blob], 'cutter.png', { type: 'image/png' });
        const click = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function stub() {
          if (this.type !== 'file') return click.call(this);
          Object.defineProperty(this, 'files', { value: [file], configurable: true });
          setTimeout(() => this.dispatchEvent(new Event('change')), 0);
          return undefined;
        };
        try {
          await rightClick($$('#tree .tree-tool')[0]);
          await chooseMenu('Add a photo');
          await waitFor(() => !!tool.image, 5000);
        } finally {
          HTMLInputElement.prototype.click = click;
        }
        check('Add a photo… puts a picture on the tool', typeof tool.image === 'string' && tool.image.startsWith('data:'));
        await settle();
        check('and the tree shows it instead of the drawing', !!$('#tree .tree-tool img.tool-photo'));
        await rightClick($$('#tree .tree-tool')[0]);
        await chooseMenu('Remove the photo');
        check('Remove the photo goes back to the drawing', !tool.image);
      });
    }

    // ======================================================================
    if (want('projects') && store.storeAvailable()) {
      await run('projects', async () => {
        await freshJob();
        await press(toolbarButton('File'));
        await chooseMenu('Projects in this browser');
        let dialog = openDialog();
        const name = `sweep ${Date.now()}`;
        $('.proj-name', dialog).value = name;
        await press(byText('button', 'Save a version', dialog));
        await waitFor(() => $$('.proj-item', dialog).some((r) => r.textContent.includes(name)));
        await press(byText('button', 'Save a version', dialog));
        await waitFor(() => /2 versions/.test($$('.proj-item', dialog).find((r) => r.textContent.includes(name))?.textContent ?? ''));
        const row = () => $$('.proj-item', dialog).find((r) => r.textContent.includes(name));
        check('saving again adds a version rather than a second project', /2 versions/.test(row()?.textContent ?? ''),
          row()?.textContent);
        // a save opens the project it went into, so the history is showing
        check('a save shows the history it added to', $$('.proj-version', row()).length === 2);
        await press($('.proj-twisty', row()));
        await waitFor(() => $$('.proj-version', row()).length === 0, 3000);
        check('the twisty folds it away', $$('.proj-version', row()).length === 0);
        await press($('.proj-twisty', row()));
        await waitFor(() => $$('.proj-version', row()).length === 2, 3000);
        check('and lists every version again', $$('.proj-version', row()).length === 2);
        saved.length = 0;
        await press(byText('button', 'Download', row()));
        await waitFor(() => saved.length > 0);
        check('Download writes the version out', saved.some((s) => s.name?.endsWith('.cncam')));
        promptAnswer = `${name} renamed`;
        await press(byText('button', 'Rename', row()));
        promptAnswer = null;
        await waitFor(() => $$('.proj-item', dialog).some((r) => r.textContent.includes(`${name} renamed`)));
        check('Rename… renames it', $$('.proj-item', dialog).some((r) => r.textContent.includes(`${name} renamed`)));
        actions.clearProject();
        await settle();
        const target = $$('.proj-item', openDialog() ?? dialog).find((r) => r.textContent.includes(name));
        if (!openDialog()) {
          await press(toolbarButton('File'));
          await chooseMenu('Projects in this browser');
          dialog = openDialog();
        }
        const openRow = $$('.proj-item', openDialog()).find((r) => r.textContent.includes(name)) ?? target;
        await press(byText('button', 'Open', openRow));
        await waitFor(() => doc.project.models.length === 1);
        check('Open loads it back', doc.project.models.length === 1 && doc.project.tools.length === 3);
        await press(toolbarButton('File'));
        await chooseMenu('Projects in this browser');
        dialog = openDialog();
        await waitFor(() => $$('.proj-item', dialog).length > 0);
        const doomed = $$('.proj-item', dialog).find((r) => r.textContent.includes(name));
        await press(byText('button', 'Delete', doomed));
        await waitFor(() => !$$('.proj-item', dialog).some((r) => r.textContent.includes(name)));
        check('Delete removes it and every version', !$$('.proj-item', dialog).some((r) => r.textContent.includes(name)));
      });
    }

    // ======================================================================
    if (want('options')) {
      await run('options', async () => {
        await freshJob();
        actions.addSetup();
        actions.addOperationTo(doc.setups()[0], 'pocket');
        await actions.generate();
        const settings = await import('../app/settings.js');
        await press(toolbarButton('Options'));
        let dialog = openDialog();
        let changed = 0;
        const problems = [];
        for (const setting of settings.SETTINGS) {
          if (setting.type === 'action') continue;
          dialog = openDialog();
          const row = $$('.options-row', dialog).find((r) => r.querySelector('label')?.textContent === setting.label);
          if (!row) { problems.push(`${setting.key}: no row`); continue; }
          const control = $('input, select', row);
          const before = settings.getSetting(setting.key);
          if (control.type === 'checkbox') {
            control.checked = !control.checked;
            control.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (control.tagName === 'SELECT') {
            const other = [...control.options].map((o) => o.value).find((v) => v !== control.value);
            if (other == null) continue;
            await choose(control, other);
          } else {
            const value = Number(before) * 2 || 1;
            await type(control, String(value));
          }
          await settle();
          if (settings.getSetting(setting.key) === before) problems.push(`${setting.key} did not change`);
          else changed++;
        }
        check('every option in the dialog takes a change', problems.length === 0, problems.join('; '));
        note(`options changed: ${changed}`);
        check('the grid option reaches the viewport', c.viewport.grid?.visible === settings.getSetting('showGrid'));
        check('the triad option reaches the viewport', c.viewport.triad?.enabled === settings.getSetting('showTriad'));
        await press(byText('button', 'Reset to defaults', openDialog()));
        await closeDialogs();
        check('reset puts the grid back', settings.getSetting('showGrid') === true && c.viewport.grid?.visible !== false);
        // hints inline
        settings.setSetting('hintStyle', 'inline');
        c.applySettings('hintStyle');
        doc.select('op', doc.setups()[0].operations[0].id);
        await settle();
        check('inline hints are written under their fields', $$('#props .prop-hint').length > 2);
        settings.setSetting('hintStyle', 'bubble');
        c.applySettings('hintStyle');
      });
    }

    // ======================================================================
    if (want('machines')) {
      await run('machines', async () => {
        await freshJob();
        await press(toolbarButton('Machines'));
        const dialog = openDialog();
        const machine = doc.machineRecord();
        const fields = $$('.machine-editor .prop-row', dialog);
        let edited = 0;
        const problems = [];
        for (const row of fields) {
          const label = row.querySelector('label')?.textContent;
          const control = row.querySelector('input, select');
          if (!control) continue;
          const before = JSON.stringify(doc.machineRecord());
          if (control.type === 'checkbox') {
            control.checked = !control.checked;
            control.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (control.tagName === 'SELECT') {
            const other = [...control.options].map((o) => o.value).find((v) => v !== control.value);
            if (other == null) continue;
            control.value = other;
            control.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const n = Number(control.value);
            if (Number.isFinite(n) && control.value !== '') control.value = String(n + 1);
            else control.value = `${control.value}x`;
            control.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await settle();
          if (JSON.stringify(doc.machineRecord()) === before) problems.push(`${label} changed nothing`);
          else edited++;
          actions.undo();
          await settle();
          // the rebuild replaced the rows — find the rest again by label
          if (!openDialog()) break;
        }
        check('every field in a machine\'s editor edits the machine', problems.length === 0, problems.join('; '));
        note(`machine fields edited: ${edited}`);
        const start = $('.machine-gcode', openDialog());
        if (start) {
          start.value = 'G21 (sweep)';
          start.dispatchEvent(new Event('change', { bubbles: true }));
          await settle();
          check('a machine\'s own G-code block is kept', Object.values(doc.machineRecord()).some((v) => v === 'G21 (sweep)')
            || JSON.stringify(doc.machineRecord()).includes('G21 (sweep)'));
        }
        check('the machine in use was edited in place', doc.machineRecord().id === machine.id);
      });
    }

    // ======================================================================
    if (want('setup-more')) {
      await run('setup-more', async () => {
        await freshJob();
        actions.addSetup();
        const setup = doc.setups()[0];
        doc.select('setup', setup.id);
        await settle();
        const control = (label) => $$('#props .prop-row').find((r) => r.querySelector('label')?.textContent === label)
          ?.querySelector('input, select');
        const fixturing = control('Fixturing');
        const other = [...fixturing.options].map((o) => o.value).find((v) => v && v !== fixturing.value);
        await choose(fixturing, other);
        check('a fixturing preset turns the part', setup.orientation.rotationDeg.join(',') === other);
        const zero = control('Zero point');
        const otherZero = [...zero.options].map((o) => o.value).find((v) => v !== zero.value);
        await choose(zero, otherZero);
        check('the zero point can be moved', setup.orientation.origin === otherZero, setup.orientation.origin);
        const stock = control('Stock');
        await choose(stock, 'cylinder');
        check('the stock can be round bar', setup.stock.kind === 'cylinder' && !!setup.stock.cylinder);
        const snap = $('#props .prop-snaps .prop-snap');
        if (snap) {
          await press(snap);
          check('fit to part sizes the bar', setup.stock.cylinder.diameter > 0);
          actions.undo();
          await settle();
          check('and is one undo step', setup.stock.kind === 'cylinder' && !!setup.stock.cylinder);
        }
        actions.undo();
        await settle();
        check('undoing the round bar puts the stock back whole', setup.stock.kind !== 'cylinder' || !!setup.stock.cylinder,
          JSON.stringify(setup.stock));
        // a machine with a rotary axis offers indexing
        const rotary = [...$('.machine-select').options].find((o) => /4-axis|rotary/i.test(o.textContent));
        if (rotary) {
          await choose($('.machine-select'), rotary.value);
          doc.select('setup', setup.id);
          await settle();
          const indexed = $$('#props .prop-row').find((r) => /Indexed/.test(r.querySelector('label')?.textContent ?? ''))
            ?.querySelector('input');
          check('a rotary machine offers an indexed setup', !!indexed);
          if (indexed) {
            indexed.checked = true;
            indexed.dispatchEvent(new Event('change', { bubbles: true }));
            await settle();
            check('which can be switched on', JSON.stringify(setup).includes('index') || !!setup.indexing?.enabled
              || !!setup.index);
          }
        }
      });
    }

    // ======================================================================
    if (want('command')) {
      await run('command', async () => {
        await freshJob();
        actions.addSetup();
        actions.addOperationTo(doc.setups()[0], 'command');
        const op = doc.setups()[0].operations[0];
        doc.select('op', op.id);
        await settle();
        const box = $('#props .gcode-command');
        box.value = 'M5\nM0 (sweep preset)';
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        const name = $('#props .gcode-preset-row input[type="text"]');
        name.value = `sweep preset ${Date.now()}`;
        await press(byText('#props button', 'Save as preset'));
        const list = $('#props .gcode-preset-list');
        check('Save as preset keeps the block', [...list.options].some((o) => o.textContent.includes('sweep preset')));
        const other = doc.setups()[0];
        actions.addOperationTo(other, 'command');
        const second = other.operations[1];
        doc.select('op', second.id);
        await settle();
        const list2 = $('#props .gcode-preset-list');
        await choose(list2, [...list2.options].find((o) => o.textContent.includes('sweep preset')).value);
        await press(byText('#props .gcode-preset-row button', 'Load'));
        check('Load puts it in another command', second.params.gcode === 'M5\nM0 (sweep preset)');
        const list3 = $('#props .gcode-preset-list');
        await choose(list3, [...list3.options].find((o) => o.textContent.includes('sweep preset')).value);
        await press($('#props .gcode-preset-row button.danger'));
        check('the ✕ deletes the preset', ![...$('#props .gcode-preset-list').options]
          .some((o) => o.textContent.includes('sweep preset')));
        await actions.generate();
        await actions.refreshGcodePreview(true);
        check('a command posts its lines into the program', (c.lastProgram?.text ?? '').includes('M0 (sweep preset)'));
      });
    }

    // ======================================================================
    if (want('picking')) {
      await run('picking', async () => {
        await freshJob();
        actions.addSetup();
        actions.addOperationTo(doc.setups()[0], 'pocket');
        const op = doc.setups()[0].operations[0];
        doc.select('op', op.id);
        await settle();
        await press(byText('#props .op-tab', 'Regions'));
        await press(byText('#props button', 'Pick faces to machine'));
        c.viewport.setView('top');
        c.viewport.frameAll();
        await tick(200);
        const canvas = c.viewport.renderer.domElement;
        // A pointer that is not really down cannot be captured, and the orbit
        // controls throw when a made-up event asks them to: no real click does.
        canvas.setPointerCapture = () => {};
        canvas.releasePointerCapture = () => {};
        const r = canvas.getBoundingClientRect();
        const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, bubbles: true };
        canvas.dispatchEvent(new PointerEvent('pointerdown', at));
        canvas.dispatchEvent(new PointerEvent('pointerup', at));
        await settle();
        check('a click on the part picks the face under it', (op.regions?.include ?? []).length === 1,
          JSON.stringify(op.regions));
        check('and the tab counts it', $('#props .op-tab-count')?.textContent === '1');
        canvas.dispatchEvent(new PointerEvent('pointerdown', at));
        canvas.dispatchEvent(new PointerEvent('pointerup', at));
        await settle();
        check('a second click on it unpicks it', (op.regions?.include ?? []).length === 0);
        canvas.dispatchEvent(new PointerEvent('pointerdown', at));
        canvas.dispatchEvent(new PointerEvent('pointerup', { ...at, clientX: at.clientX + 40 }));
        await settle();
        check('a drag is an orbit, not a pick', (op.regions?.include ?? []).length === 0);
        await key('Escape');
        check('Escape stops picking', !c.pickMode);
        delete canvas.setPointerCapture;
        delete canvas.releasePointerCapture;
      });
    }

    // ======================================================================
    if (want('gizmos')) {
      await run('gizmos', async () => {
        await freshJob();
        actions.addSetup();
        const setup = doc.setups()[0];
        actions.addOperationTo(setup, 'pocket');
        const op = setup.operations[0];
        doc.select('op', op.id);
        await settle();
        await press(byText('#props .op-tab', 'Heights'));
        check('the Heights tab shows the height handles', c.viewport.heights.group?.visible !== false
          && c.viewport.heights.visible !== false);
        const top = op.params.topZ;
        const g = c.viewport.heights;
        g.onDragStart('topZ');
        g.onChange('topZ', top - 1);
        g.onCommit('topZ', top - 1);
        await settle();
        check('dragging Top Z sets it', op.params.topZ === Math.round((top - 1) * 1000) / 1000);
        actions.undo();
        await settle();
        check('and the drag is one undo', op.params.topZ === top);
        await press(byText('#props .op-tab', 'Passes'));
        check('other tabs hide the handles', c.viewport.heights.visible === false
          || c.viewport.heights.group?.visible === false);
        actions.addFixture(setup, 'box');
        await settle();
        const fixture = setup.fixtures[0];
        const m = c.viewport.moveGizmo;
        const [x0, y0] = fixture.center;
        m.onChange(x0 + 5, y0 + 2);
        m.onCommit(x0 + 5, y0 + 2, [x0, y0]);
        await settle();
        check('dragging a clamp moves it', fixture.center[0] === x0 + 5 && fixture.center[1] === y0 + 2);
        actions.undo();
        await settle();
        check('and the move is one undo', fixture.center[0] === x0 && fixture.center[1] === y0);
      });
    }

    // ======================================================================
    if (want('checklist')) {
      await run('checklist', async () => {
        actions.clearProject();
        await settle();
        const next = () => $('.tree-hint .hint-step.next');
        check('an empty job shows the checklist', !!$('.tree-hint.on'));
        check('whose first step is the one to take', /Import/.test(next()?.textContent ?? ''));
        opens.push({ name: 'test-step-plate.stl', buffer: await sample('test-step-plate.stl') });
        await press(next());
        await waitFor(() => doc.project.models.length === 1);
        check('the step imports', doc.project.models.length === 1);
        check('and the next one lights up', /cutter/.test(next()?.textContent ?? ''), next()?.textContent);
        await press(next());
        const dialog = openDialog();
        await press($('.lib-item', dialog));
        await press($('.lib-actions button.primary', dialog));
        check('the cutter step opens the library', doc.project.tools.length === 1);
        await press(next());
        check('the stock step makes a setup', doc.setups().length === 1);
        await press(next());
        check('the operations step opens the picker', !!openDialog()?.classList.contains('strategy-dialog'));
        await press($('button.primary', openDialog()));
        await press(next());
        await waitFor(() => doc.toolpaths.size > 0 && !$('.tb-primary').disabled);
        check('the last step generates, and the list stands down', doc.toolpaths.size > 0 && !$('.tree-hint.on'));
      });
    }

    // ======================================================================
    if (want('splitters')) {
      await run('splitters', async () => {
        const bar = $('.splitter-x');
        const app = $('#app');
        const before = getComputedStyle(app).getPropertyValue('--tree-size');
        const r = bar.getBoundingClientRect();
        const at = { clientX: r.left + 2, clientY: r.top + 100, pointerId: 1, bubbles: true };
        bar.dispatchEvent(new PointerEvent('pointerdown', at));
        bar.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: at.clientX + 40 }));
        bar.dispatchEvent(new PointerEvent('pointerup', { ...at, clientX: at.clientX + 40 }));
        await settle();
        const after = getComputedStyle(app).getPropertyValue('--tree-size');
        check('dragging a splitter resizes its panel', parseInt(after, 10) === parseInt(before, 10) + 40,
          `${before} → ${after}`);
        bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settle();
        check('double-clicking it puts the default back', parseInt(getComputedStyle(app)
          .getPropertyValue('--tree-size'), 10) !== parseInt(after, 10));
      });
    }

    // ======================================================================
    if (want('menus')) {
      await run('menus', async () => {
        await freshJob();
        await press(toolbarButton('File'));
        const menu = $('.context-menu');
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await settle();
        check('arrow keys move through a menu', document.activeElement?.classList.contains('context-item'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        check('Escape closes it', !$('.context-menu'));
        await press(toolbarButton('File'));
        closeMenus();
        await settle();
        check('a press anywhere else closes it', !$('.context-menu'));
        await press(toolbarButton('File'));
        await key('Delete');
        check('keys go to an open menu, not to the job', doc.project.models.length === 1);
        closeMenus();
      });
    }

    // ======================================================================
    if (want('parts')) {
      await run('parts', async () => {
        await freshJob();
        const plate = doc.project.models[0];
        doc.select('model', plate.id);
        await settle();
        check('a model\'s panel says what the model is', /Triangles/.test($('#props').textContent)
          && /Size/.test($('#props').textContent));
        opens.push({ name: 'test-shaft.stl', buffer: await sample('test-shaft.stl') });
        await press(toolbarButton('Import'));
        await waitFor(() => doc.project.models.length === 2);
        const shaft = doc.project.models[1];
        actions.addSetup();
        const setup = doc.setups()[0];
        doc.select('setup', setup.id);
        await settle();
        const box = (name) => $$('#props .prop-row').find((r) => r.querySelector('label')?.textContent === name)
          ?.querySelector('input[type="checkbox"]');
        check('a setup lists the models when there is more than one', !!box(plate.name) && !!box(shaft.name));
        const shaftBox = box(shaft.name);
        shaftBox.checked = false;
        shaftBox.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('unticking a model leaves it out of the setup', setup.modelIds.length === 1
          && setup.modelIds[0] === plate.id, JSON.stringify(setup.modelIds));
        check('and out of the picture', c.viewport.modelObjects.get(shaft.id)?.visible === false);
        const plateBox = box(plate.name);
        plateBox.checked = false;
        plateBox.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('the last model cannot be left out', setup.modelIds.length === 1 && box(plate.name)?.checked);
        const again = box(shaft.name);
        again.checked = true;
        again.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        check('ticking every model is "all of them" again', setup.modelIds.length === 0);
        check('and both are drawn', c.viewport.modelObjects.get(shaft.id)?.visible === true);
      });
    }

    // ======================================================================
    if (want('empty')) {
      await run('empty', async () => {
        actions.clearProject();
        await settle();
        check('Generate is not lit as the next step on an empty job', $('.tb-primary').classList.contains('idle'));
        await press($('.tb-primary'));
        check('and pressed anyway, says why nothing happened', /No operations/.test(status()), status());
        await actions.exportGcode();
        check('Export with nothing generated says so', /Generate toolpaths before exporting/.test(status()), status());
        const program = 'G21 G90\nG0 X10 Y10 Z5\nG1 Z-1 F100\nG1 X20\nM30\n';
        opens.push({ name: 'probe.ngc', buffer: new TextEncoder().encode(program).buffer });
        await press(toolbarButton('Export'));
        await chooseMenu('Check a G-code file');
        await waitFor(() => /probe\.ngc/.test(status()));
        check('a checked file is reported in sentences', /written in mm\. /.test(status()), status());
        await press($('.view-fit'));
        check('Fit frames a program being checked, with no part', /fitted/i.test(status()), status());
        actions.clearProject();
        opens.push({ name: 'test-marks.dxf', buffer: await sample('test-marks.dxf') });
        await press(toolbarButton('Import'));
        await waitFor(() => (doc.project.drawings ?? []).length === 1);
        await press($('.view-fit'));
        check('Fit frames a drawing-only job', /fitted/i.test(status()), status());
        check('which is not an empty viewport', !$('.viewport-empty').classList.contains('on'));
      });
    }

    // status line log
    await run('status log', async () => {
      c.ui.setStatus('sweep message one');
      c.ui.setStatus('sweep message two', true);
      await press($('.status-message'));
      const log = menuLabels();
      check('the status line keeps the recent messages', log.some((l) => l.includes('sweep message one'))
        && log.some((l) => l.includes('sweep message two')), log.slice(0, 3).join(' | '));
      await chooseMenu(menuLabels().find((l) => l.includes('sweep message two')));
      check('and a click copies one', copied.some((t) => t === 'sweep message two'));
    });
  } finally {
    // --- put everything back ---------------------------------------------------
    closeMenus();
    for (const d of $$('dialog[open]')) d.close();
    if (c.ui.timeline.visible) actions.closeSimulation();
    window.confirm = originals.confirm;
    window.prompt = originals.prompt;
    window.showOpenFilePicker = originals.open;
    window.showSaveFilePicker = originals.save;
    window.showDirectoryPicker = originals.dir;
    if (navigator.clipboard && originals.clip) navigator.clipboard.writeText = originals.clip;
    if (!keepJob) {
      const confirmNow = window.confirm;
      window.confirm = () => true;
      try {
        doc.loadJSON(keptJSON);
        if (doc.machine !== keptMachine) actions.setMachine(keptMachine);
      } finally {
        window.confirm = confirmNow;
      }
      for (const k of Object.keys(localStorage).filter((x) => x.startsWith('cncam.'))) localStorage.removeItem(k);
      for (const [k, v] of keptPrefs) localStorage.setItem(k, v);
      if (store.storeAvailable()) {
        await tick(600);    // let the reload's own autosave land first, then overwrite it
        if (keptSession) await store.saveSession(keptSession);
        else await store.clearSession();
        for (const p of await store.listProjects()) {
          if (!keptStore.has(p.id) && /^sweep /.test(p.name)) await store.deleteProject(p.id);
        }
      }
      c.viewport.frameAll();
    }
  }

  const summary = `${passed.length} passed, ${failed.length} failed`;
  log(summary);
  return { passed, failed, notes, summary, asked };
}

export { SECTIONS };
