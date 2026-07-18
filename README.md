# Semantic Watch

Telegram-сервис для мониторинга значимых изменений публичных веб-страниц.

Пользователь один раз задаёт URL и описывает интересующее событие обычным языком. На первом этапе сервис:

- ограничивает доступ по Telegram ID или ключу активации;
- безопасно загружает публичную страницу;
- извлекает читаемый текст;
- сохраняет snapshot и SHA-256 hash как исходное состояние;
- позволяет просматривать и останавливать наблюдения.

Семантическая AI-оценка изменений и фоновые проверки добавляются на следующих этапах.

## Стек

- Node.js 20+
- TypeScript
- grammY
- Cheerio
- JSON storage с атомарной записью
- Telegram Bot API через long polling

## Структура

```text
semantic-watch/
├── src/
│   ├── bot/                 # Telegram-команды и access guard
│   ├── config/              # env-конфигурация
│   ├── domain/              # модели наблюдения и snapshot
│   ├── fetcher/             # безопасная загрузка и извлечение текста
│   ├── storage/             # локальное JSON-хранилище
│   └── index.ts
├── demo-site/
│   ├── states/              # состояния страницы конференции
│   ├── current.html
│   ├── server.ts
│   └── switch-state.ts
├── data/
├── .env.example
└── package.json
```

## Подготовка Telegram-бота

1. Создайте бота через `@BotFather`.
2. Скопируйте выданный token.
3. Создайте `.env`:

```powershell
Copy-Item .env.example .env
```

4. Укажите token и длинный случайный ключ:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_OWNER_IDS=
ACCESS_KEY=replace_with_a_long_random_value
```

При пустом `TELEGRAM_OWNER_IDS` владелец может активировать себя командой:

```text
/activate replace_with_a_long_random_value
```

После активации Telegram ID сохраняется в `data/store.json`, ключ больше не требуется для обычных команд.

Для режима только владельца можно указать ID в `TELEGRAM_OWNER_IDS` и удалить значение `ACCESS_KEY`.

## Локальный запуск

Установите зависимости:

```powershell
npm install
```

Проверьте TypeScript:

```powershell
npm run typecheck
```

### Терминал 1: страница конференции

```powershell
npm run demo:closed
npm run demo
```

Откройте:

```text
http://127.0.0.1:3001/
```

### Терминал 2: Telegram-бот

```powershell
npm start
```

## Проверка этапа 1

В Telegram:

```text
/start
/activate <ключ>
/watch
```

В качестве URL отправьте:

```text
http://127.0.0.1:3001/
```

Условие:

```text
Сообщи, когда откроется регистрация для участников. Изменения состава спикеров игнорируй.
```

Ожидаемый результат: бот загружает страницу и сохраняет исходное состояние.

Проверьте список:

```text
/list
```

Остановите наблюдение:

```text
/stop <ID>
```

## Состояния демонстрационной страницы

Исходное состояние:

```powershell
npm run demo:closed
```

Изменился только состав спикеров:

```powershell
npm run demo:speakers
```

Открылась регистрация:

```powershell
npm run demo:open
```

HTTP-сервер перечитывает `current.html` на каждый запрос, поэтому перезапускать его после переключения не нужно.

## Ограничения доступа

Проверка Telegram ID выполняется до:

- загрузки пользовательского URL;
- чтения списка наблюдений;
- любых будущих LLM-вызовов.

Неавторизованный пользователь видит только свой Telegram ID и инструкцию по активации.

## Безопасная загрузка страниц

`SafePageFetcher`:

- поддерживает только HTTP/HTTPS;
- запрещает URL со встроенными credentials;
- проверяет адрес при каждом redirect;
- блокирует localhost, private, link-local и другие non-routable адреса;
- фиксирует проверенный IP через custom DNS lookup непосредственно для HTTP-соединения;
- ограничивает timeout, размер ответа и количество redirect;
- принимает только HTML/XHTML/plain text;
- не отправляет cookies и данные авторизации.

В локальном `DEMO_MODE` разрешён только **точный** URL из `DEMO_URL`. Остальные локальные адреса остаются запрещены.

## Данные и секреты

Не коммитятся:

- `.env`;
- `data/*.json`;
- собранный `dist/`;
- `node_modules/`.

Хранилище записывается через временный файл и atomic rename, чтобы не оставить частично записанный JSON при сбое процесса.
