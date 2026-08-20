// The machine manager: pick a machine, edit it, or build a new one.
//
// A list on the left and the chosen machine's fields on the right, which is the
// shape this kind of dialog has everywhere because it is the shape the task
// has: you are comparing a few similar things and then changing one of them.
//
// The built-in machines are presets in the same sense the tool library's are —
// a starting point that lands in your project as a copy you own. There is no
// read-only rack here: the numbers on a machine are the numbers *of your
// machine*, and a preset you cannot correct is a preset that is wrong.

import { el } from './layout.js';
import {
  MACHINE_PRESETS, createMachine, describeMachine, machinesFor,
  ROTARY_KINDS, rotaryKindOf, rotaryPreset,
} from '../doc/machines.js';
import { POSTS, postsFor } from '../post/index.js';
import { numberInput, parseNumber, formatNumber } from './number-input.js';
import { propRow } from './props/fields.js';

const KIND_LABELS = { mill: 'Mill', turn: 'Lathe' };

/**
 * Fields of a machine, in the order somebody setting one up would fill them in:
 * what it is, how big it is, how fast it moves, what it will spin at, and what
 * happens at a tool change.
 *
 * `axis` marks the ones that only exist on a machine with that axis — a lathe
 * has no Y travel to type in, because it has no Y.
 */
const FIELDS = [
  { key: 'name', label: 'Name', type: 'text' },
  {
    key: 'post', label: 'G-code dialect', type: 'select',
    hint: 'How a move is spelled: canned cycles, tool changes, arcs.',
  },
  {
    key: 'travel.0', label: 'X travel (mm)', type: 'number', min: 0,
    labelFor: (m) => (m.kind === 'turn' ? 'X travel, radius (mm)' : null),
    hintFor: (m) => (m.kind === 'turn'
      ? 'Held as a radius, like every X inside the app — so the swing over the '
        + 'bed is twice this. The post doubles it on the way out.'
      : null),
  },
  { key: 'travel.1', label: 'Y travel (mm)', type: 'number', min: 0, axis: 'y' },
  { key: 'travel.2', label: 'Z travel (mm)', type: 'number', min: 0 },
  {
    key: 'rapidFeed', label: 'Rapid G0 (mm/min)', type: 'number', min: 1,
    hint: 'How fast the machine really traverses. This is most of the cycle '
      + 'time on a job with a lot of retracts, and it is what the timeline and '
      + 'every estimate are measured with.',
  },
  {
    key: 'rapidFeedZ', label: 'Rapid G0 in Z (mm/min)', type: 'number', min: 1,
    hint: 'Usually slower than the other two — Z is lifting the head against '
      + 'gravity, or a heavy quill.',
  },
  {
    key: 'maxFeed', label: 'Fastest cutting feed (mm/min)', type: 'number', min: 1,
    hint: 'An operation asking for more than this is flagged before you post it.',
  },
  {
    key: 'feedMode', label: 'Feed written as', type: 'select',
    options: ['perRev', 'perMinute'],
    labels: { perRev: 'mm per revolution (G95)', perMinute: 'mm per minute (G94)' },
    kind: 'turn',
    hint: 'A lathe feeds per revolution — that is what keeps the chip the same '
      + 'thickness at every diameter, and it is the figure on the insert box. '
      + 'CNCAM holds mm/min either way and the post divides by the spindle speed.',
  },
  { key: 'spindleMin', label: 'Slowest spindle (rpm)', type: 'number', min: 0 },
  {
    key: 'spindleMax', label: 'Fastest spindle (rpm)', type: 'number', min: 1,
    hint: 'A cutter that wants 24000 rpm in a 8000 rpm spindle is a cutter '
      + 'running at a third of the surface speed it was chosen for.',
  },
  {
    // Milling only: how many rotary axes the machine has for indexed 3+1 / 3+2
    // work. A lathe's turning axis is not this.
    key: 'rotary', kind: 'mill', type: 'rotaryKind', label: 'Rotary axes',
    hint: 'Indexed multi-axis. A rotary table swings a tilted face under the '
      + 'spindle and locks, so you machine it without re-fixturing — 3+1 tilts '
      + 'about one axis, 3+2 adds a turntable and reaches any face. Then set a '
      + 'setup to "Indexed" and rotate it to the face. LinuxCNC drives this with '
      + 'a G68.2 tilted work plane.',
  },
  {
    key: 'toolChanger', label: 'Tool change', type: 'select',
    options: ['auto', 'manual'],
    labels: { auto: 'Automatic (turret or carousel)', manual: 'By hand, at the machine' },
  },
  {
    key: 'toolChangeSeconds', label: 'Takes (seconds)', type: 'number', min: 0,
    hint: 'Counted into the cycle time. Four seconds on a turret and a minute '
      + 'by hand is the difference between two programs that look identical.',
  },
  {
    key: 'coolant', label: 'Has coolant', type: 'checkbox',
  },
  { key: 'notes', label: 'Notes', type: 'text' },
];

function read(machine, key) {
  const [head, index] = key.split('.');
  return index === undefined ? machine[head] : machine[head]?.[Number(index)];
}

function write(machine, key, value) {
  const [head, index] = key.split('.');
  if (index === undefined) return { [head]: value };
  const next = [...(machine[head] ?? [])];
  next[Number(index)] = value;
  return { [head]: next };
}

/**
 * @param doc the document — machines live in the project, so they are undoable
 *   and they travel with the file
 * @param onDone called after the dialog closes, so the caller can refresh
 */
export function openMachineManager(doc, { onDone } = {}) {
  const dialog = el('dialog', { class: 'lib-dialog machine-dialog' });
  const listHost = el('div', { class: 'machine-list' });
  const editorHost = el('div', { class: 'machine-editor' });
  let kind = doc.machine;
  let selectedId = doc.project.machineIds?.[kind] ?? null;

  function machines() { return machinesFor(doc.project, kind); }

  function selected() {
    const pool = machines();
    return pool.find((m) => m.id === selectedId) ?? pool[0] ?? null;
  }

  function build() {
    const pool = machines();
    if (!pool.some((m) => m.id === selectedId)) selectedId = pool[0]?.id ?? null;
    const inUse = doc.project.machineIds?.[kind];

    listHost.replaceChildren(...(pool.length === 0
      ? [el('div', { class: 'tree-empty' }, ['No machines of this kind yet.'])]
      : pool.map((machine) => {
        const active = machine.id === selectedId;
        return el('button', {
          class: `machine-row${active ? ' active' : ''}`,
          onclick: () => { selectedId = machine.id; build(); },
        }, [
          el('span', { class: 'machine-row-name' }, [machine.name]),
          ...(machine.id === inUse
            ? [el('span', { class: 'machine-row-badge' }, ['in use'])] : []),
          el('span', { class: 'machine-row-meta' }, [describeMachine(machine)]),
        ]);
      })));

    editorHost.replaceChildren(...editorFor(selected()));
  }

  function editorFor(machine) {
    if (!machine) {
      return [el('div', { class: 'tree-empty' }, [
        'Nothing selected. Add a machine from one of the presets below.',
      ])];
    }
    const rows = [
      el('h3', {}, [machine.name]),
      el('div', { class: 'prop-note' }, [describeMachine(machine)]),
    ];

    for (const field of FIELDS) {
      // a lathe has no Y travel, because it has no Y — and only a lathe has a
      // feed-per-revolution question to answer
      if (field.axis === 'y' && machine.kind === 'turn') continue;
      if (field.kind && field.kind !== machine.kind) continue;
      rows.push(machineField(machine, field));
      const hint = field.hintFor?.(machine) ?? field.hint;
      if (hint) rows.push(el('div', { class: 'prop-hint' }, [hint]));
    }

    rows.push(el('div', { class: 'machine-actions' }, [
      el('button', {
        class: 'primary',
        title: 'Post and simulate for this machine from now on',
        onclick: () => { doc.setMachineRecord(machine.id); build(); },
      }, ['Use this machine']),
      el('button', {
        title: 'A copy to change without losing the original',
        onclick: () => {
          const copy = createMachine({ ...machine, name: `${machine.name} copy` });
          doc.addMachine(copy);
          selectedId = copy.id;
          build();
        },
      }, ['Duplicate']),
      el('button', {
        class: 'danger',
        disabled: machines().length <= 1 ? 'disabled' : undefined,
        title: machines().length <= 1
          ? 'The last machine of its kind cannot be removed'
          : `Remove ${machine.name} from this project`,
        onclick: () => {
          if (!confirm(`Remove ${machine.name}?`)) return;
          doc.removeMachine(machine.id);
          build();
        },
      }, ['Remove']),
    ]));
    return rows;
  }

  function machineField(machine, field) {
    const label = field.labelFor?.(machine) ?? field.label;
    const value = read(machine, field.key);
    let input;

    if (field.type === 'rotaryKind') {
      const kinds = Object.keys(ROTARY_KINDS);
      input = el('select', {}, kinds.map((k) => el('option', { value: k }, [ROTARY_KINDS[k].label])));
      input.value = rotaryKindOf(machine);
      input.addEventListener('change', () => {
        doc.updateItem(machine, { rotary: rotaryPreset(input.value) }, 'machine rotary');
        build();
      });
      return propRow(label, input);
    }
    if (field.type === 'select') {
      const options = field.key === 'post' ? postsFor(machine.kind) : field.options;
      const labels = field.key === 'post'
        ? Object.fromEntries(options.map((id) => [id, POSTS[id]?.name ?? id]))
        : field.labels;
      input = el('select', {}, options.map((id) => el('option', { value: id }, [labels?.[id] ?? id])));
      input.value = value ?? options[0];
      input.addEventListener('change', () => {
        doc.updateItem(machine, write(machine, field.key, input.value), `machine ${field.key}`);
        build();
      });
    } else if (field.type === 'checkbox') {
      input = el('input', { type: 'checkbox' });
      input.checked = !!value;
      input.addEventListener('change', () => {
        doc.updateItem(machine, write(machine, field.key, input.checked), `machine ${field.key}`);
        build();
      });
    } else {
      const numeric = field.type === 'number';
      input = numeric ? numberInput(field) : el('input', { type: 'text' });
      input.value = numeric ? formatNumber(value) : (value ?? '');
      input.addEventListener('change', () => {
        const next = numeric
          ? Math.max(field.min ?? -Infinity, parseNumber(input.value) || 0)
          : input.value;
        doc.updateItem(machine, write(machine, field.key, next), `machine ${field.key}`);
        build();
      });
    }
    return propRow(label, input);
  }

  const kindTabs = el('div', { class: 'machine-tabs' },
    ['mill', 'turn'].map((id) => el('button', {
      class: `machine-tab${id === kind ? ' active' : ''}`,
      onclick: () => {
        kind = id;
        selectedId = doc.project.machineIds?.[kind] ?? null;
        kindTabs.querySelectorAll('.machine-tab').forEach((b, i) => {
          b.classList.toggle('active', ['mill', 'turn'][i] === kind);
        });
        build();
      },
    }, [KIND_LABELS[id]])));

  // The presets, as a way to *make* a machine rather than as a rack you are
  // stuck with. Adding one copies it into the project, where it can be
  // corrected against the machine actually standing in the shop.
  const presetSelect = el('select', {
    class: 'machine-preset',
    // the only control in the dialog with no label beside it — it sits in the
    // action bar, where what it is has to be carried by the control itself
    title: 'A machine to start from — adding one copies it into the project',
    'aria-label': 'Machine preset to add',
  },
    MACHINE_PRESETS.map((p, i) => el('option', { value: String(i) },
      [`${KIND_LABELS[p.kind]} — ${p.name}`])));

  build();
  dialog.append(
    el('div', { class: 'lib-head' }, [
      el('h2', {}, ['Machines']),
      kindTabs,
      el('span', { class: 'spacer' }),
      el('span', { class: 'lib-hint' }, [
        'The dialect, the envelope, the rapids and the spindle range of the machine '
        + 'this program will run on',
      ]),
    ]),
    el('div', { class: 'machine-body' }, [listHost, editorHost]),
    el('div', { class: 'lib-actions' }, [
      presetSelect,
      el('button', {
        class: 'primary-outline',
        title: 'Copy this preset into the project, then correct it',
        onclick: () => {
          const preset = MACHINE_PRESETS[Number(presetSelect.value)] ?? MACHINE_PRESETS[0];
          const machine = createMachine(preset);
          doc.addMachine(machine);
          kind = machine.kind;
          selectedId = machine.id;
          kindTabs.querySelectorAll('.machine-tab').forEach((b, i) => {
            b.classList.toggle('active', ['mill', 'turn'][i] === kind);
          });
          build();
        },
      }, ['+ Add from preset']),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: () => dialog.close() }, ['Done']),
    ]),
  );

  dialog.addEventListener('close', () => { dialog.remove(); onDone?.(); });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
