import { describe, expect, it } from 'vitest';

import { formatSelection, parseNotation, selectionToTypes, totalDice } from './notation';

describe('parseNotation', () => {
  it('parses dice terms and modifiers', () => {
    const result = parseNotation(' 2d6 + d20 - 1 + 3 ');

    expect(result).toEqual({
      ok: true,
      selection: { counts: { d4: 0, d6: 2, d8: 0, d10: 0, d12: 0, d20: 1 }, modifier: 2 },
    });
  });

  it('accepts Russian letters for dice', () => {
    const result = parseNotation('3к6+1д4');

    expect(result.ok && result.selection.counts).toMatchObject({ d6: 3, d4: 1 });
  });

  it.each([
    ['', 'Введите формулу, например 2d6+3'],
    ['2d7', 'Доступны d4, d6, d8, d10, d12 и d20'],
    ['d100', 'D100 появится позже'],
    ['21d6', 'Не больше 20 кубиков за бросок'],
    ['3', 'Добавьте хотя бы один кубик'],
    ['2d6-1d4', 'Вычитать кубики нельзя'],
    ['2d6 3', 'Части формулы разделяются знаками + и −'],
    ['2d6*2', 'Не понимаю «*2»'],
    ['0d6', 'Количество кубиков должно быть больше нуля'],
    ['d6+1000', 'Модификатор — от −999 до 999'],
  ])('rejects %j', (input, error) => {
    expect(parseNotation(input)).toEqual({ ok: false, error });
  });
});

describe('selection helpers', () => {
  const selection = { counts: { d4: 0, d6: 2, d8: 0, d10: 0, d12: 0, d20: 1 }, modifier: -2 };

  it('orders dice by type', () => {
    expect(selectionToTypes(selection)).toEqual(['d6', 'd6', 'd20']);
    expect(totalDice(selection)).toBe(3);
  });

  it('formats the selection back into notation', () => {
    expect(formatSelection(selection)).toBe('2d6 + d20 − 2');
    expect(formatSelection({ ...selection, modifier: 0 })).toBe('2d6 + d20');
    expect(formatSelection({ ...selection, modifier: 4 })).toBe('2d6 + d20 + 4');
  });
});
