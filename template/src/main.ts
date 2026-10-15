import './styles.css';

import { connectToHost, createAutosave, type Autosave, type ToolHostClient } from '@tools-sdk/client';

import manifest from '../tool.manifest.json';

import { MAX_NOTE_LENGTH, STATE_SCHEMA_VERSION, restoreState, toSnapshotState, type ToolState } from './state';

/**
 * Template of a TtRP tool: a note that survives leaving the section. The whole contract with the shell
 * fits here — connect first, load state, autosave, react to host events. Replace the note with your tool.
 */

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`#${id} is missing in index.html`);
  }
  return node as T;
}

async function start(): Promise<void> {
  const note = requireElement<HTMLTextAreaElement>('note');
  const status = requireElement<HTMLParagraphElement>('status');
  const showStatus = (text: string) => {
    // Text only through textContent/value: never innerHTML with data.
    status.textContent = text;
  };

  // 1. Connect before any heavy work: the shell waits for TOOL_READY for 15 seconds.
  let client: ToolHostClient;
  try {
    client = await connectToHost({
      appId: manifest.id,
      appVersion: manifest.version,
      allowedHostOrigins: __TTRP_HOST_ORIGINS__,
    });
  } catch {
    showStatus('Инструмент открывается в разделе «Инструменты» на TtRP.');
    return;
  }

  // 2. State: only when the shell granted LOCAL_STATE; a broken save starts clean.
  let state: ToolState = restoreState(null).state;
  let autosave: Autosave | null = null;
  if (client.grantedCapabilities.includes('LOCAL_STATE')) {
    try {
      const restored = restoreState(await client.request('state.load', {}));
      state = restored.state;
      showStatus(restored.reset ? 'Сохранение не прочиталось — начинаем заново.' : '');
    } catch {
      showStatus('Сохранения недоступны: заметка не запомнится.');
    }
    autosave = createAutosave(client, {
      schemaVersion: STATE_SCHEMA_VERSION,
      getState: () => toSnapshotState(state),
      onError: () => showStatus('Не удалось сохранить заметку.'),
    });
  } else {
    showStatus('Оболочка не разрешила сохранения: заметка не запомнится.');
  }

  // 3. UI. No <form>: the sandbox has no allow-forms, so `submit` never fires — use click and keydown.
  note.maxLength = MAX_NOTE_LENGTH;
  note.value = state.note;
  note.disabled = false;
  note.addEventListener('input', () => {
    state = { note: note.value.slice(0, MAX_NOTE_LENGTH) };
    autosave?.schedule();
  });

  // 4. Host events.
  client.subscribe((event) => {
    switch (event.type) {
      case 'VISIBILITY_CHANGED':
        // The window was minimized or restored: pause and resume animations, timers and sound here.
        break;
      case 'CLOSE_REQUESTED':
        // Save what is pending and confirm; the shell waits until the deadline at most.
        void (async () => {
          await autosave?.flush().catch(() => {});
          await client.request('lifecycle.closeReady', { closeRequestId: event.closeRequestId }).catch(() => {});
        })();
        break;
      case 'SESSION_REVOKED':
        // Logout or another user: stop at once and never save again.
        autosave?.dispose();
        autosave = null;
        note.disabled = true;
        showStatus('Сессия завершена.');
        break;
    }
  });
}

void start();
