import { DIE_TYPES, dieLabel, type DieType } from './dice/types';
import {
  MAX_DICE_PER_ROLL,
  MAX_MODIFIER,
  emptyCounts,
  formatSelection,
  parseNotation,
  totalDice,
  type DiceSelection,
} from './notation';

import type { RollOutcome } from './dice/engine';
import type { RollRecord } from './state';

export interface DiceUiHandlers {
  onSelectionChange: (selection: DiceSelection) => void;
  onRoll: () => void;
  /** Re-throws only the dice without a clear top face; the rest stay in the tray. */
  onRerollUnreadable: () => void;
  onClearHistory: () => void;
}

interface ElementOptions {
  className?: string;
  text?: string;
  attributes?: Record<string, string>;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) {
    node.className = options.className;
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function button(text: string, className: string, label?: string): HTMLButtonElement {
  return element('button', {
    className,
    text,
    attributes: { type: 'button', ...(label ? { 'aria-label': label } : {}) },
  });
}

const NOT_COUNTED: Record<Exclude<RollOutcome['status'], 'OK'>, string> = {
  COCKED: 'Кубик встал на ребро — бросок не засчитан. Перебросьте спорные кубики.',
  TIMEOUT: 'Кубики не успокоились — бросок не засчитан.',
  ESCAPED: 'Кубик вылетел из лотка — бросок не засчитан.',
};

function signed(value: number): string {
  return value < 0 ? `− ${Math.abs(value)}` : `+ ${value}`;
}

export function recordFormula(record: Pick<RollRecord, 'dice' | 'modifier'>): string {
  const counts = emptyCounts();
  for (const die of record.dice) {
    counts[die.type] += 1;
  }
  return formatSelection({ counts, modifier: record.modifier });
}

export function recordDetails(record: Pick<RollRecord, 'dice' | 'modifier'>): string {
  const values = record.dice.map((die) => String(die.value)).join(' + ');
  return record.modifier === 0 ? values : `${values} ${signed(record.modifier)}`;
}

/** Plain DOM interface of the dice window: no framework, the tool stays small. */
export class DiceUi {
  readonly stage: HTMLElement;

  private readonly overlay: HTMLElement;
  private readonly overlayText: HTMLElement;
  private readonly result: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly counters = new Map<DieType, HTMLOutputElement>();
  private readonly modifierOutput: HTMLOutputElement;
  private readonly summary: HTMLElement;
  private readonly formulaInput: HTMLInputElement;
  private readonly formulaError: HTMLElement;
  private readonly rollButton: HTMLButtonElement;
  private readonly historyList: HTMLOListElement;
  private readonly historyEmpty: HTMLElement;
  private readonly controls: Array<HTMLButtonElement | HTMLInputElement> = [];
  /** Buttons inside the current result banner; replaced with every outcome. */
  private resultButtons: HTMLButtonElement[] = [];
  private selection: DiceSelection = { counts: emptyCounts(), modifier: 0 };
  private ready = false;
  private rolling = false;
  private fatal = false;

  constructor(root: HTMLElement, private readonly handlers: DiceUiHandlers) {
    this.stage = element('div', { className: 'stage__canvas' });
    this.overlayText = element('p', { className: 'stage__overlay-text' });
    this.overlay = element('div', { className: 'stage__overlay' }, [this.overlayText]);
    this.result = element('div', { className: 'result', attributes: { 'aria-live': 'polite' } });
    this.result.hidden = true;
    const stage = element('section', { className: 'stage', attributes: { 'aria-label': 'Лоток для кубиков' } }, [
      this.stage,
      this.result,
      this.overlay,
    ]);

    const picker = element('ul', { className: 'picker' });
    for (const type of DIE_TYPES) {
      const output = element('output', { className: 'picker__count', text: '0' });
      this.counters.set(type, output);
      const minus = button('−', 'picker__button', `Убрать ${dieLabel(type)}`);
      const plus = button('+', 'picker__button', `Добавить ${dieLabel(type)}`);
      minus.addEventListener('click', () => this.changeCount(type, -1));
      plus.addEventListener('click', () => this.changeCount(type, 1));
      this.controls.push(minus, plus);
      picker.append(element('li', { className: 'picker__row' }, [
        element('span', { className: `picker__die picker__die--${type}`, text: dieLabel(type) }),
        minus,
        output,
        plus,
      ]));
    }

    this.modifierOutput = element('output', { className: 'picker__count', text: '0' });
    const modifierMinus = button('−', 'picker__button', 'Уменьшить модификатор');
    const modifierPlus = button('+', 'picker__button', 'Увеличить модификатор');
    modifierMinus.addEventListener('click', () => this.changeModifier(-1));
    modifierPlus.addEventListener('click', () => this.changeModifier(1));
    this.controls.push(modifierMinus, modifierPlus);
    picker.append(element('li', { className: 'picker__row' }, [
      element('span', { className: 'picker__label', text: 'Модификатор' }),
      modifierMinus,
      this.modifierOutput,
      modifierPlus,
    ]));

    this.formulaInput = element('input', {
      className: 'formula__input',
      attributes: {
        type: 'text',
        inputmode: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        maxlength: '60',
        placeholder: 'Формула: 2d6+3',
        'aria-label': 'Формула броска',
      },
    });
    // No <form>: the iframe sandbox has no allow-forms, so the browser would never fire `submit`.
    const formulaApply = button('Применить', 'button');
    formulaApply.addEventListener('click', () => this.applyFormula());
    this.formulaInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.applyFormula();
      }
    });
    this.controls.push(this.formulaInput, formulaApply);
    const formula = element('div', { className: 'formula' }, [this.formulaInput, formulaApply]);
    this.formulaError = element('p', { className: 'formula__error', attributes: { role: 'alert' } });
    this.formulaError.hidden = true;

    this.summary = element('p', { className: 'summary' });
    this.rollButton = button('Бросить', 'button button--primary button--wide');
    this.rollButton.addEventListener('click', () => this.handlers.onRoll());

    this.historyList = element('ol', { className: 'history' });
    this.historyEmpty = element('p', { className: 'history__empty', text: 'Бросков пока нет' });
    const clearHistory = button('Очистить', 'link');
    clearHistory.addEventListener('click', () => this.handlers.onClearHistory());
    this.controls.push(clearHistory);

    this.notice = element('p', { className: 'notice', attributes: { role: 'status' } });
    this.notice.hidden = true;

    const panel = element('aside', { className: 'panel' }, [
      element('section', { className: 'panel__section' }, [
        element('h2', { className: 'panel__title', text: 'Набор' }),
        picker,
        formula,
        this.formulaError,
        this.summary,
        this.rollButton,
        this.notice,
      ]),
      element('section', { className: 'panel__section panel__section--history' }, [
        element('div', { className: 'history__header' }, [
          element('h2', { className: 'panel__title', text: 'История' }),
          clearHistory,
        ]),
        this.historyList,
        this.historyEmpty,
      ]),
    ]);

    root.replaceChildren(stage, panel);
    this.refreshControls();
  }

  setStatus(text: string | null): void {
    if (this.fatal) {
      return;
    }
    this.overlay.hidden = text === null;
    this.overlay.classList.remove('stage__overlay--error');
    this.overlayText.textContent = text ?? '';
  }

  showFatal(text: string): void {
    this.fatal = true;
    this.ready = false;
    this.overlay.hidden = false;
    this.overlay.classList.add('stage__overlay--error');
    this.overlayText.textContent = text;
    this.refreshControls();
  }

  setReady(ready: boolean): void {
    this.ready = ready && !this.fatal;
    this.refreshControls();
  }

  setRolling(rolling: boolean): void {
    this.rolling = rolling;
    this.rollButton.textContent = rolling ? 'Бросаем…' : 'Бросить';
    this.refreshControls();
  }

  setSelection(selection: DiceSelection): void {
    this.selection = selection;
    for (const type of DIE_TYPES) {
      this.counters.get(type)!.textContent = String(selection.counts[type]);
    }
    this.modifierOutput.textContent = selection.modifier > 0 ? `+${selection.modifier}` : String(selection.modifier);
    this.summary.textContent = totalDice(selection) > 0 ? `Бросок: ${formatSelection(selection)}` : 'Добавьте кубики';
    this.refreshControls();
  }

  showNotice(text: string | null): void {
    this.notice.hidden = text === null;
    this.notice.textContent = text ?? '';
  }

  showOutcome(outcome: RollOutcome | null, modifier: number): void {
    this.resultButtons = [];
    if (!outcome) {
      this.result.hidden = true;
      this.result.replaceChildren();
      return;
    }

    this.result.hidden = false;
    if (outcome.status !== 'OK') {
      const actions = element('div', { className: 'result__actions' });
      if (outcome.status === 'COCKED' && outcome.unreadable.length < outcome.dice.length) {
        const partial = button(`Перебросить спорные (${outcome.unreadable.length})`, 'button button--primary');
        partial.addEventListener('click', () => this.handlers.onRerollUnreadable());
        actions.append(partial);
      }
      const all = button('Перебросить всё', actions.childElementCount > 0 ? 'button' : 'button button--primary');
      all.addEventListener('click', () => this.handlers.onRoll());
      actions.append(all);
      this.resultButtons = [...actions.querySelectorAll('button')];
      this.result.className = 'result result--warning';
      this.result.replaceChildren(
        element('p', { className: 'result__warning', text: NOT_COUNTED[outcome.status] }),
        actions,
      );
      this.refreshControls();
      return;
    }

    const total = outcome.dice.reduce((sum, die) => sum + die.value, 0) + modifier;
    const chips = element('ul', { className: 'result__dice' }, outcome.dice.map((die) => element('li', {
      className: `result__die result__die--${die.type}`,
      text: String(die.value),
      attributes: { title: dieLabel(die.type) },
    })));
    this.result.className = 'result';
    this.result.replaceChildren(
      element('p', { className: 'result__total', text: String(total) }),
      element('p', {
        className: 'result__formula',
        text: `${recordFormula({ dice: outcome.dice, modifier })}: ${recordDetails({ dice: outcome.dice, modifier })}`,
      }),
      chips,
    );
  }

  setHistory(history: readonly RollRecord[]): void {
    this.historyEmpty.hidden = history.length > 0;
    this.historyList.replaceChildren(...history.map((record) => element('li', { className: 'history__item' }, [
      element('span', { className: 'history__total', text: String(record.total) }),
      element('span', { className: 'history__formula', text: recordFormula(record) }),
      element('span', { className: 'history__details', text: recordDetails(record) }),
      element('time', {
        className: 'history__time',
        text: new Date(record.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        attributes: { datetime: record.at },
      }),
    ])));
  }

  private changeCount(type: DieType, delta: number): void {
    const next = this.selection.counts[type] + delta;
    if (next < 0 || totalDice(this.selection) + delta > MAX_DICE_PER_ROLL) {
      return;
    }
    this.commitSelection({ ...this.selection, counts: { ...this.selection.counts, [type]: next } });
  }

  private changeModifier(delta: number): void {
    const next = this.selection.modifier + delta;
    if (Math.abs(next) > MAX_MODIFIER) {
      return;
    }
    this.commitSelection({ ...this.selection, modifier: next });
  }

  private applyFormula(): void {
    const result = parseNotation(this.formulaInput.value);
    if (!result.ok) {
      this.formulaError.hidden = false;
      this.formulaError.textContent = result.error;
      return;
    }
    this.formulaError.hidden = true;
    this.formulaInput.value = '';
    this.commitSelection(result.selection);
  }

  private commitSelection(selection: DiceSelection): void {
    this.setSelection(selection);
    this.handlers.onSelectionChange(selection);
  }

  private refreshControls(): void {
    const disabled = !this.ready || this.rolling;
    for (const control of [...this.controls, ...this.resultButtons]) {
      control.disabled = disabled;
    }
    this.rollButton.disabled = disabled || totalDice(this.selection) === 0;
  }
}
