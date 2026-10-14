import { z } from 'zod';

import { DIE_TYPES } from './dice/types';
import { MAX_DICE_PER_ROLL, MAX_MODIFIER, emptyCounts, type DiceSelection } from './notation';

import type { JsonValue, StateSnapshot } from '@tools-sdk/protocol';

/** Saved state of one dice window. Bump the version together with a migration in restoreDiceState. */
export const DICE_STATE_SCHEMA_VERSION = 1;
export const MAX_HISTORY = 50;

const countSchema = z.number().int().min(0).max(MAX_DICE_PER_ROLL);
const modifierSchema = z.number().int().min(-MAX_MODIFIER).max(MAX_MODIFIER);

const selectionSchema = z.object({
  counts: z.object({
    d4: countSchema,
    d6: countSchema,
    d8: countSchema,
    d10: countSchema,
    d12: countSchema,
    d20: countSchema,
  }).strict(),
  modifier: modifierSchema,
}).strict();

const rollRecordSchema = z.object({
  id: z.string().min(1).max(64),
  at: z.string().datetime(),
  dice: z.array(z.object({
    type: z.enum(DIE_TYPES),
    value: z.number().int().min(1).max(20),
  }).strict()).min(1).max(MAX_DICE_PER_ROLL),
  modifier: modifierSchema,
  total: z.number().int(),
}).strict();

const diceStateSchema = z.object({
  selection: selectionSchema,
  history: z.array(rollRecordSchema).max(MAX_HISTORY),
}).strict();

export type RollRecord = z.infer<typeof rollRecordSchema>;
export type DiceState = z.infer<typeof diceStateSchema>;

export function initialDiceState(): DiceState {
  return {
    selection: { counts: { ...emptyCounts(), d20: 1 }, modifier: 0 },
    history: [],
  };
}

/** A broken or unknown save never breaks the tool: it starts clean and says so. */
export function restoreDiceState(snapshot: StateSnapshot | null): { state: DiceState; reset: boolean } {
  if (!snapshot) {
    return { state: initialDiceState(), reset: false };
  }
  if (snapshot.schemaVersion !== DICE_STATE_SCHEMA_VERSION) {
    return { state: initialDiceState(), reset: true };
  }
  const parsed = diceStateSchema.safeParse(snapshot.state);
  return parsed.success ? { state: parsed.data, reset: false } : { state: initialDiceState(), reset: true };
}

export function toSnapshotState(state: DiceState): JsonValue {
  return JSON.parse(JSON.stringify(state)) as JsonValue;
}

export function withSelection(state: DiceState, selection: DiceSelection): DiceState {
  return { ...state, selection };
}

export function withRoll(state: DiceState, record: RollRecord): DiceState {
  return { ...state, history: [record, ...state.history].slice(0, MAX_HISTORY) };
}

export function withoutHistory(state: DiceState): DiceState {
  return { ...state, history: [] };
}
