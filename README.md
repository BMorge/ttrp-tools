# TtRP Tools

Встраиваемые инструменты для [Time to Roleplay](https://timetoroleplay.ru) (TtRP) — платформы подбора игроков для настольных ролевых игр. Инструмент — небольшое веб-приложение (кубики, трекер инициативы, генератор имён…), которое открывается окном в разделе «Инструменты» на сайте TtRP.

В репозитории:

- **SDK** (`sdk/`) — протокол связи (bridge) между оболочкой TtRP и инструментом: клиент для инструмента, хост для оболочки, хранилище состояния;
- **песочница** (`dev-host/`) — локальная замена оболочки TtRP: запускает инструмент так же, как сайт, и позволяет вручную вызвать любое событие окна;
- **кубики** (`dice/`) — полноценный пример: физические 3D-кубики D4–D20 на Three.js и Rapier;
- **шаблон** (`template/`) — минимальный инструмент, из которого `npm run create-tool` делает новый;
- документация, правила для разработчиков и ИИ-агентов, юридические условия.

## Быстрый старт

Нужен Node.js 20.19+ или 22.12+.

```bash
npm install
npm run dev
```

Откройте <http://localhost:5180> — это песочница. Слева выберите инструмент, справа — журнал сообщений bridge. Песочница встраивает инструмент с другого origin (`http://localhost:5173`) с той же изоляцией, что и TtRP, поэтому то, что работает в ней, работает и на сайте.

## Новый инструмент

```bash
npm run create-tool -- initiative "Трекер инициативы"
```

Команда копирует `template/` в `initiative/` и заполняет манифест. Перезапустите `npm run dev` — инструмент появится в песочнице. Дальше:

1. прочитайте [docs/best-practices.md](docs/best-practices.md) — короткий список того, что можно и нельзя в окне TtRP;
2. пишите код в `initiative/src/`, состояние окна и его схему — в `initiative/src/state.ts`;
3. перед отправкой — `npm run check` и чек-лист из [docs/connecting.md](docs/connecting.md).

## Команды

| Команда | Что делает |
|---|---|
| `npm run dev` | песочница на `:5180` и хост инструментов на `:5173` с горячей перезагрузкой |
| `npm test` | тесты, включая проверку манифестов всех инструментов |
| `npm run typecheck` | проверка типов TypeScript |
| `npm run build` | сборка в `dist/<id>/<version>/` (`-- --only dice` — один инструмент) |
| `npm run serve` | раздача собранного так же, как на проде: заголовки безопасности, кэш |
| `npm run check` | typecheck + тесты + сборка — то же, что проверяет CI |
| `npm run create-tool -- <id> [Название]` | новый инструмент из шаблона |

Проверить собранную версию в песочнице (сборка по умолчанию доверяет только сайту TtRP, поэтому origin песочницы указывается явно):

```bash
npm run build -- --host-origins http://localhost:5180
npm run serve
```

и в соседнем терминале `npm run dev -- --host-only` — песочница без dev-сервера инструментов.

## Структура

```text
sdk/            протокол, клиент инструмента, хост оболочки, хранилище, правила снимков
dev-host/       песочница — заглушка оболочки TtRP
dice/           пример: 3D-кубики
template/       шаблон нового инструмента
<id>/           ваш инструмент: tool.manifest.json, index.html, src/
scripts/        dev, build, serve, create-tool и проверка манифестов
docs/           архитектура, протокол, best practices, подключение
legal/          CLA и условия подключения инструментов
```

Каждый инструмент — отдельная папка с `tool.manifest.json`; имя папки совпадает с `id` манифеста. Инструменты не импортируют код друг друга и песочницы: общий код — только `sdk/`.

## Как инструмент попадает в TtRP

1. Инструмент живёт в этом репозитории отдельной папкой и проходит `npm run check`.
2. Вы открываете pull request, принимаете [CLA](legal/cla.md), а для подключения к сайту — [Условия подключения инструментов](legal/tool-terms.md).
3. Команда TtRP проверяет код (безопасность, производительность, интерфейс), решает, какие возможности и лимиты выдать, и включает инструмент на сайте.

Подробно — [docs/connecting.md](docs/connecting.md).

## Документация

- [docs/architecture.md](docs/architecture.md) — как устроено встраивание: два origin, песочница iframe, рукопожатие, состояние, жизненный цикл окна, сборка;
- [docs/protocol.md](docs/protocol.md) — справочник bridge v1: сообщения, методы, события, ошибки, лимиты, манифест;
- [docs/best-practices.md](docs/best-practices.md) — как писать инструмент, чтобы его подключили;
- [docs/connecting.md](docs/connecting.md) — чек-лист и порядок подключения;
- [sdk/README.md](sdk/README.md) — модули SDK;
- [AGENTS.md](AGENTS.md) и skill [`ttrp-tool`](.claude/skills/ttrp-tool/SKILL.md) — правила для ИИ-агентов.

## Лицензия и права

- Код репозитория распространяется по лицензии [Apache License 2.0](LICENSE), см. также [NOTICE](NOTICE).
- Вклад в репозиторий принимается на условиях [Соглашения о предоставлении прав на вклад (CLA)](legal/cla.md).
- Подключение инструмента к сервису Time to Roleplay — по [Условиям подключения инструментов](legal/tool-terms.md).
- Названия и логотипы TtRP, Time to Roleplay лицензией не передаются.
- Правообладатель — ООО «ТАЙМ ТУ РОЛЕПЛЕЙ» (ООО «ТТРП»). Вопросы о правах — admin@timetoroleplay.ru, уязвимости — по [SECURITY.md](SECURITY.md).

Репозиторий — зеркало папки основного репозитория TtRP. Pull request принимаются здесь: команда TtRP переносит изменения в основной репозиторий с сохранением авторства, они возвращаются сюда со следующей синхронизацией, а PR закрывается ссылкой на коммит.

## English

TtRP Tools is the SDK, a local dev host and examples for tools embedded into [Time to Roleplay](https://timetoroleplay.ru), a matchmaking platform for tabletop role-playing games. A tool is a small web app that runs in a sandboxed iframe on a separate origin and talks to the TtRP shell over a `postMessage` + `MessagePort` bridge. Run `npm install && npm run dev` and open <http://localhost:5180>; create a tool with `npm run create-tool -- <id>`. Documentation is in Russian. Code is licensed under Apache-2.0; contributions require accepting the CLA in `legal/cla.md`.
