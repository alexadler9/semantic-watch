import { randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import type { SemanticEvaluator } from "../ai/semantic-evaluator.js";
import {
  WatchCheckInProgressError,
  type WatchCheckResult,
  type WatchCheckService,
} from "../checker/watch-check-service.js";
import type { AppConfig } from "../config/config.js";
import type { Watch } from "../domain/models.js";
import { SafePageFetcher } from "../fetcher/safe-page-fetcher.js";
import { formatImportantChange } from "../notifications/telegram-messages.js";
import { JsonStore } from "../storage/json-store.js";
import { normalizeInstruction, truncate } from "../utils/text.js";
import { addMinutesIso } from "../utils/time.js";
import { AccessService } from "./access-service.js";

interface PendingWatch {
  step: "WAITING_URL" | "WAITING_INSTRUCTION";
  url?: string;
}

export function createBot(
  appConfig: AppConfig,
  store: JsonStore,
  pageFetcher: SafePageFetcher,
  semanticEvaluator: SemanticEvaluator,
  checkService: WatchCheckService,
): Bot {
  const bot = new Bot(appConfig.telegramBotToken);
  const accessService = new AccessService(appConfig, store);
  const pendingWatches = new Map<string, PendingWatch>();

  bot.command("start", async (ctx) => {
    const userId = getUserId(ctx);
    if (await accessService.isAllowed(userId)) {
      await ctx.reply(helpText());
      return;
    }
    await ctx.reply(unauthorizedText(userId, accessService.isActivationEnabled()));
  });

  bot.command("activate", async (ctx) => {
    const userId = getUserId(ctx);
    if (await accessService.isAllowed(userId)) {
      await ctx.reply("Доступ уже активирован.");
      return;
    }
    if (!accessService.isActivationEnabled()) {
      await ctx.reply("Активация по ключу отключена.");
      return;
    }

    const key = ctx.match.trim();
    if (!key) {
      await ctx.reply("Использование: /activate <ключ>");
      return;
    }

    const activated = await accessService.activate(userId, key);
    await ctx.reply(activated ? "Доступ активирован." : "Неверный ключ доступа.");
  });

  bot.command("watch", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const activeCount = await store.countActiveWatches(userId);
    if (activeCount >= appConfig.maxActiveWatchesPerUser) {
      await ctx.reply(`Достигнут лимит активных наблюдений: ${appConfig.maxActiveWatchesPerUser}.`);
      return;
    }

    pendingWatches.set(userId, { step: "WAITING_URL" });
    await ctx.reply(
      "Отправьте публичную ссылку на страницу. Поддерживаются обычные HTTP/HTTPS-страницы без авторизации.",
    );
  });

  bot.command("list", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const watches = await store.listActiveWatches(userId);
    if (watches.length === 0) {
      await ctx.reply("Активных наблюдений нет. Создать: /watch");
      return;
    }

    const message = watches.map(formatWatchListItem).join("\n\n");
    await ctx.reply(message, { link_preview_options: { is_disabled: true } });
  });

  bot.command("check", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const watch = await resolveWatchForCheck(store, userId, ctx.match.trim());
    if (typeof watch === "string") {
      await ctx.reply(watch);
      return;
    }

    if (watch.pendingNotification) {
      await ctx.reply(
        formatImportantChange(watch, watch.pendingNotification),
        { link_preview_options: { is_disabled: true } },
      );
      await store.markNotificationDelivered({
        telegramUserId: userId,
        watchId: watch.id,
        fingerprint: watch.pendingNotification.fingerprint,
      });
      return;
    }

    await ctx.reply(`Проверяю страницу «${watch.pageTitle ?? new URL(watch.url).hostname}»…`);
    try {
      const result = await checkService.check(watch);
      await ctx.reply(formatCheckResult(result), {
        link_preview_options: { is_disabled: true },
      });

      if (result.kind === "MATCH" && !result.duplicate) {
        await store.markNotificationDelivered({
          telegramUserId: userId,
          watchId: watch.id,
          fingerprint: result.notificationFingerprint,
        });
      }
    } catch (error) {
      if (error instanceof WatchCheckInProgressError) {
        await ctx.reply("Эта страница уже проверяется в фоне. Попробуйте ещё раз через несколько секунд.");
        return;
      }
      await ctx.reply(`Не удалось выполнить проверку: ${toSafeErrorMessage(error)}`);
    }
  });

  bot.command("stop", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const watchId = ctx.match.trim();
    if (!watchId) {
      await ctx.reply("Использование: /stop <ID>. Получить ID: /list");
      return;
    }

    const stopped = await store.stopWatch(userId, watchId);
    await ctx.reply(
      stopped ? `Наблюдение ${watchId} остановлено.` : "Активное наблюдение с таким ID не найдено.",
    );
  });

  bot.command("cancel", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const existed = pendingWatches.delete(userId);
    await ctx.reply(existed ? "Создание наблюдения отменено." : "Нет незавершённого действия.");
  });

  bot.on("message:text", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const pending = pendingWatches.get(userId);
    if (!pending) {
      await ctx.reply("Не понимаю сообщение. Используйте /watch, /list, /check или /stop.");
      return;
    }

    if (pending.step === "WAITING_URL") {
      const rawUrl = ctx.message.text.trim();
      try {
        const normalized = new URL(rawUrl).toString();
        pendingWatches.set(userId, { step: "WAITING_INSTRUCTION", url: normalized });
        await ctx.reply(
          "На что нужно обращать внимание? Опишите, о каком изменении сообщить и какие изменения можно игнорировать.",
        );
      } catch {
        await ctx.reply(
          "Не удалось распознать ссылку. Отправьте полный URL, начинающийся с http:// или https://.",
        );
      }
      return;
    }

    const instruction = normalizeInstruction(ctx.message.text);
    if (instruction.length < 8) {
      await ctx.reply("Описание слишком короткое. Уточните, о каком изменении нужно сообщить.");
      return;
    }
    if (instruction.length > 2000) {
      await ctx.reply("Описание слишком длинное. Максимум 2000 символов.");
      return;
    }

    const url = pending.url;
    if (!url) {
      pendingWatches.set(userId, { step: "WAITING_URL" });
      await ctx.reply("Ссылка потеряна. Отправьте её ещё раз.");
      return;
    }

    await ctx.reply("Проверяю страницу и настраиваю правило наблюдения…");
    try {
      // Сначала проверяем страницу, чтобы не тратить AI-запрос на недоступный URL.
      const snapshot = await pageFetcher.fetch(url);
      const policy = await semanticEvaluator.createPolicy(instruction);
      const now = new Date().toISOString();
      const watch: Watch = {
        id: shortId(),
        ownerTelegramId: userId,
        url: snapshot.finalUrl,
        instruction,
        policy,
        status: "ACTIVE",
        createdAt: now,
        stoppedAt: null,
        lastCheckedAt: snapshot.fetchedAt,
        nextCheckAt: addMinutesIso(snapshot.fetchedAt, appConfig.defaultCheckIntervalMinutes),
        lastContentHash: snapshot.hash,
        lastSnapshot: snapshot.text,
        lastNotificationFingerprint: null,
        pendingNotification: null,
        consecutiveFailures: 0,
        lastCheckError: null,
        pageTitle: snapshot.title,
      };
      await store.createWatch(watch);
      pendingWatches.delete(userId);

      await ctx.reply(
        `Наблюдение создано.\n\n` +
          `Страница: ${watch.pageTitle ?? new URL(watch.url).hostname}\n` +
          `ID: ${watch.id}\n` +
          `URL: ${watch.url}\n` +
          `Отслеживаем: ${policy.targetEvent}\n` +
          formatOptionalList("Признаки", policy.requiredSignals) +
          formatOptionalList("Игнорируем", policy.ignoredChanges) +
          `\nСледующая автоматическая проверка: ${formatDate(watch.nextCheckAt)}.` +
          `\nТекущее содержимое сохранено как исходное состояние.`,
        { link_preview_options: { is_disabled: true } },
      );
    } catch (error) {
      pendingWatches.set(userId, { step: "WAITING_INSTRUCTION", url });
      await ctx.reply(
        `Не удалось создать наблюдение: ${toSafeErrorMessage(error)}\n\n` +
          `Отправьте описание ещё раз или выполните /cancel.`,
      );
    }
  });

  bot.catch((error) => {
    console.error("Telegram bot update failed", {
      updateId: error.ctx.update.update_id,
      error: error.error instanceof Error ? error.error.message : String(error.error),
    });
  });

  return bot;
}

async function resolveWatchForCheck(
  store: JsonStore,
  userId: string,
  requestedId: string,
): Promise<Watch | string> {
  if (requestedId) {
    return (
      (await store.findActiveWatch(userId, requestedId)) ??
      "Активное наблюдение с таким ID не найдено. Посмотреть список: /list"
    );
  }

  const watches = await store.listActiveWatches(userId);
  if (watches.length === 0) {
    return "Активных наблюдений нет. Создать: /watch";
  }
  if (watches.length > 1) {
    return "У вас несколько наблюдений. Укажите нужное: /check <ID>. Получить ID: /list";
  }
  const onlyWatch = watches[0];
  if (!onlyWatch) {
    return "Активных наблюдений нет. Создать: /watch";
  }
  return onlyWatch;
}

function formatCheckResult(result: WatchCheckResult): string {
  switch (result.kind) {
    case "UNCHANGED":
      return "Страница не изменилась. AI-анализ не запускался.";
    case "NO_MATCH": {
      const header = result.evaluation.conditionMatched
        ? "Страница изменилась, но сервис не смог уверенно подтвердить нужное событие."
        : "Страница изменилась, но отслеживаемое условие не выполнено.";
      return [header, "", result.evaluation.summary].join("\n");
    }
    case "MATCH":
      return formatImportantChange(result.watch, result.evaluation, result.duplicate);
  }
}

function formatWatchListItem(watch: Watch, index: number): string {
  const details = [
    `${index + 1}. ${watch.pageTitle ?? new URL(watch.url).hostname}`,
    `ID: ${watch.id}`,
    `URL: ${watch.url}`,
    `Отслеживаем: ${truncate(watch.policy?.targetEvent ?? watch.instruction, 180)}`,
    `Проверено: ${formatDate(watch.lastCheckedAt)}`,
    `Следующая проверка: ${formatDate(watch.nextCheckAt)}`,
  ];

  if (watch.pendingNotification) {
    details.push("Уведомление ожидает доставки.");
  }
  if (watch.lastCheckError) {
    details.push(`Последняя ошибка: ${truncate(watch.lastCheckError, 160)}`);
  }
  return details.join("\n");
}

async function requireAccess(ctx: Context, accessService: AccessService): Promise<string | null> {
  const userId = getUserId(ctx);
  if (await accessService.isAllowed(userId)) {
    return userId;
  }
  await ctx.reply(unauthorizedText(userId, accessService.isActivationEnabled()));
  return null;
}

function getUserId(ctx: Context): string {
  const id = ctx.from?.id;
  if (!id) {
    throw new Error("Telegram user ID is unavailable.");
  }
  return String(id);
}

function shortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatOptionalList(title: string, values: string[]): string {
  if (values.length === 0) return "";
  return `\n${title}:\n${values.map((value) => `• ${value}`).join("\n")}\n`;
}

function toSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? truncate(error.message, 300) : "unknown error";
}

function unauthorizedText(userId: string, activationEnabled: boolean): string {
  const activation = activationEnabled
    ? "\nДля активации используйте /activate <ключ>."
    : "\nОбратитесь к владельцу сервиса.";
  return `Доступ запрещён. Ваш Telegram ID: ${userId}.${activation}`;
}

function helpText(): string {
  return [
    "Semantic Watch отслеживает значимые изменения публичных веб-страниц.",
    "Проверки выполняются автоматически; /check запускает внеплановую проверку.",
    "",
    "/watch — создать наблюдение",
    "/list — показать активные наблюдения",
    "/check [ID] — проверить страницу сейчас",
    "/stop <ID> — остановить наблюдение",
    "/cancel — отменить текущий диалог",
    "",
    "AI вызывается только при создании правила и при реальном изменении текста страницы.",
  ].join("\n");
}
