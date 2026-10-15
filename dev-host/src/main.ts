import './styles.css';

import { ToolHostSession, type ToolHostTrace, type ToolSessionStatus } from '@tools-sdk/host';
import { createProtocolToken, type ToolCapability, type ToolManifest } from '@tools-sdk/protocol';

import { createLocalStateStore } from './local-store';

/**
 * Dev host: a stand-in for the TtRP shell. It embeds one tool from the local tools host (another origin,
 * the same sandbox as in TtRP) and drives the bridge by hand, so a tool author can check every
 * lifecycle path before sending the tool for connection.
 */

const USER_ID = 'dev-user';
const DEFAULT_MAX_STATE_BYTES = 262_144;
const CLOSE_DEADLINE_MS = 1500;

const tools = __DEV_HOST_TOOLS__;
const toolsOrigin = __DEV_HOST_TOOLS_ORIGIN__;
const store = createLocalStateStore();

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; attributes?: Record<string, string> } = {},
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

function button(text: string, onClick: () => void, className = 'button'): HTMLButtonElement {
  const node = element('button', { className, text, attributes: { type: 'button' } });
  node.addEventListener('click', onClick);
  return node;
}

const STATUS_TEXT: Record<ToolSessionStatus['kind'], string> = {
  loading: 'подключение…',
  ready: 'подключён',
  failed: 'остановлен',
  closed: 'закрыт',
};

// ── layout ──────────────────────────────────────────────────────────────
const root = document.getElementById('app')!;
const toolSelect = element('select', { className: 'field' });
for (const manifest of tools) {
  toolSelect.append(element('option', { text: `${manifest.title} (${manifest.id}@${manifest.version})`, attributes: { value: manifest.id } }));
}
const localStateCheckbox = element('input', { attributes: { type: 'checkbox', checked: '' } });
const maxStateInput = element('input', {
  className: 'field',
  attributes: { type: 'number', min: '1024', step: '1024', value: String(DEFAULT_MAX_STATE_BYTES) },
});
const statusLine = element('p', { className: 'status' });
const dirtyLine = element('p', { className: 'status' });
const capabilitiesLine = element('p', { className: 'status' });
const errorLine = element('p', { className: 'status status--error' });
const statePre = element('pre', { className: 'state' });
const logList = element('ol', { className: 'log' });
const frameBox = element('div', { className: 'frame' });
const placeholder = element('p', { className: 'placeholder', text: 'Окно закрыто. Нажмите «Запустить заново».' });

const toggleVisibilityButton = button('Скрыть окно', () => toggleVisibility());

root.append(
  element('header', { className: 'header' }, [
    element('strong', { text: 'TtRP Tools' }),
    element('span', { text: ' · песочница: оболочка-заглушка для локальной разработки инструментов' }),
  ]),
  element('aside', { className: 'panel' }, [
    element('label', { className: 'label', text: 'Инструмент' }, [toolSelect]),
    element('fieldset', { className: 'fieldset' }, [
      element('legend', { text: 'Политика оболочки' }),
      element('label', { className: 'checkbox' }, [localStateCheckbox, document.createTextNode(' LOCAL_STATE')]),
      element('label', { className: 'label', text: 'Лимит состояния, байт' }, [maxStateInput]),
    ]),
    element('div', { className: 'buttons' }, [
      button('Запустить заново', () => launch(), 'button button--primary'),
      toggleVisibilityButton,
      button('Закрыть окно (USER_CLOSE)', () => void closeWindow('USER_CLOSE')),
      button('Уйти из раздела (NAVIGATION)', () => void closeWindow('NAVIGATION')),
      button('Отозвать сессию (SESSION_REVOKED)', () => revoke()),
      button('Удалить сохранение', () => clearState()),
    ]),
    element('section', { className: 'section' }, [statusLine, dirtyLine, capabilitiesLine, errorLine]),
    element('section', { className: 'section' }, [element('h2', { text: 'Сохранённое состояние' }), statePre]),
  ]),
  element('main', { className: 'stage' }, [frameBox]),
  element('section', { className: 'journal' }, [
    element('div', { className: 'journal__header' }, [
      element('h2', { text: 'Журнал bridge' }),
      button('Очистить', () => logList.replaceChildren(), 'link'),
    ]),
    logList,
  ]),
);

// ── session ─────────────────────────────────────────────────────────────
let session: ToolHostSession | null = null;
let iframe: HTMLIFrameElement | null = null;
let visible = true;
let removeMessageListener: (() => void) | null = null;

function currentManifest(): ToolManifest {
  return tools.find((manifest) => manifest.id === toolSelect.value) ?? tools[0];
}

function stateKey(manifest: ToolManifest) {
  return { userId: USER_ID, appId: manifest.id, windowId: `dev-window-${manifest.id}` };
}

function log(text: string, tone: 'in' | 'out' | 'info' | 'error' = 'info'): void {
  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  logList.prepend(element('li', { className: `log__item log__item--${tone}`, text: `${time}  ${text}` }));
}

function describeTrace(trace: ToolHostTrace): [string, 'in' | 'out' | 'info' | 'error'] {
  switch (trace.kind) {
    case 'handshake':
      return trace.step === 'TOOL_READY' ? [`← ${trace.step}`, 'in'] : [`→ ${trace.step}`, 'out'];
    case 'request':
      return trace.ok ? [`← ${trace.method}  ✓`, 'in'] : [`← ${trace.method}  ✗ ${trace.code}`, 'error'];
    case 'event':
      return [`→ ${trace.type}`, 'out'];
    case 'status':
      return [`статус: ${STATUS_TEXT[trace.status.kind]}${trace.status.kind === 'failed' ? ` (${trace.status.reason})` : ''}`, trace.status.kind === 'failed' ? 'error' : 'info'];
  }
}

function renderState(): void {
  const stored = store.read(stateKey(currentManifest()));
  statePre.textContent = stored ? JSON.stringify(stored, null, 2) : 'пусто';
}

function renderStatus(status: ToolSessionStatus | null): void {
  statusLine.textContent = `Сессия: ${status ? STATUS_TEXT[status.kind] : 'нет'}${status?.kind === 'failed' ? ` — ${status.reason}${status.detail ? ` (${status.detail})` : ''}` : ''}`;
}

function teardown(): void {
  removeMessageListener?.();
  removeMessageListener = null;
  session?.dispose();
  session = null;
  iframe?.remove();
  iframe = null;
}

function launch(): void {
  teardown();
  placeholder.remove();
  const manifest = currentManifest();
  const allowedCapabilities: ToolCapability[] = localStateCheckbox.checked ? ['LOCAL_STATE'] : [];
  const maxStateBytes = Math.max(1024, Number(maxStateInput.value) || DEFAULT_MAX_STATE_BYTES);

  frameBox.style.width = `${manifest.window.width}px`;
  frameBox.style.height = `${manifest.window.height}px`;
  frameBox.style.minWidth = `${manifest.window.minWidth}px`;
  frameBox.style.minHeight = `${manifest.window.minHeight}px`;

  const frame = element('iframe', {
    attributes: {
      // The same sandbox as in TtRP: no forms, popups, downloads or top navigation.
      sandbox: 'allow-scripts allow-same-origin',
      referrerpolicy: 'no-referrer',
      title: manifest.title,
      src: `${toolsOrigin}/${manifest.id}/${manifest.version}/${manifest.entrypoint.replace(/^\.\//, '')}`,
    },
  });
  iframe = frame;

  const current = new ToolHostSession({
    entry: { manifest, allowedCapabilities, limits: { maxStateBytes } },
    binding: {
      instanceId: createProtocolToken(),
      windowId: stateKey(manifest).windowId,
      appId: manifest.id,
      appVersion: manifest.version,
    },
    toolsOrigin,
    userId: USER_ID,
    storage: store,
    locale: 'ru-RU',
    visible,
    frame: {
      get source() {
        return frame.contentWindow;
      },
      postMessage(message, targetOrigin, transfer) {
        frame.contentWindow?.postMessage(message, targetOrigin, transfer ?? []);
      },
    },
    onStatusChange: (status) => renderStatus(status),
    onDirtyChange: (dirty) => {
      dirtyLine.textContent = `Несохранённые изменения: ${dirty ? 'есть' : 'нет'}`;
    },
    onToolError: (error) => {
      errorLine.textContent = `Ошибка инструмента: ${error.code} — ${error.message}${error.fatal ? ' (фатальная)' : ''}`;
      log(`ошибка инструмента ${error.code}: ${error.message}`, 'error');
    },
    onTrace: (trace) => {
      const [text, tone] = describeTrace(trace);
      log(text, tone);
      if (trace.kind === 'request' && trace.method.startsWith('state.')) {
        renderState();
      }
    },
  });
  session = current;

  const onMessage = (event: MessageEvent) => current.handleWindowMessage(event);
  window.addEventListener('message', onMessage);
  removeMessageListener = () => window.removeEventListener('message', onMessage);
  frame.addEventListener('load', () => current.handleFrameLoad());

  capabilitiesLine.textContent = `Выдано: ${allowedCapabilities.filter((capability) => manifest.requestedCapabilities.includes(capability)).join(', ') || 'ничего'}`;
  dirtyLine.textContent = 'Несохранённые изменения: нет';
  errorLine.textContent = '';
  renderStatus(current.currentStatus);
  renderState();
  frameBox.append(frame);
  log(`запуск ${manifest.id}@${manifest.version}`);
}

function toggleVisibility(): void {
  visible = !visible;
  frameBox.classList.toggle('frame--hidden', !visible);
  toggleVisibilityButton.textContent = visible ? 'Скрыть окно' : 'Показать окно';
  session?.setVisible(visible);
}

async function closeWindow(reason: 'USER_CLOSE' | 'NAVIGATION'): Promise<void> {
  const current = session;
  if (!current) {
    return;
  }
  const manifest = currentManifest();
  if (reason === 'USER_CLOSE') {
    // As in TtRP: the tool gets up to 1.5 s to finish, then the window goes away.
    await current.requestClose(reason, CLOSE_DEADLINE_MS);
    if (session !== current) {
      return;
    }
  } else {
    // As in TtRP on leaving the section: no waiting, whatever autosave has stored is what remains.
    void current.requestClose(reason, 0);
  }
  teardown();
  if (reason === 'USER_CLOSE') {
    // As in TtRP: closing a window with the cross discards its state.
    store.remove(stateKey(manifest));
    log('окно закрыто, его состояние удалено (как в TtRP)');
  } else {
    log('уход из раздела: окно выгружено, состояние сохранено');
  }
  renderStatus(null);
  renderState();
  frameBox.append(placeholder);
}

function revoke(): void {
  session?.revoke();
}

function clearState(): void {
  store.remove(stateKey(currentManifest()));
  renderState();
  log('сохранение удалено');
}

toolSelect.addEventListener('change', () => launch());

if (tools.length === 0) {
  frameBox.append(element('p', { className: 'placeholder', text: 'Инструментов нет: создайте первый — npm run create-tool -- my-tool' }));
} else {
  launch();
}
