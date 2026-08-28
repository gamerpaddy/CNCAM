// The help nobody had: what the keys do, and what order a job goes together in.
//
// Both halves answer questions a first-time user has no way to answer from the
// screen. The keys because a shortcut with no list is a secret; the running
// order because CAM has one and it is not obvious — a chamfer before the
// profile that makes the edge, a finish pass before the roughing that feeds it,
// and the program is wrong in a way nothing in the file complains about.

import { el } from './layout.js';
import { shortcutGroups } from './shortcuts.js';

/** The order of a 3-axis job, and why each step is where it is. */
const WORKFLOW = [
  ['Pick the machine', 'Mill or lathe on the left of the toolbar; the machine '
    + 'itself in the dropdown beside it. Its travel, rapid rate and spindle '
    + 'range are what every estimate and every limit warning are measured '
    + 'against — set them once, in Machines (Ctrl+M).'],
  ['Import the model', 'STEP, IGES, STL or OBJ. Ctrl+I, or Open Model. A .dxf '
    + 'comes in the same way and lands as a *drawing* on the stock — curves to '
    + 'engrave rather than a solid to machine.'],
  ['Pull the cutters', 'Tool Library. Every cutter is drawn to scale, so a bull '
    + 'nose and a ball are told apart by shape. A lathe shows lathe tooling and '
    + 'a mill shows end mills; drills and centre drills are in both. Cutters sit '
    + 'in catalogues — two built in, plus any of your own, which can be exported '
    + 'to a file and imported anywhere.'],
  ['Describe the setup', 'Raw stock as a size, how the part is fixtured, where the '
    + 'controller\'s zero sits, and any clamps the tool has to keep out of.'],
  ['Add operations, in machining order', 'Face, rough, profile, holes, chamfer, '
    + 'finish. Drag rows in the tree to reorder — the order is the program. '
    + 'Double-click a row to rename it.'],
  ['Generate and look at it', 'Ctrl+G. Each operation reports what it cut; an "!" '
    + 'means it cut nothing and says why. The setup panel says whether the whole '
    + 'program fits the machine.'],
  ['Simulate', 'S. Watch the stock come off, scrub back and forth. Detail and '
    + 'what the viewport draws are in Options (Ctrl+,).'],
  ['Post and export', 'Ctrl+E. The dialect comes from the machine you chose.'],
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
