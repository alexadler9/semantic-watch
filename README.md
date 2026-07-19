# Semantic Watch

Telegram-сервис для мониторинга значимых изменений публичных веб-страниц.

Пользователь задаёт URL и описывает, на какие изменения нужно обратить внимание. Сервис:

- ограничивает доступ по Telegram ID или ключу активации;
- безопасно загружает публичную страницу;
- извлекает и нормализует читаемый текст;
- сохраняет snapshot и SHA-256 hash;
- с помощью AI формирует правило наблюдения из пользовательского описания;
- запускает AI-анализ только при реальном изменении страницы;
- проверяет подтверждающие цитаты перед показом результата;
- позволяет вручную проверять, просматривать и останавливать наблюдения.

Автоматические фоновые проверки добавляются на следующем этапе.

## Стек

- Node.js 20+
- TypeScript
- grammY
- Cheerio
- DeepSeek API
- JSON storage с атомарной записью
- Telegram Bot API через long polling

## Структура

```text
semantic-watch/
├── src/
│   ├── ai/                  # DeepSeek и семантическая оценка
│   ├── bot/                 # Telegram-команды и access guard
│   ├── checker/             # проверка наблюдений
│   ├── config/              # env-конфигурация
│   ├── domain/              # модели наблюдения и AI-результата
│   ├── fetcher/             # безопасная загрузка и извлечение текста
│   ├── storage/             # локальное JSON-хранилище
│   ├── utils/               # hash и текстовый diff
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

## Конфигурация

Создайте `.env` на основе `.env.example` и укажите Telegram token, способ доступа и DeepSeek API key:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_OWNER_IDS=
ACCESS_KEY=replace_with_a_long_random_value

DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash

MAX_LLM_CALLS_PER_DAY=50
MATCH_CONFIDENCE_THRESHOLD=0.8
```

При пустом `TELEGRAM_OWNER_IDS` пользователь может активировать доступ:

```text
/activate replace_with_a_long_random_value
```

После активации Telegram ID сохраняется в `data/store.json`. Чтобы запретить новые активации, удалите `ACCESS_KEY` из конфигурации и перезапустите сервис.

Для режима только владельца укажите ID в `TELEGRAM_OWNER_IDS` и не задавайте `ACCESS_KEY`.

## Локальный запуск

Установите зависимости и проверьте TypeScript:

```powershell
pnpm install
pnpm run typecheck
```

### Терминал 1: Telegram-бот

```powershell
pnpm start
```

### Терминал 2: демонстрационная страница

```powershell
pnpm run demo:closed
pnpm run demo
```

Страница будет доступна по адресу:

```text
http://127.0.0.1:3001/
```

Состояния страницы:

```powershell
pnpm run demo:closed
pnpm run demo:speakers
pnpm run demo:open
```

## Команды бота

```text
/start
/activate <ключ>
/watch
/list
/check [ID]
/stop <ID>
/cancel
```

`/watch` запрашивает URL и описание изменений, которые нужно отслеживать.

`/check`:

1. загружает текущее состояние страницы;
2. завершает проверку без AI-вызова, если hash не изменился;
3. строит компактный diff при изменении;
4. передаёт diff и правило наблюдения в DeepSeek;
5. принимает совпадение только при достаточной уверенности и наличии точных цитат из текущей страницы;
6. сохраняет новый snapshot.

## Безопасность и расходы

Проверка доступа выполняется до загрузки URL и LLM-вызовов. AI вызывается только при создании правила и при фактическом изменении страницы. Суточный лимит задаётся через `MAX_LLM_CALLS_PER_DAY`.

Результат модели проверяется схемой, порогом уверенности и наличием evidence в текущем тексте страницы.

Подробнее: [SECURITY.md](SECURITY.md).

## Данные и секреты

Не коммитятся:

- `.env`;
- `data/*.json`;
- `dist/`;
- `node_modules/`.

Хранилище записывается через временный файл и atomic rename, чтобы не оставить частично записанный JSON при сбое процесса.
