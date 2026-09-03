// The Options dialog.
//
// One list, grouped, every row a live control: changing anything applies it at
// once rather than at the bottom of the dialog behind an "Apply". A preference
// you cannot see the effect of is a preference you have to guess at, and the
// viewport is right there behind the modal.

import { el } from './layout.js';
import {
  SETTINGS, SETTING_GROUPS, getSetting, setSetting, resetSettings,
} from './settings.js';
import { numberInput, parseNumber, formatNumber } from './number-input.js';
import { resetCatalogs } from '../doc/tool-library.js';
import { plural } from '../engine/text.js';

/**
 * @param onChange called with (key, value) after every change, so the app can
 *   push it into the viewport straight away
 */
export function openOptions({ onChange, onStatus } = {}) {
  const dialog = el('dialog', { class: 'lib-dialog options-dialog' });
  const body = el('div', { class: 'lib-body options-body' });

  function build() {
    const groups = SETTING_GROUPS.map((group) => {
      const rows = SETTINGS.filter((s) => s.group === group).map((setting) => {
        const control = controlFor(setting, (value) => {
          // An action has no value to store and nothing in the app to push it
          // into: what it hands back is a sentence about what it did, which
          // goes to the status line the way every other report does.
          if (setting.type === 'action') {
            if (value) onStatus?.(value);
            build();
            return;
          }
          setSetting(setting.key, value);
          onChange?.(setting.key, value);
          // a change can enable or disable another row, so the group is rebuilt
          build();
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
    el('div', { class: 'lib-head' }, [
      el('h2', {}, ['Options']),
      el('span', { class: 'spacer' }),
      el('span', { class: 'lib-hint' }, [
        'Kept in this browser — these are how you like to look at a job, not part of it',
      ]),
    ]),
    body,
    el('div', { class: 'lib-actions' }, [
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
      class: 'danger',
      onclick: () => {
        if (!confirm(ACTION_PROMPTS[setting.key] ?? 'Are you sure?')) return;
        const said = ACTIONS[setting.key]?.();
        commit(said);
      },
    }, [setting.button ?? 'Do it']);
  }
  const value = getSetting(setting.key);
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
    commit(Number.isFinite(next) ? next : setting.default);
  });
  return input;
}
