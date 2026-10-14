import { DIE_TYPES, dieLabel, isDieType, type DieType } from './dice/types';

export interface DiceSelection {
  counts: Record<DieType, number>;
  modifier: number;
}

export const MAX_DICE_PER_ROLL = 20;
export const MAX_MODIFIER = 999;

export function emptyCounts(): Record<DieType, number> {
  return { d4: 0, d6: 0, d8: 0, d10: 0, d12: 0, d20: 0 };
}

export function totalDice(selection: DiceSelection): number {
  return DIE_TYPES.reduce((sum, type) => sum + selection.counts[type], 0);
}

/** Dice to throw, grouped by type in the D4…D20 order. */
export function selectionToTypes(selection: DiceSelection): DieType[] {
  return DIE_TYPES.flatMap((type) => Array.from({ length: selection.counts[type] }, () => type));
}

/** "2d6 + d20 + 3" — the same notation the formula field accepts. */
export function formatSelection(selection: DiceSelection): string {
  const parts = DIE_TYPES
    .filter((type) => selection.counts[type] > 0)
    .map((type) => `${selection.counts[type] === 1 ? '' : selection.counts[type]}${type}`);
  if (selection.modifier !== 0 || parts.length === 0) {
    parts.push(String(Math.abs(selection.modifier)));
  }
  return parts
    .map((part, index) => {
      if (index === 0) {
        return selection.modifier < 0 && parts.length === 1 ? `−${part}` : part;
      }
      const isModifier = index === parts.length - 1 && selection.modifier !== 0;
      return `${isModifier && selection.modifier < 0 ? '−' : '+'} ${part}`;
    })
    .join(' ');
}

export type NotationResult =
  | { ok: true; selection: DiceSelection }
  | { ok: false; error: string };

const TERM_PATTERN = /([+-]?)(\d*)d(\d+)|([+-]?)(\d+)/y;

/**
 * Parses expressions like `2d6+3`, `d20 - 1`, `3d6+1d4`. Russian `к`/`д` work as `d`.
 * No eval: only dice terms and integer modifiers.
 */
export function parseNotation(input: string): NotationResult {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/[−–]/g, '-')
    .replace(/\s*([+-])\s*/g, '$1')
    .replace(/[дк]/g, 'd');
  if (!text) {
    return { ok: false, error: 'Введите формулу, например 2d6+3' };
  }
  if (/\s/.test(text)) {
    return { ok: false, error: 'Части формулы разделяются знаками + и −' };
  }

  const counts = emptyCounts();
  let modifier = 0;
  let position = 0;

  while (position < text.length) {
    TERM_PATTERN.lastIndex = position;
    const match = TERM_PATTERN.exec(text);
    if (!match || match.index !== position) {
      return { ok: false, error: `Не понимаю «${text.slice(position)}»` };
    }
    const [term, diceSign = '', countText, sidesText, numberSign = '', numberText] = match;
    const sign = sidesText !== undefined ? diceSign : numberSign;
    if (position > 0 && sign === '') {
      return { ok: false, error: 'Части формулы разделяются знаками + и −' };
    }

    if (sidesText !== undefined) {
      if (sign === '-') {
        return { ok: false, error: 'Вычитать кубики нельзя' };
      }
      const type = `d${Number(sidesText)}`;
      if (type === 'd100') {
        return { ok: false, error: 'D100 появится позже' };
      }
      if (!isDieType(type)) {
        return { ok: false, error: 'Доступны d4, d6, d8, d10, d12 и d20' };
      }
      const count = countText === '' ? 1 : Number(countText);
      if (count < 1) {
        return { ok: false, error: 'Количество кубиков должно быть больше нуля' };
      }
      counts[type] += count;
    } else {
      modifier += Number(numberText) * (sign === '-' ? -1 : 1);
    }
    position += term.length;
  }

  const selection = { counts, modifier };
  const dice = totalDice(selection);
  if (dice === 0) {
    return { ok: false, error: 'Добавьте хотя бы один кубик' };
  }
  if (dice > MAX_DICE_PER_ROLL) {
    return { ok: false, error: `Не больше ${MAX_DICE_PER_ROLL} кубиков за бросок` };
  }
  if (Math.abs(modifier) > MAX_MODIFIER) {
    return { ok: false, error: `Модификатор — от −${MAX_MODIFIER} до ${MAX_MODIFIER}` };
  }
  return { ok: true, selection };
}

export function describeDie(type: DieType, value: number): string {
  return `${dieLabel(type)}: ${value}`;
}
