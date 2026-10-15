# SDK инструментов TtRP

Модули импортируются как `@tools-sdk/<модуль>` — алиас настроен в Vite (`scripts/lib.mjs`), Vitest и `tsconfig.json`. Единственная зависимость — `zod`.

| Модуль | Сторона | Что экспортирует |
|---|---|---|
| `client` | инструмент | `connectToHost`, `ToolHostClient`, `ToolBridgeError`, `createAutosave` |
| `protocol` | обе | константы протокола, zod-схемы сообщений и манифеста, типы `ToolManifest`, `StateSnapshot`, `JsonValue`, `isJsonValue`, `jsonByteLength`, `createProtocolToken` |
| `host` | оболочка | `ToolHostSession`, `grantCapabilities`, типы статусов, ошибок и трассировки |
| `storage` | оболочка | интерфейс `ToolStateStore`, `createMemoryStateStore`, `windowStateId` |
| `snapshots` | оболочка | `selectSnapshotForLoad`, `applySnapshotSave` — правила резервной копии при смене схемы |

Инструмент использует только `client` и типы из `protocol`. `host`, `storage` и `snapshots` нужны оболочке: сайту TtRP и песочнице `dev-host/`.

## Инструмент

Полный каркас — [`template/src/main.ts`](../template/src/main.ts):

```ts
const client = await connectToHost({
  appId: manifest.id,
  appVersion: manifest.version,
  allowedHostOrigins: __TTRP_HOST_ORIGINS__,
});
const restored = restoreState(await client.request('state.load', {}));
const autosave = createAutosave(client, { schemaVersion: STATE_SCHEMA_VERSION, getState: () => toSnapshotState(state) });
client.subscribe((event) => { /* VISIBILITY_CHANGED, CLOSE_REQUESTED, SESSION_REVOKED */ });
```

`__TTRP_HOST_ORIGINS__` — список доверенных оболочек, который сборка подставляет из окружения (см. `scripts/lib.mjs`, `resolveHostOrigins`).

## Оболочка

Пример — [`dev-host/src/main.ts`](../dev-host/src/main.ts):

```ts
const session = new ToolHostSession({
  entry: { manifest, allowedCapabilities: ['LOCAL_STATE'], limits: { maxStateBytes: 262_144 } },
  binding: { instanceId: createProtocolToken(), windowId, appId: manifest.id, appVersion: manifest.version },
  toolsOrigin,                      // origin, с которого загружен iframe
  userId,
  storage,                          // ToolStateStore: IndexedDB, localStorage или память
  locale: 'ru-RU',
  visible: true,
  frame: { get source() { return iframe.contentWindow; }, postMessage: (m, o, t) => iframe.contentWindow?.postMessage(m, o, t ?? []) },
});
window.addEventListener('message', (event) => session.handleWindowMessage(event));
iframe.addEventListener('load', () => session.handleFrameLoad());
```

Iframe — с `sandbox="allow-scripts allow-same-origin"` и с другого origin, чем оболочка. Дальше оболочка вызывает `setVisible`, `requestClose(reason, deadlineMs)`, `revoke()` и `dispose()`.

## Изменения SDK

- Сообщения меняются вместе со схемами в `protocol.ts`, тестами `bridge.test.ts` и [docs/protocol.md](../docs/protocol.md).
- Несовместимое изменение — новая `BRIDGE_VERSION`; оболочка перечисляет поддерживаемые версии в `SUPPORTED_BRIDGE_VERSIONS`.
- Новую возможность сначала реализуют в `host.ts` и добавляют в `IMPLEMENTED_CAPABILITIES`: без этого инструмент её не получит, что бы ни было в манифесте и каталоге.
