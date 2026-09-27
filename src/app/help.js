// The help nobody had: what the keys do, and what order a job goes together in.
//
// Both halves answer questions a first-time user has no way to answer from the
// screen. The keys because a shortcut with no list is a secret; the running
// order because CAM has one and it is not obvious — a chamfer before the
// profile that makes the edge, a finish pass before the roughing that feeds it,
// and the program is wrong in a way nothing in the file complains about.

import { el, dialogCloseButton } from './layout.js';
import { shortcutGroups } from './shortcuts.js';

/**
 * The order of a 3-axis job, and why each step is where it is.
 *
 * Every control named here is named the way it is labelled on screen. This
 * sent people looking for an "Open Model" button and a "Tool Library" that the
 * toolbar has never had — it says Model… and Tools… — which is a help page
 * describing a different program.
 */
const WORKFLOW = [
  ['Pick the machine', 'Mill or Lathe on the toolbar, then the machine itself in the '
    + 'dropdown beside it. Its travel, rapid rate and spindle range are what every '
    + 'estimate and every limit warning are measured against — set them once, in '
    + 'Machines (the gear beside the dropdown, or Ctrl+M).'],
  ['Import the model', 'STEP, IGES, STL or OBJ: Import… on the toolbar, Import beside '
    + 'Models in the tree, Ctrl+I, or drop the file on the window. A .dxf comes in '
    + 'the same way and lands as a *drawing* on the stock — curves to engrave rather '
    + 'than a solid to machine.'],
  ['Pull the cutters', 'Tools… on the toolbar, or Library beside Tools in the tree; '
    + 'New builds one that is not in it. Every cutter is drawn to scale, so a bull '
    + 'nose and a ball are told apart by shape. A lathe shows lathe tooling and '
    + 'a mill shows end mills; drills and centre drills are in both. Cutters sit '
    + 'in catalogues — two built in, plus any of your own, which can be exported '
    + 'to a file and imported anywhere.'],
  ['Describe the setup', 'Raw stock as a size, how the part is fixtured, where the '
    + 'controller\'s zero sits, and any clamps the tool has to keep out of — '
    + 'Clamp… under the setup in the tree.'],
  ['Add operations, in machining order', 'A, or Operation… under the setup. '
    + 'Face, rough, profile, holes, chamfer, finish. Drag rows in the tree to '
    + 'reorder — the order is the program. Double-click a row, or type in the name '
    + 'at the top of the panel, to rename it.'],
  ['Generate and look at it', 'Generate on the toolbar, or Ctrl+G — the number on it '
    + 'is how many operations are waiting. Each operation reports what it cut; an "!" '
    + 'means it has something to say — it cut nothing, or it cut but skipped '
    + 'something — and hovering it says what. The setup panel says whether the '
    + 'whole program fits the machine.'],
  ['Simulate', 'Simulate, or S. Watch the stock come off, scrub back and forth. '
    + 'Detail and what the viewport draws are in Options (Ctrl+,).'],
  ['Post and export', 'Export — or Ctrl+E for the whole program in one file. The '
    + 'same menu writes a file per operation, and an operation\'s own menu in the '
    + 'tree exports just that one. The dialect comes from the machine you chose. '
    + 'New, Open and Save are under File.'],
];

export function openHelp(ctx) {
  const dialog = el('dialog', { class: 'lib-dialog help-dialog' });

  const keyGroups = shortcutGroups(ctx).map((group) => el('div', { class: 'lib-group' }, [
    el('h3', {}, [group.name]),
    ...group.items.map((item) => el('div', { class: 'help-key-row' }, [
      el('span', { class: 'help-keys' }, keyCaps(item.keys)),
      el('span', { class: 'help-key-label' }, [item.label]),
    ])),
  ]));

  const steps = WORKFLOW.map(([title, detail], i) => el('div', { class: 'help-step' }, [
    el('span', { class: 'help-step-n' }, [String(i + 1)]),
    el('div', {}, [
      el('div', { class: 'help-step-title' }, [title]),
      el('div', { class: 'help-step-detail' }, [detail]),
    ]),
  ]));

  dialog.append(
    dialogCloseButton(dialog),
    el('h2', {}, ['How it goes together, and every key']),
    el('div', { class: 'lib-body help-body' }, [
      el('div', { class: 'help-column' }, [
        el('h3', {}, ['The order of a job']),
        ...steps,
      ]),
      el('div', { class: 'help-column' }, keyGroups),
    ]),
    el('div', { class: 'lib-actions' }, [
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: () => dialog.close() }, ['Close']),
    ]),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** 'Ctrl+G' → separate key caps, which is how a keyboard shortcut reads. */
function keyCaps(spec) {
  return spec.split('+').flatMap((part, i) => [
    ...(i > 0 ? [el('span', { class: 'help-plus' }, ['+'])] : []),
    el('kbd', {}, [part]),
  ]);
}
