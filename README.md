# Semantic Watch

Telegram-сервис для мониторинга изменений публичных веб-страниц.

Пользователь один раз задаёт URL и описывает интересующее событие. На первом этапе сервис:

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

Укажите token и длинный случайный ключ в .env-файле:

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

### Терминал 1: Telegram-бот

```powershell
npm start
```

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
