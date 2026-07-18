import { randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import type { AppConfig } from "../config/config.js";
import type { Watch } from "../domain/models.js";
import { SafePageFetcher } from "../fetcher/safe-page-fetcher.js";
import { JsonStore } from "../storage/json-store.js";
import { normalizeInstruction, truncate } from "../utils/text.js";
import { AccessService } from "./access-service.js";

interface PendingWatch {
  step: "WAITING_URL" | "WAITING_INSTRUCTION";
  url?: string;
}

export function createBot(
  appConfig: AppConfig,
  store: JsonStore,
  pageFetcher: SafePageFetcher,
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

    const message = watches
      .map(
        (watch, index) =>
          `${index + 1}. ${watch.pageTitle ?? new URL(watch.url).hostname}\n` +
          `ID: ${watch.id}\n` +
          `URL: ${watch.url}\n` +
          `Условие: ${truncate(watch.instruction, 180)}\n` +
          `Создано: ${formatDate(watch.createdAt)}`,
      )
      .join("\n\n");
    await ctx.reply(message);
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
    await ctx.reply(stopped ? `Наблюдение ${watchId} остановлено.` : "Активное наблюдение с таким ID не найдено.");
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
      await ctx.reply("Не понимаю сообщение. Используйте /watch, /list или /stop.");
      return;
    }

    if (pending.step === "WAITING_URL") {
      const rawUrl = ctx.message.text.trim();
      try {
        const normalized = new URL(rawUrl).toString();
        pendingWatches.set(userId, { step: "WAITING_INSTRUCTION", url: normalized });
        await ctx.reply(
          "Что именно нужно отслеживать? Опишите событие обычным языком и при необходимости укажите, какие изменения следует игнорировать.",
        );
      } catch {
        await ctx.reply("Не удалось распознать ссылку. Отправьте полный URL, начинающийся с http:// или https://.");
      }
      return;
    }

    const instruction = normalizeInstruction(ctx.message.text);
    if (instruction.length < 8) {
      await ctx.reply("Условие слишком короткое. Опишите, о каком изменении нужно сообщить.");
      return;
    }
    if (instruction.length > 2000) {
      await ctx.reply("Условие слишком длинное. Максимум 2000 символов.");
      return;
    }

    const url = pending.url;
    if (!url) {
      pendingWatches.set(userId, { step: "WAITING_URL" });
      await ctx.reply("Ссылка потеряна. Отправьте её ещё раз.");
      return;
    }

    await ctx.reply("Проверяю страницу и сохраняю исходное состояние…");
    try {
      const snapshot = await pageFetcher.fetch(url);
      const now = new Date().toISOString();
      const watch: Watch = {
        id: shortId(),
        ownerTelegramId: userId,
        url: snapshot.finalUrl,
        instruction,
        status: "ACTIVE",
        createdAt: now,
        stoppedAt: null,
        lastCheckedAt: snapshot.fetchedAt,
        lastContentHash: snapshot.hash,
        lastSnapshot: snapshot.text,
        pageTitle: snapshot.title,
      };
      await store.createWatch(watch);
      pendingWatches.delete(userId);

      await ctx.reply(
        `Наблюдение создано.\n\n` +
          `Страница: ${watch.pageTitle ?? new URL(watch.url).hostname}\n` +
          `ID: ${watch.id}\n` +
          `URL: ${watch.url}\n` +
          `Условие: ${watch.instruction}\n\n` +
          `Текущее содержимое сохранено как исходное состояние.`,
      );
    } catch (error) {
      pendingWatches.set(userId, { step: "WAITING_URL" });
      await ctx.reply(
        `Не удалось загрузить страницу: ${toSafeErrorMessage(error)}\n\nОтправьте другую ссылку или /cancel.`,
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

function toSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? truncate(error.message, 240) : "unknown error";
}

function unauthorizedText(userId: string, activationEnabled: boolean): string {
  const activation = activationEnabled
    ? "\nДля активации используйте /activate <ключ>."
    : "\nОбратитесь к владельцу сервиса.";
  return `Доступ запрещён. Ваш Telegram ID: ${userId}.${activation}`;
}

function helpText(): string {
  return [
    "Semantic Watch отслеживает содержимое публичных веб-страниц.",
    "",
    "/watch — создать наблюдение",
    "/list — показать активные наблюдения",
    "/stop <ID> — остановить наблюдение",
    "/cancel — отменить текущий диалог",
    "",
    "На первом этапе сервис сохраняет исходное состояние страницы. Семантическая проверка изменений появится на следующем этапе.",
  ].join("\n");
}
