import './styles.css';

import { connectToHost, createAutosave, type Autosave, type ToolHostClient } from '@tools-sdk/client';

import manifest from '../tool.manifest.json';

import { selectionToTypes } from './notation';
import { DiceAudio } from './sound/audio';
import {
  DICE_STATE_SCHEMA_VERSION,
  restoreDiceState,
  toSnapshotState,
  withRoll,
  withSelection,
  withSound,
  withoutHistory,
  type DiceState,
} from './state';
import { DiceUi } from './ui';

import type { DiceEngine, RollOutcome } from './dice/engine';
import type { DieType } from './dice/types';

/** Work that can wait: after the page has settled, before the user needs it. */
function whenIdle(task: () => void): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => task(), { timeout: 2000 });
  } else {
    setTimeout(task, 300);
  }
}

function reportError(client: ToolHostClient, code: string, message: string, fatal: boolean): void {
  void client.request('lifecycle.reportError', { code, message: message.slice(0, 500), fatal }).catch(() => {});
}

async function start(root: HTMLElement): Promise<void> {
  let state: DiceState = restoreDiceState(null).state;
  let engine: DiceEngine | null = null;
  let autosave: Autosave | null = null;
  /** The dice lying in the tray and the modifier of that throw, for a partial re-throw. */
  let lastThrow: { outcome: RollOutcome; modifier: number } | null = null;
  const audio = new DiceAudio(state.sound);

  // Browsers start audio only from a gesture in this frame: every roll button unlocks it first.
  const ui = new DiceUi(root, {
    onSelectionChange(selection) {
      state = withSelection(state, selection);
      autosave?.schedule();
    },
    onRoll() {
      audio.unlock();
      void roll();
    },
    onRerollUnreadable() {
      audio.unlock();
      void rerollUnreadable();
    },
    onClearHistory() {
      state = withoutHistory(state);
      ui.setHistory(state.history);
      autosave?.schedule();
    },
    onSoundChange(sound, preview) {
      state = withSound(state, sound);
      audio.update(state.sound);
      if (state.sound.enabled) {
        audio.unlock();
        if (preview) {
          audio.preview();
        }
      }
      autosave?.schedule();
    },
  });
  ui.setSelection(state.selection);
  ui.setHistory(state.history);
  ui.setSound(state.sound);
  ui.setStatus('Подключение к TtRP…');

  // Connect first: the shell is waiting for TOOL_READY while the heavy engine is not needed yet.
  let client: ToolHostClient;
  try {
    client = await connectToHost({
      appId: manifest.id,
      appVersion: manifest.version,
      allowedHostOrigins: __TTRP_HOST_ORIGINS__,
    });
  } catch {
    ui.showFatal('Кубики открываются в разделе «Инструменты» на TtRP.');
    return;
  }

  const canSave = client.grantedCapabilities.includes('LOCAL_STATE');
  if (canSave) {
    try {
      const restored = restoreDiceState(await client.request('state.load', {}));
      state = restored.state;
      if (restored.reset) {
        ui.showNotice('Сохранённое состояние не прочиталось, начинаем заново.');
      }
    } catch {
      ui.showNotice('Сохранения недоступны: история не запомнится.');
    }
    autosave = createAutosave(client, {
      schemaVersion: DICE_STATE_SCHEMA_VERSION,
      getState: () => toSnapshotState(state),
    });
  }
  ui.setSelection(state.selection);
  ui.setHistory(state.history);
  ui.setSound(state.sound);
  audio.update(state.sound);

  let visible = client.initiallyVisible;
  audio.setPaused(!visible);
  client.subscribe((event) => {
    switch (event.type) {
      case 'VISIBILITY_CHANGED':
        visible = event.visible;
        engine?.setPaused(!visible);
        audio.setPaused(!visible);
        break;
      case 'CLOSE_REQUESTED':
        void (async () => {
          await autosave?.flush().catch(() => {});
          await client.request('lifecycle.closeReady', { closeRequestId: event.closeRequestId }).catch(() => {});
        })();
        break;
      case 'SESSION_REVOKED':
        autosave?.dispose();
        autosave = null;
        engine?.dispose();
        engine = null;
        audio.dispose();
        ui.showFatal('Сессия завершена.');
        break;
    }
  });

  ui.setStatus('Готовим стол…');
  try {
    // Three.js and Rapier (WebAssembly inlined) are the heavy part: loaded after the handshake.
    const { DiceEngine } = await import('./dice/engine');
    engine = await DiceEngine.create(ui.stage, {
      onContextLost: () => {
        ui.showFatal('Графика остановилась. Перезапустите окно.');
        reportError(client, 'WEBGL_CONTEXT_LOST', 'WebGL context lost', true);
      },
      onContacts: (batch) => audio.play(batch),
    });
  } catch (error) {
    ui.showFatal('Не удалось запустить 3D: браузер не поддерживает WebGL.');
    reportError(client, 'ENGINE_START_FAILED', String(error), true);
    return;
  }
  if (client.closed) {
    engine.dispose();
    engine = null;
    return;
  }
  engine.setPaused(!visible);
  ui.setStatus(null);
  ui.setReady(true);
  // The sound's takes (≈ 70 ms of synthesis) are rendered now, not on the first click.
  if (state.sound.enabled) {
    whenIdle(() => audio.prepare());
  }

  async function play(
    start: (dice: DiceEngine) => Promise<RollOutcome>,
    modifier: number,
    thrown: readonly DieType[],
  ): Promise<void> {
    if (!engine || engine.rolling) {
      return;
    }
    ui.setRolling(true);
    ui.showOutcome(null, modifier);
    audio.throwStarted(thrown);
    try {
      const outcome = await start(engine);
      lastThrow = { outcome, modifier };
      ui.showOutcome(outcome, modifier);
      if (outcome.status === 'OK') {
        state = withRoll(state, {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          dice: outcome.dice,
          modifier,
          total: outcome.dice.reduce((sum, die) => sum + die.value, 0) + modifier,
        });
        ui.setHistory(state.history);
        autosave?.schedule();
      }
    } catch (error) {
      reportError(client, 'ROLL_FAILED', String(error), false);
    } finally {
      ui.setRolling(false);
    }
  }

  async function roll(): Promise<void> {
    const types = selectionToTypes(state.selection);
    if (types.length > 0) {
      await play((dice) => dice.throwDice(types), state.selection.modifier, types);
    }
  }

  async function rerollUnreadable(): Promise<void> {
    const previous = lastThrow;
    if (previous && previous.outcome.unreadable.length > 0) {
      const { dice, unreadable } = previous.outcome;
      await play(
        (engineDice) => engineDice.rethrowDice(unreadable),
        previous.modifier,
        unreadable.map((index) => dice[index].type),
      );
    }
  }
}

const root = document.getElementById('app');
if (root) {
  void start(root);
}
