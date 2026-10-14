export const DIE_TYPES = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'] as const;
export type DieType = (typeof DIE_TYPES)[number];

export const DIE_SIDES: Record<DieType, number> = {
  d4: 4,
  d6: 6,
  d8: 8,
  d10: 10,
  d12: 12,
  d20: 20,
};

export function isDieType(value: string): value is DieType {
  return (DIE_TYPES as readonly string[]).includes(value);
}

export function dieLabel(type: DieType): string {
  return type.toUpperCase();
}
