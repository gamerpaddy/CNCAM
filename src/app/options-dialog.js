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

/**
 * @param onChange called with (key, value) after every change, so the app can
 *   push it into the viewport straight away
 */
export function openOptions({ onChange } = {}) {
  const dialog = el('dialog', { class: 'lib-dialog options-dialog' });
  const body = el('div', { class: 'lib-body options-body' });

  function build() {
    const groups = SETTING_GROUPS.map((group) => {
      const rows = SETTINGS.filter((s) => s.group === group).map((setting) => {
        const control = controlFor(setting, (value) => {
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
          for (const setting of SETTINGS) onChange?.(setting.key, getSetting(setting.key));
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

function controlFor(setting, commit) {
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
