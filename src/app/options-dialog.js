// The Options dialog.
//
// One list, grouped, every row a live control: changing anything applies it at
// once rather than at the bottom of the dialog behind an "Apply". A preference
// you cannot see the effect of is a preference you have to guess at, and the
// viewport is right there behind the modal.

import { el, dialogCloseButton } from './layout.js';
import {
  SETTINGS, SETTING_GROUPS, getSetting, setSetting, resetSettings, exportSettings, importSettings,
} from './settings.js';
import { numberInput, parseNumber, formatNumber } from './number-input.js';
import { resetCatalogs } from '../doc/tool-library.js';
import { plural } from '../engine/text.js';
import { whenSettled, rebuildKeepingFocus } from './keep-focus.js';

/**
 * @param onChange called with (key, value) after every change, so the app can
 *   push it into the viewport straight away
 */
export function openOptions({ onChange, onStatus, onAction } = {}) {
  const dialog = el('dialog', { class: 'lib-dialog options-dialog' });
  const body = el('div', { class: 'lib-body options-body' });

  // After an edit has finished committing, with the caret put back — the rows
  // are rebuilt on every change, and a rebuild in the middle of the click on
  // the next row lost that click. See app/keep-focus.js.
  function rebuild() {
    whenSettled('options', [dialog], () => rebuildKeepingFocus(body, build));
  }

  function build() {
    const groups = SETTING_GROUPS.map((group) => {
      const rows = SETTINGS.filter((s) => s.group === group).map((setting) => {
        const control = controlFor(setting, (value) => {
          // An action has no value to store and nothing in the app to push it
          // into: what it hands back is a sentence about what it did, which
          // goes to the status line the way every other report does.
          if (setting.type === 'action') {
            const said = value === true ? onAction?.(setting.key) : value;
            if (said) onStatus?.(said);
            rebuild();
            return;
          }
          setSetting(setting.key, value);
          onChange?.(setting.key, value);
          // a change can enable or disable another row, so the group is rebuilt
          rebuild();
        });
        return el('div', { class: 'options-row' }, [
          el('div', { class: 'prop-row' }, [
            el('label', {}, [setting.label]),
            control,
          ]),
          ...(setting.hint ? [el('div', { class: 'prop-hint' }, [setting.hint])] : []),
        ]);
      });
      return el('div', { class: 'lib-group' }, [el('h3', {}, [group]), ...rows]);
    });
    body.replaceChildren(...groups);
  }

  build();
  dialog.append(
    dialogCloseButton(dialog),
    el('div', { class: 'lib-head' }, [
      el('h2', {}, ['Options']),
      el('span', { class: 'spacer' }),
      el('span', { class: 'lib-hint' }, [
        'Kept in this browser — these are how you like to look at a job, not part of it',
      ]),
    ]),
    body,
    el('div', { class: 'lib-actions' }, [
      // Preferences as a file: carry the look of the app to another browser or
      // another machine in the shop, or back up a setup that took an evening.
      el('button', {
        title: 'Save these options to a file',
        onclick: () => {
          const blob = new Blob([exportSettings()], { type: 'application/json' });
          const a = el('a', { href: URL.createObjectURL(blob), download: 'cncam-preferences.json' });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          onStatus?.('Options saved to cncam-preferences.json');
        },
      }, ['Export…']),
      el('button', {
        title: 'Load options from a file saved with Export',
        onclick: () => {
          const input = el('input', { type: 'file', accept: '.json,application/json' });
          input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
              const { applied, skipped } = importSettings(await file.text());
              for (const key of applied) onChange?.(key, getSetting(key));
              build();
              onStatus?.(`${plural(applied.length, 'option')} changed from ${file.name}`
                + (skipped ? ` — ${skipped} not understood by this version, left alone` : ''));
            } catch (err) {
              onStatus?.(err.message, true);
            }
          });
          input.click();
        },
      }, ['Import…']),
      el('button', {
        onclick: () => {
          if (!confirm('Put every option back to its default?')) return;
          resetSettings();
          for (const setting of SETTINGS) {
            if (setting.type !== 'action') onChange?.(setting.key, getSetting(setting.key));
          }
          build();
        },
      }, ['Reset to defaults']),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: () => dialog.close() }, ['Done']),
    ]),
  );

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/**
 * The rows that are not preferences.
 *
 * An action row is a button that does something once, rather than a value read
 * back later, so it is kept apart from the settings machinery entirely — see
 * DEFAULTS in settings.js. Each one asks before it acts and says what it did.
 */
const ACTIONS = {
  // handled by the app (the panels live in layout.js) — see onAction
  resetToolLibrary: () => {
    const { catalogs, tools } = resetCatalogs();
    if (tools === 0 && catalogs <= 1) {
      return 'The library is already just the built-in tools.';
    }
    return `${plural(tools, 'tool')} in ${plural(catalogs, 'catalogue')} deleted — `
      + 'the built-in presets are all that is left.';
  },
};

const ACTION_PROMPTS = {
  resetToolLibrary: 'Delete every tool catalogue you have made in this browser?\n\n'
    + 'The built-in presets stay — they cannot be edited away. Your own drawers, '
    + 'the cutters in them and any photographs on those cutters go, and this '
    + 'cannot be undone. Tools already in a project keep their own copy.',
};

function controlFor(setting, commit) {
  if (setting.type === 'action') {
    return el('button', {
      class: setting.safe ? '' : 'danger',
      onclick: () => {
        // a `safe` action changes nothing that cannot be put back, so it does not ask
        if (!setting.safe && !confirm(ACTION_PROMPTS[setting.key] ?? 'Are you sure?')) return;
        // no handler here means the app owns it: `true` hands it over
        const said = ACTIONS[setting.key] ? ACTIONS[setting.key]() : true;
        commit(said);
      },
    }, [setting.button ?? 'Do it']);
  }
  const value = getSetting(setting.key);
  if (setting.type === 'color') {
    const picker = el('input', { type: 'color', class: 'color-input' });
    picker.value = String(value);
    // `input` fires while dragging inside the picker: the viewport follows it live
    picker.addEventListener('change', () => commit(picker.value));
    return picker;
  }
  if (setting.type === 'checkbox') {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!value;
    box.addEventListener('change', () => commit(box.checked));
    return box;
  }
  if (setting.type === 'select') {
    const select = el('select', {}, setting.options.map((id) => el('option', { value: id }, [
      setting.labels?.[id] ?? id,
    ])));
    select.value = String(value);
    select.addEventListener('change', () => commit(select.value));
    return select;
  }
  const input = numberInput(setting);
  input.value = formatNumber(value);
  input.addEventListener('change', () => {
    const next = parseNumber(input.value);
    // an entry that is not a number puts back what was there, as every other
    // number box does — not the factory default, which is a different setting
    if (!Number.isFinite(next)) {
      input.value = formatNumber(value);
      return;
    }
    commit(next);
  });
  return input;
}
