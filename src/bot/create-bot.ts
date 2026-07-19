import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import type { SemanticEvaluator } from "../ai/semantic-evaluator.js";
import {
  WatchCheckInProgressError,
  type WatchCheckResult,
  type WatchCheckService,
} from "../checker/watch-check-service.js";
import type { AppConfig } from "../config/config.js";
import type { PageSnapshot, Watch, WatchPolicy } from "../domain/models.js";
import { SafePageFetcher } from "../fetcher/safe-page-fetcher.js";
import {
  formatImportantChange,
  importantNotificationKeyboard,
} from "../notifications/telegram-messages.js";
import { JsonStore } from "../storage/json-store.js";
import { normalizeInstruction, truncate } from "../utils/text.js";
import { addMinutesIso } from "../utils/time.js";
import { AccessService } from "./access-service.js";

const MENU_ADD_PAGE = "Добавить страницу";
const MENU_TRACKED_PAGES = "Отслеживаемые страницы";
const MENU_HELP = "Помощь";

const FLOW_CANCEL = "flow:cancel";
const FLOW_BACK = "flow:back";
const FLOW_CONFIRM = "flow:confirm";
const FLOW_REFINE = "flow:refine";

interface WaitingUrl {
  step: "WAITING_URL";
}

interface WaitingInstruction {
  step: "WAITING_INSTRUCTION";
  url: string;
}

interface WaitingConfirmation {
  step: "WAITING_CONFIRMATION";
  url: string;
  instruction: string;
  policy: WatchPolicy;
  snapshot: PageSnapshot;
}

type PendingWatch = WaitingUrl | WaitingInstruction | WaitingConfirmation;

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
      await ctx.reply(welcomeText(), { reply_markup: mainMenuKeyboard() });
      return;
    }
    await ctx.reply(unauthorizedText(userId, accessService.isActivationEnabled()));
  });

  bot.command("activate", async (ctx) => {
    const userId = getUserId(ctx);
    if (await accessService.isAllowed(userId)) {
      await ctx.reply("Доступ уже активирован.", { reply_markup: mainMenuKeyboard() });
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
    if (!activated) {
      await ctx.reply("Неверный ключ доступа.");
      return;
    }

    await ctx.reply("Доступ активирован. Можно добавить первую страницу.", {
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.command("watch", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await startAddPage(ctx, userId, pendingWatches, store, appConfig);
  });

  bot.command("list", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await showTrackedPages(ctx, userId, store);
  });

  bot.command("check", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const resolved = await resolveWatchForCommandCheck(store, userId, ctx.match.trim());
    if (typeof resolved === "string") {
      await ctx.reply(resolved, { reply_markup: mainMenuKeyboard() });
      return;
    }
    await checkPageAndReply(ctx, userId, resolved, store, checkService);
  });

  // Команда оставлена для совместимости. В основном интерфейсе удаление выполняется кнопкой.
  bot.command("stop", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const watchId = ctx.match.trim();
    if (!watchId) {
      await ctx.reply("Откройте «Отслеживаемые страницы» и нажмите «Удалить».", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    const deleted = await store.deleteWatch(userId, watchId);
    await ctx.reply(
      deleted ? "Страница удалена из отслеживания." : "Страница не найдена.",
      { reply_markup: mainMenuKeyboard() },
    );
  });

  bot.command("cancel", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const existed = pendingWatches.delete(userId);
    await ctx.reply(existed ? "Настройка отменена." : "Сейчас нет незавершённой настройки.", {
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    const userId = getUserId(ctx);
    if (!(await accessService.isAllowed(userId))) {
      await ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
      return;
    }

    const data = ctx.callbackQuery.data;

    if (data === FLOW_CANCEL) {
      pendingWatches.delete(userId);
      await ctx.answerCallbackQuery({ text: "Настройка отменена" });
      await removeInlineKeyboard(ctx);
      await ctx.reply("Настройка страницы отменена.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (data === FLOW_BACK) {
      await ctx.answerCallbackQuery();
      await removeInlineKeyboard(ctx);
      const pending = pendingWatches.get(userId);
      if (!pending) {
        await ctx.reply("Черновик настройки не найден. Начните заново.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }

      if (pending.step === "WAITING_CONFIRMATION") {
        pendingWatches.set(userId, { step: "WAITING_INSTRUCTION", url: pending.url });
        await askForInstruction(ctx);
        return;
      }

      if (pending.step === "WAITING_INSTRUCTION") {
        pendingWatches.set(userId, { step: "WAITING_URL" });
        await askForUrl(ctx);
        return;
      }

      await ctx.reply("Это первый шаг настройки.", { reply_markup: flowCancelKeyboard() });
      return;
    }

    if (data === FLOW_REFINE) {
      await ctx.answerCallbackQuery();
      await removeInlineKeyboard(ctx);
      const pending = pendingWatches.get(userId);
      if (!pending || pending.step !== "WAITING_CONFIRMATION") {
        await ctx.reply("Черновик настройки не найден. Начните заново.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }
      pendingWatches.set(userId, { step: "WAITING_INSTRUCTION", url: pending.url });
      await ctx.reply("Опишите задачу заново. Я сформирую новое правило.", {
        reply_markup: instructionNavigationKeyboard(),
      });
      return;
    }

    if (data === FLOW_CONFIRM) {
      await ctx.answerCallbackQuery({ text: "Сохраняю" });
      const pending = pendingWatches.get(userId);
      if (!pending || pending.step !== "WAITING_CONFIRMATION") {
        await removeInlineKeyboard(ctx);
        await ctx.reply("Черновик настройки не найден. Начните заново.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }

      const trackedCount = await store.countTrackedWatches(userId);
      if (trackedCount >= appConfig.maxActiveWatchesPerUser) {
        await ctx.reply(
          `Достигнут лимит отслеживаемых страниц: ${appConfig.maxActiveWatchesPerUser}.`,
          { reply_markup: mainMenuKeyboard() },
        );
        return;
      }

      const watch = createWatchFromDraft(userId, pending, appConfig.defaultCheckIntervalMinutes);
      await store.createWatch(watch);
      pendingWatches.delete(userId);
      await removeInlineKeyboard(ctx);
      await ctx.reply("Отслеживание настроено.", { reply_markup: mainMenuKeyboard() });
      await sendPageCard(ctx, watch);
      return;
    }

    if (data === "nav:add") {
      await ctx.answerCallbackQuery();
      await startAddPage(ctx, userId, pendingWatches, store, appConfig);
      return;
    }

    if (data === "nav:list") {
      await ctx.answerCallbackQuery();
      await showTrackedPages(ctx, userId, store);
      return;
    }

    const pageAction = parsePageAction(data);
    if (!pageAction) {
      await ctx.answerCallbackQuery({ text: "Кнопка устарела." });
      return;
    }

    const watch = await store.findTrackedWatch(userId, pageAction.watchId);
    if (!watch) {
      await ctx.answerCallbackQuery({ text: "Страница не найдена.", show_alert: true });
      await removeInlineKeyboard(ctx);
      return;
    }

    switch (pageAction.action) {
      case "check": {
        if (watch.status !== "ACTIVE") {
          await ctx.answerCallbackQuery({ text: "Сначала возобновите отслеживание." });
          return;
        }
        await ctx.answerCallbackQuery({ text: "Проверяю" });
        await checkPageAndReply(ctx, userId, watch, store, checkService);
        return;
      }
      case "pause": {
        const paused = await store.pauseWatch(userId, watch.id);
        await ctx.answerCallbackQuery({
          text: paused ? "Отслеживание приостановлено" : "Уже приостановлено",
        });
        await removeInlineKeyboard(ctx);
        const updated = await store.findTrackedWatch(userId, watch.id);
        if (updated) await sendPageCard(ctx, updated);
        return;
      }
      case "resume": {
        const resumed = await store.resumeWatch(userId, watch.id);
        await ctx.answerCallbackQuery({
          text: resumed ? "Отслеживание возобновлено" : "Страница уже активна",
        });
        await removeInlineKeyboard(ctx);
        const updated = await store.findTrackedWatch(userId, watch.id);
        if (updated) await sendPageCard(ctx, updated);
        return;
      }
      case "delete": {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: deleteConfirmationKeyboard(watch.id) });
        return;
      }
      case "delete-cancel": {
        await ctx.answerCallbackQuery({ text: "Удаление отменено" });
        await ctx.editMessageReplyMarkup({ reply_markup: pageCardKeyboard(watch) });
        return;
      }
      case "delete-confirm": {
        const deleted = await store.deleteWatch(userId, watch.id);
        await ctx.answerCallbackQuery({ text: deleted ? "Страница удалена" : "Страница не найдена" });
        await ctx.editMessageText(
          deleted
            ? `Страница «${pageTitle(watch)}» удалена из отслеживания.`
            : "Не удалось удалить страницу.",
          { reply_markup: new InlineKeyboard().text("К списку страниц", "nav:list") },
        );
        return;
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const text = ctx.message.text.trim();
    if (text === MENU_ADD_PAGE) {
      await startAddPage(ctx, userId, pendingWatches, store, appConfig);
      return;
    }
    if (text === MENU_TRACKED_PAGES) {
      pendingWatches.delete(userId);
      await showTrackedPages(ctx, userId, store);
      return;
    }
    if (text === MENU_HELP) {
      await ctx.reply(helpText(), { reply_markup: mainMenuKeyboard() });
      return;
    }

    const pending = pendingWatches.get(userId);
    if (!pending) {
      await ctx.reply("Выберите действие в меню.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (pending.step === "WAITING_URL") {
      try {
        const normalized = new URL(text).toString();
        pendingWatches.set(userId, { step: "WAITING_INSTRUCTION", url: normalized });
        await askForInstruction(ctx);
      } catch {
        await ctx.reply(
          "Не удалось распознать ссылку. Отправьте полный URL, начинающийся с http:// или https://.",
          { reply_markup: flowCancelKeyboard() },
        );
      }
      return;
    }

    if (pending.step === "WAITING_CONFIRMATION") {
      await ctx.reply("Подтвердите правило кнопкой или выберите «Уточнить».", {
        reply_markup: policyConfirmationKeyboard(),
      });
      return;
    }

    const instruction = normalizeInstruction(text);
    if (instruction.length < 8) {
      await ctx.reply("Описание слишком короткое. Уточните, что должно появиться или произойти.", {
        reply_markup: instructionNavigationKeyboard(),
      });
      return;
    }
    if (instruction.length > 2000) {
      await ctx.reply("Описание слишком длинное. Максимум 2000 символов.", {
        reply_markup: instructionNavigationKeyboard(),
      });
      return;
    }

    await ctx.reply("Анализирую страницу и формирую правило отслеживания…");
    try {
      // Сначала проверяем URL, чтобы не расходовать AI-запрос на недоступную страницу.
      const snapshot = await pageFetcher.fetch(pending.url);
      const policy = await semanticEvaluator.createPolicy(instruction);
      pendingWatches.set(userId, {
        step: "WAITING_CONFIRMATION",
        url: pending.url,
        instruction,
        policy,
        snapshot,
      });

      await ctx.reply(formatPolicyPreview(snapshot, policy), {
        reply_markup: policyConfirmationKeyboard(),
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      pendingWatches.set(userId, pending);
      await ctx.reply(
        `Не удалось подготовить правило: ${toSafeErrorMessage(error)}\n\n` +
          "Попробуйте отправить описание ещё раз или отмените настройку.",
        { reply_markup: instructionNavigationKeyboard() },
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

async function startAddPage(
  ctx: Context,
  userId: string,
  pendingWatches: Map<string, PendingWatch>,
  store: JsonStore,
  appConfig: AppConfig,
): Promise<void> {
  const trackedCount = await store.countTrackedWatches(userId);
  if (trackedCount >= appConfig.maxActiveWatchesPerUser) {
    await ctx.reply(
      `Достигнут лимит отслеживаемых страниц: ${appConfig.maxActiveWatchesPerUser}.`,
      { reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  pendingWatches.set(userId, { step: "WAITING_URL" });
  await askForUrl(ctx);
}

async function askForUrl(ctx: Context): Promise<void> {
  await ctx.reply(
    "Отправьте ссылку на публичную страницу. Поддерживаются HTTP/HTTPS-страницы без авторизации.",
    { reply_markup: flowCancelKeyboard() },
  );
}

async function askForInstruction(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "На что нужно обращать внимание?",
      "",
      "Опишите, что должно появиться или произойти на странице, а что можно не учитывать.",
      "",
      "Например: «Сообщи, когда откроется регистрация. Обновления программы и состава спикеров не учитывать».",
    ].join("\n"),
    { reply_markup: instructionNavigationKeyboard() },
  );
}

async function showTrackedPages(ctx: Context, userId: string, store: JsonStore): Promise<void> {
  const watches = await store.listTrackedWatches(userId);
  if (watches.length === 0) {
    await ctx.reply("Сейчас ничего не отслеживается.", {
      reply_markup: new InlineKeyboard().text("Добавить страницу", "nav:add"),
    });
    return;
  }

  await ctx.reply(`Отслеживаемые страницы: ${watches.length}`, {
    reply_markup: mainMenuKeyboard(),
  });
  for (const watch of watches) {
    await sendPageCard(ctx, watch);
  }
}

async function sendPageCard(ctx: Context, watch: Watch): Promise<void> {
  await ctx.reply(formatPageCard(watch), {
    reply_markup: pageCardKeyboard(watch),
    link_preview_options: { is_disabled: true },
  });
}

async function checkPageAndReply(
  ctx: Context,
  userId: string,
  watch: Watch,
  store: JsonStore,
  checkService: WatchCheckService,
): Promise<void> {
  if (watch.pendingNotification) {
    await ctx.reply(formatImportantChange(watch, watch.pendingNotification), {
      reply_markup: importantNotificationKeyboard(watch),
      link_preview_options: { is_disabled: true },
    });
    await store.markNotificationDelivered({
      telegramUserId: userId,
      watchId: watch.id,
      fingerprint: watch.pendingNotification.fingerprint,
    });
    return;
  }

  await ctx.reply(`Проверяю страницу «${pageTitle(watch)}»…`);
  try {
    const result = await checkService.check(watch);
    const options =
      result.kind === "MATCH"
        ? {
            reply_markup: importantNotificationKeyboard(result.watch),
            link_preview_options: { is_disabled: true },
          }
        : { link_preview_options: { is_disabled: true } };
    await ctx.reply(formatCheckResult(result), options);

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
}

async function resolveWatchForCommandCheck(
  store: JsonStore,
  userId: string,
  requestedId: string,
): Promise<Watch | string> {
  if (requestedId) {
    return (
      (await store.findActiveWatch(userId, requestedId)) ??
      "Активная страница с таким идентификатором не найдена."
    );
  }

  const watches = await store.listActiveWatches(userId);
  if (watches.length === 0) {
    return "Сейчас нет активных страниц для проверки.";
  }
  if (watches.length > 1) {
    return "Откройте «Отслеживаемые страницы» и нажмите «Проверить сейчас» на нужной карточке.";
  }
  const onlyWatch = watches[0];
  return onlyWatch ?? "Сейчас нет активных страниц для проверки.";
}

function createWatchFromDraft(
  userId: string,
  draft: WaitingConfirmation,
  checkIntervalMinutes: number,
): Watch {
  const now = new Date().toISOString();
  return {
    id: shortId(),
    ownerTelegramId: userId,
    url: draft.snapshot.finalUrl,
    instruction: draft.instruction,
    policy: draft.policy,
    status: "ACTIVE",
    createdAt: now,
    stoppedAt: null,
    lastCheckedAt: draft.snapshot.fetchedAt,
    nextCheckAt: addMinutesIso(draft.snapshot.fetchedAt, checkIntervalMinutes),
    lastContentHash: draft.snapshot.hash,
    lastSnapshot: draft.snapshot.text,
    lastNotificationFingerprint: null,
    pendingNotification: null,
    consecutiveFailures: 0,
    lastCheckError: null,
    pageTitle: draft.snapshot.title,
  };
}

function formatPolicyPreview(snapshot: PageSnapshot, policy: WatchPolicy): string {
  return [
    "Я понял задачу так:",
    "",
    `Страница: ${snapshot.title ?? new URL(snapshot.finalUrl).hostname}`,
    "",
    "Что отслеживаем:",
    policy.targetEvent,
    ...formatListBlock("На что обращать внимание:", policy.requiredSignals),
    ...formatListBlock("Что не учитывать:", policy.ignoredChanges),
    "",
    "Всё верно?",
  ].join("\n");
}

function formatPageCard(watch: Watch): string {
  const status = watch.status === "ACTIVE" ? "отслеживается" : "приостановлено";
  const lines = [
    pageTitle(watch),
    "",
    `Статус: ${status}`,
    "",
    "Что отслеживаем:",
    truncate(watch.policy?.targetEvent ?? watch.instruction, 260),
    "",
    `Последняя проверка: ${formatDate(watch.lastCheckedAt)}`,
  ];

  if (watch.status === "ACTIVE") {
    lines.push(`Следующая проверка: ${formatDate(watch.nextCheckAt)}`);
  }
  if (watch.pendingNotification) {
    lines.push("Найденный результат ожидает доставки.");
  }
  if (watch.lastCheckError) {
    lines.push(`Последняя ошибка: ${truncate(watch.lastCheckError, 160)}`);
  }
  return lines.join("\n");
}

function formatCheckResult(result: WatchCheckResult): string {
  switch (result.kind) {
    case "UNCHANGED":
      return "Страница не обновилась. AI-анализ не запускался.";
    case "NO_MATCH": {
      const header = result.evaluation.conditionMatched
        ? "Сервис не смог достаточно уверенно подтвердить, что нужная информация уже появилась."
        : "Страница обновилась, но нужная информация не появилась.";
      return [header, "", result.evaluation.summary].join("\n");
    }
    case "MATCH":
      return formatImportantChange(result.watch, result.evaluation, result.duplicate);
  }
}

function mainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text(MENU_ADD_PAGE)
    .row()
    .text(MENU_TRACKED_PAGES)
    .text(MENU_HELP)
    .resized()
    .persistent();
}

function flowCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Отмена", FLOW_CANCEL);
}

function instructionNavigationKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Назад", FLOW_BACK).text("Отмена", FLOW_CANCEL);
}

function policyConfirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Всё верно", FLOW_CONFIRM)
    .row()
    .text("Уточнить", FLOW_REFINE)
    .text("Назад", FLOW_BACK)
    .row()
    .text("Отмена", FLOW_CANCEL);
}

function pageCardKeyboard(watch: Watch): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (watch.status === "ACTIVE") {
    keyboard.text("Проверить сейчас", `page:check:${watch.id}`).row();
    keyboard
      .text("Приостановить", `page:pause:${watch.id}`)
      .text("Удалить", `page:delete:${watch.id}`)
      .row();
  } else {
    keyboard
      .text("Возобновить", `page:resume:${watch.id}`)
      .text("Удалить", `page:delete:${watch.id}`)
      .row();
  }
  return keyboard.url("Открыть страницу", watch.url);
}

function deleteConfirmationKeyboard(watchId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Да, удалить", `page:delete-confirm:${watchId}`)
    .text("Отмена", `page:delete-cancel:${watchId}`);
}

function parsePageAction(
  data: string,
): { action: "check" | "pause" | "resume" | "delete" | "delete-confirm" | "delete-cancel"; watchId: string } | null {
  const match = /^page:(check|pause|resume|delete|delete-confirm|delete-cancel):([a-z0-9]+)$/.exec(data);
  if (!match) return null;
  const action = match[1];
  const watchId = match[2];
  if (!action || !watchId) return null;
  return {
    action: action as "check" | "pause" | "resume" | "delete" | "delete-confirm" | "delete-cancel",
    watchId,
  };
}

async function removeInlineKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  } catch {
    // Сообщение могло быть удалено или уже отредактировано. Основной сценарий продолжается.
  }
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

function pageTitle(watch: Pick<Watch, "pageTitle" | "url">): string {
  return watch.pageTitle ?? new URL(watch.url).hostname;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatListBlock(title: string, values: string[]): string[] {
  if (values.length === 0) return [];
  return ["", title, ...values.map((value) => `• ${value}`)];
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

function welcomeText(): string {
  return [
    "Semantic Watch следит за нужной информацией на публичных веб-страницах.",
    "",
    "Добавьте страницу, опишите, что должно на ней появиться, и сервис будет проверять её автоматически.",
  ].join("\n");
}

function helpText(): string {
  return [
    "Как пользоваться Semantic Watch:",
    "",
    "1. Нажмите «Добавить страницу».",
    "2. Отправьте URL.",
    "3. Опишите, что должно появиться или произойти.",
    "4. Проверьте правило, которое сформировал AI, и подтвердите его.",
    "",
    "В карточке страницы можно запустить проверку вручную, приостановить отслеживание или удалить страницу.",
    "AI вызывается только при настройке правила и после реального обновления текста страницы.",
  ].join("\n");
}
