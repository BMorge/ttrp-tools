# Протокол bridge v1

Справочник сообщений между оболочкой TtRP и инструментом. Источник истины — схемы в [`sdk/protocol.ts`](../sdk/protocol.ts): обе стороны проверяют каждое входящее сообщение, сообщения с лишними или неверными полями отбрасываются. Как это используется, см. [architecture.md](architecture.md).

## 1. Манифест `tool.manifest.json`

| Поле | Правило |
|---|---|
| `manifestVersion` | `1` |
| `id` | `^[a-z0-9][a-z0-9-]{0,62}$`, совпадает с именем папки; часть URL `/<id>/<version>/` |
| `version` | `MAJOR.MINOR.PATCH`; каждая выпущенная версия неизменна |
| `title` | 1–60 символов: название в списке и в заголовке окна |
| `description` | до 200 символов |
| `bridgeVersion` | версия протокола, сейчас `1` |
| `entrypoint` | HTML относительно корня сборки, сегменты без точек: `./index.html` |
| `storageSchemaVersion` | целое ≥ 1: самая новая схема состояния, которую пишет эта версия |
| `requestedCapabilities` | нужные возможности, сейчас доступна только `LOCAL_STATE` |
| `window.width`, `window.height` | начальный размер окна, 200–4000 |
| `window.minWidth`, `window.minHeight` | минимальный размер, 200–4000, не больше начального |
| `window.multipleInstances` | можно ли открыть несколько окон этого инструмента |

Других полей быть не должно. `npm test` проверяет манифесты всех инструментов.

## 2. Рукопожатие

Через `window.postMessage`, у каждого сообщения `protocol: "TTRP_TOOLS"` и `bridgeVersion: 1`. Идентификаторы (`instanceId`, `windowId`, `challenge`, `requestId`, `closeRequestId`) — непрозрачные строки `^[A-Za-z0-9_-]{8,128}$`.

| Сообщение | Кто → кому | Поля |
|---|---|---|
| `HOST_HELLO` | оболочка → iframe, на origin инструментов | `instanceId`, `windowId`, `appId`, `appVersion`, `challenge` |
| `TOOL_READY` | инструмент → родитель, на origin из `HOST_HELLO` | `challenge`, `instanceId`, `appId`, `appVersion` |
| `HOST_CONNECT` | оболочка → iframe + ровно один `MessagePort` | `instanceId`, `windowId`, `appId`, `appVersion`, `challenge`, `grantedCapabilities`, `locale`, `visible` |

- Оболочка повторяет `HOST_HELLO` каждые 250 мс до `TOOL_READY`; общий таймаут — 15 с.
- Инструмент принимает `HOST_HELLO` только от родительского окна с origin из списка доверенных и со своим `appId`; повторы того же экземпляра получают тот же ответ.
- Оболочка принимает `TOOL_READY` только с origin инструментов, от своего iframe, с её `challenge` и `instanceId`, поддерживаемой версией bridge и теми `appId`/`appVersion`, которые она открыла.

Всё это делает `connectToHost` из `sdk/client.ts`.

## 3. Запросы

Через `MessagePort`. Запрос инструмента:

```json
{ "type": "REQUEST", "instanceId": "…", "requestId": "…", "method": "state.save", "params": { … } }
```

Ответ оболочки повторяет `instanceId`, `requestId`, `method` и содержит либо `"ok": true, "result": …`, либо `"ok": false, "error": { "code": "…", "message": "…" }`.

| Метод | Параметры | Возможность | Результат |
|---|---|---|---|
| `state.load` | `{}` | `LOCAL_STATE` | снимок `{ state, schemaVersion, updatedAt }` или `null` |
| `state.save` | `{ state, schemaVersion }` | `LOCAL_STATE` | `{ updatedAt }` |
| `lifecycle.setDirty` | `{ dirty: boolean }` | — | `null` |
| `lifecycle.closeReady` | `{ closeRequestId }` | — | `null` |
| `lifecycle.reportError` | `{ code, message, fatal }` | — | `null` |

- `state.load` отдаёт текущий снимок, если его схема не новее `storageSchemaVersion` манифеста; иначе — резервный снимок прежней схемы (после отката версии); иначе `null`.
- `state.save`: `state` — только JSON-данные (простые объекты, массивы, строки, конечные числа, `true`/`false`/`null`, вложенность до 64); `schemaVersion` не больше `storageSchemaVersion` манифеста; размер JSON в UTF-8 не больше лимита каталога. При росте `schemaVersion` прежний снимок становится резервным.
- `lifecycle.setDirty` сообщает, есть ли несохранённые изменения: оболочка предупредит пользователя перед уходом и закрытием окна. `createAutosave` отправляет его сам.
- `lifecycle.closeReady` подтверждает `CLOSE_REQUESTED` с тем же `closeRequestId`.
- `lifecycle.reportError`: `code` — `^[A-Z][A-Z0-9_]{0,63}$`, `message` — до 500 символов. При `fatal: true` оболочка отвечает и останавливает экземпляр (`TOOL_FATAL`).

## 4. События оболочки

Через `MessagePort`, у каждого есть `instanceId`. Неизвестные события клиент SDK пропускает.

| Событие | Поля | Когда |
|---|---|---|
| `VISIBILITY_CHANGED` | `visible` | окно свернули или развернули |
| `CLOSE_REQUESTED` | `closeRequestId`, `deadlineMs` (0–60000), `reason`: `USER_CLOSE` или `NAVIGATION` | закрытие окна крестиком (1500 мс, затем состояние удаляется) или уход из раздела (0 мс, оболочка не ждёт) |
| `SESSION_REVOKED` | — | выход из аккаунта или смена пользователя; после события порт закрывается, сохранять больше нельзя |

## 5. Ошибки

| Код | Значение |
|---|---|
| `CAPABILITY_DENIED` | возможность не выдана |
| `INVALID_REQUEST` | неверные параметры, не-JSON состояние, схема новее манифеста |
| `UNSUPPORTED_METHOD` | метод неизвестен оболочке |
| `LIMIT_EXCEEDED` | слишком много запросов или состояние больше лимита |
| `STORAGE_UNAVAILABLE` | хранилище оболочки недоступно |
| `INTERNAL_ERROR` | ошибка оболочки |
| `TIMEOUT` | ответа нет вовремя (на стороне клиента, по умолчанию 10 с) |
| `SESSION_CLOSED` | связь закрыта: `SESSION_REVOKED` или `dispose()` |

Только у клиента SDK: `ABORTED` (запрос отменён `AbortSignal`), `NOT_EMBEDDED` (страница открыта не в iframe), `HANDSHAKE_TIMEOUT` (оболочка не ответила), `INVALID_RESPONSE` (ответ не прошёл проверку).

Таймаут и отмена — только на стороне клиента: оболочка могла уже выполнить запрос, поэтому сохранение с `TIMEOUT` не значит «не сохранено».

## 6. Лимиты

| Что | Значение |
|---|---|
| Частота запросов | 60 подряд, затем 30 в секунду; сверх — `LIMIT_EXCEEDED` |
| Размер состояния | из каталога TtRP (`maxStateBytes`), у кубиков 262 144 байта |
| Рукопожатие | 15 с; `HOST_HELLO` каждые 250 мс |
| Ответ на запрос | по умолчанию 10 с, `timeoutMs` в опциях запроса |
| Закрытие крестиком | 1500 мс на `lifecycle.closeReady` |

## 7. Остановка экземпляра

Оболочка останавливает окно и предлагает перезапуск, если:

| Причина | Что случилось |
|---|---|
| `HANDSHAKE_TIMEOUT` | нет `TOOL_READY` за 15 с |
| `BRIDGE_MISMATCH` | инструмент собран под неподдерживаемую версию bridge |
| `VERSION_MISMATCH` | `appId`/`appVersion` инструмента не совпали с открытыми |
| `RELOADED` | документ iframe загрузился второй раз |
| `TOOL_FATAL` | инструмент сообщил о фатальной ошибке |

Если инструмент к этому моменту подключён, он сначала получает `SESSION_REVOKED`.

## 8. Версии протокола

- `bridgeVersion` меняется только при несовместимых изменениях; оболочка знает список поддерживаемых версий.
- В рамках v1 могут появиться новые методы, события и возможности. Инструмент проверяет `client.grantedCapabilities`, обрабатывает `UNSUPPORTED_METHOD` и не падает на неизвестных событиях.

## 9. API клиента (`sdk/client.ts`)

```ts
const client = await connectToHost({
  appId: manifest.id,
  appVersion: manifest.version,
  allowedHostOrigins: __TTRP_HOST_ORIGINS__, // подставляется при сборке
});

client.grantedCapabilities;   // ['LOCAL_STATE'] или []
client.locale;                // 'ru-RU'
client.initiallyVisible;      // свёрнуто ли окно при запуске
const snapshot = await client.request('state.load', {});
const unsubscribe = client.subscribe((event) => { /* VISIBILITY_CHANGED, CLOSE_REQUESTED, SESSION_REVOKED */ });

const autosave = createAutosave(client, {
  schemaVersion: STATE_SCHEMA_VERSION,
  getState: () => toSnapshotState(state),
  debounceMs: 400,
  onError: (error) => { /* показать, что не сохранилось */ },
});
autosave.schedule();          // после каждого изменения
await autosave.flush();       // перед closeReady
autosave.dispose();           // при SESSION_REVOKED
```

`createAutosave` держит не больше одного сохранения в полёте, сохраняет через `debounceMs` после последнего изменения и сам сообщает оболочке `lifecycle.setDirty`.
