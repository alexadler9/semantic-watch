import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import {
  PolicyNotUnderstoodError,
  PolicyResponseError,
  type SemanticEvaluator,
} from "../ai/semantic-evaluator.js";
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
import { ScreenMessageRegistry } from "./screen-message-registry.js";

const MENU_ADD_PAGE = "Добавить страницу";
const MENU_TRACKED_PAGES = "Отслеживаемые страницы";
const MENU_HELP = "Помощь";

const FLOW_CANCEL = "flow:cancel";
const FLOW_BACK = "flow:back";
const FLOW_CONFIRM = "flow:confirm";
const FLOW_REFINE = "flow:refine";

interface PendingBase {
  screenMessageId: number;
}

interface WaitingUrl extends PendingBase {
  step: "WAITING_URL";
}

interface WaitingInstruction extends PendingBase {
  step: "WAITING_INSTRUCTION";
  url: string;
}

interface WaitingConfirmation extends PendingBase {
  step: "WAITING_CONFIRMATION";
  url: string;
  instruction: string;
  policy: WatchPolicy;
  snapshot: PageSnapshot;
}

type PendingWatch = WaitingUrl | WaitingInstruction | WaitingConfirmation;

type PageAction =
  | "view"
  | "check"
  | "pause"
  | "resume"
  | "delete"
  | "delete-confirm"
  | "delete-cancel";

interface NotificationAction {
  action: "pause";
  watchId: string;
}

export function createBot(
  appConfig: AppConfig,
  store: JsonStore,
  pageFetcher: SafePageFetcher,
  semanticEvaluator: SemanticEvaluator,
  checkService: WatchCheckService,
  screenMessages: ScreenMessageRegistry,
): Bot {
  const bot = new Bot(appConfig.telegramBotToken);
  const accessService = new AccessService(appConfig, store);
  const pendingWatches = new Map<string, PendingWatch>();

  bot.command("start", async (ctx) => {
    await tryDeleteIncomingMessage(ctx);
    const userId = getUserId(ctx);
    if (!(await accessService.isAllowed(userId))) {
      const message = await ctx.reply(unauthorizedText(userId, accessService.isActivationEnabled()));
      screenMessages.set(userId, message.message_id);
      return;
    }

    const message = await ctx.reply(welcomeText(), { reply_markup: mainMenuKeyboard() });
    screenMessages.set(userId, message.message_id);
  });

  bot.command("activate", async (ctx) => {
    const userId = getUserId(ctx);
    const key = ctx.match.trim();
    // Ключ не должен оставаться в истории Telegram.
    await tryDeleteIncomingMessage(ctx);

    if (await accessService.isAllowed(userId)) {
      const message = await ctx.reply("Доступ уже активирован.", {
        reply_markup: mainMenuKeyboard(),
      });
      screenMessages.set(userId, message.message_id);
      return;
    }
    if (!accessService.isActivationEnabled()) {
      const message = await ctx.reply("Активация по ключу отключена.");
      screenMessages.set(userId, message.message_id);
      return;
    }
    if (!key) {
      const message = await ctx.reply("Использование: /activate <ключ>");
      screenMessages.set(userId, message.message_id);
      return;
    }

    const activated = await accessService.activate(userId, key);
    if (!activated) {
      const message = await ctx.reply("Неверный ключ доступа.");
      screenMessages.set(userId, message.message_id);
      return;
    }

    const message = await ctx.reply("Доступ активирован. Можно добавить первую страницу.", {
      reply_markup: mainMenuKeyboard(),
    });
    screenMessages.set(userId, message.message_id);
  });

  bot.command("watch", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await tryDeleteIncomingMessage(ctx);
    await startAddPage(ctx, userId, pendingWatches, screenMessages, store, appConfig);
  });

  bot.command("list", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await tryDeleteIncomingMessage(ctx);
    pendingWatches.delete(userId);
    await showTrackedPages(ctx, userId, store, screenMessages);
  });

  bot.command("check", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await tryDeleteIncomingMessage(ctx);

    const resolved = await resolveWatchForCommandCheck(store, userId, ctx.match.trim());
    if (typeof resolved === "string") {
      await renderScreen(ctx, userId, screenMessages, resolved, mainNavigationKeyboard());
      return;
    }
    await checkPageAndRender(ctx, userId, resolved, store, checkService, screenMessages);
  });

  // Команда оставлена для совместимости. В основном интерфейсе удаление выполняется кнопкой.
  bot.command("stop", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await tryDeleteIncomingMessage(ctx);

    const watchId = ctx.match.trim();
    if (!watchId) {
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        "Откройте «Отслеживаемые страницы» и нажмите «Удалить».",
        mainNavigationKeyboard(),
      );
      return;
    }

    const deleted = await store.deleteWatch(userId, watchId);
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      deleted ? "Страница удалена из отслеживания." : "Страница не найдена.",
      mainNavigationKeyboard(),
    );
  });

  bot.command("cancel", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await tryDeleteIncomingMessage(ctx);

    const pending = pendingWatches.get(userId);
    pendingWatches.delete(userId);
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      pending ? "Настройка отменена." : "Сейчас нет незавершённой настройки.",
      mainNavigationKeyboard(),
      pending?.screenMessageId,
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    const userId = getUserId(ctx);
    if (!(await accessService.isAllowed(userId))) {
      await ctx.answerCallbackQuery({ text: "Нет доступа.", show_alert: true });
      return;
    }

    const data = ctx.callbackQuery.data;
    const notificationAction = parseNotificationAction(data);
    if (notificationAction) {
      await handleNotificationAction(ctx, userId, notificationAction, store);
      return;
    }

    const callbackMessageId = getCallbackMessageId(ctx);
    if (callbackMessageId !== null) {
      screenMessages.set(userId, callbackMessageId);
    }

    if (data === FLOW_CANCEL) {
      const pending = pendingWatches.get(userId);
      pendingWatches.delete(userId);
      await ctx.answerCallbackQuery({ text: "Настройка отменена" });
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        "Настройка отменена.",
        mainNavigationKeyboard(),
        pending?.screenMessageId ?? callbackMessageId ?? undefined,
      );
      return;
    }

    if (data === FLOW_BACK) {
      await ctx.answerCallbackQuery();
      const pending = pendingWatches.get(userId);
      if (!pending) {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          "Черновик настройки не найден. Начните заново.",
          mainNavigationKeyboard(),
          callbackMessageId ?? undefined,
        );
        return;
      }

      if (pending.step === "WAITING_CONFIRMATION") {
        const next: WaitingInstruction = {
          step: "WAITING_INSTRUCTION",
          url: pending.url,
          screenMessageId: pending.screenMessageId,
        };
        pendingWatches.set(userId, next);
        await askForInstruction(ctx, userId, screenMessages, next.screenMessageId);
        return;
      }

      if (pending.step === "WAITING_INSTRUCTION") {
        const next: WaitingUrl = {
          step: "WAITING_URL",
          screenMessageId: pending.screenMessageId,
        };
        pendingWatches.set(userId, next);
        await askForUrl(ctx, userId, screenMessages, next.screenMessageId);
        return;
      }

      await renderScreen(
        ctx,
        userId,
        screenMessages,
        "Это первый шаг настройки.",
        flowCancelKeyboard(),
        pending.screenMessageId,
      );
      return;
    }

    if (data === FLOW_REFINE) {
      await ctx.answerCallbackQuery();
      const pending = pendingWatches.get(userId);
      if (!pending || pending.step !== "WAITING_CONFIRMATION") {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          "Черновик настройки не найден. Начните заново.",
          mainNavigationKeyboard(),
          callbackMessageId ?? undefined,
        );
        return;
      }

      const next: WaitingInstruction = {
        step: "WAITING_INSTRUCTION",
        url: pending.url,
        screenMessageId: pending.screenMessageId,
      };
      pendingWatches.set(userId, next);
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        "Опишите задачу заново. Я сформирую новое правило.",
        instructionNavigationKeyboard(),
        next.screenMessageId,
      );
      return;
    }

    if (data === FLOW_CONFIRM) {
      await ctx.answerCallbackQuery({ text: "Сохраняю" });
      const pending = pendingWatches.get(userId);
      if (!pending || pending.step !== "WAITING_CONFIRMATION") {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          "Черновик настройки не найден. Начните заново.",
          mainNavigationKeyboard(),
          callbackMessageId ?? undefined,
        );
        return;
      }

      const trackedCount = await store.countTrackedWatches(userId);
      if (trackedCount >= appConfig.maxActiveWatchesPerUser) {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          `Достигнут лимит отслеживаемых страниц: ${appConfig.maxActiveWatchesPerUser}.`,
          mainNavigationKeyboard(),
          pending.screenMessageId,
        );
        return;
      }

      const watch = createWatchFromDraft(userId, pending, appConfig.defaultCheckIntervalMinutes);
      await store.createWatch(watch);
      pendingWatches.delete(userId);
      await renderPageCard(ctx, userId, watch, screenMessages, pending.screenMessageId);
      return;
    }

    if (data === "nav:add") {
      await ctx.answerCallbackQuery();
      await startAddPage(ctx, userId, pendingWatches, screenMessages, store, appConfig);
      return;
    }

    if (data === "nav:list") {
      await ctx.answerCallbackQuery();
      pendingWatches.delete(userId);
      await showTrackedPages(ctx, userId, store, screenMessages);
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
      await showTrackedPages(ctx, userId, store, screenMessages);
      return;
    }

    switch (pageAction.action) {
      case "view": {
        await ctx.answerCallbackQuery();
        await renderPageCard(ctx, userId, watch, screenMessages, callbackMessageId ?? undefined);
        return;
      }
      case "check": {
        if (watch.status !== "ACTIVE") {
          await ctx.answerCallbackQuery({ text: "Сначала возобновите отслеживание." });
          return;
        }
        await ctx.answerCallbackQuery({ text: "Проверяю" });
        await checkPageAndRender(ctx, userId, watch, store, checkService, screenMessages);
        return;
      }
      case "pause": {
        const paused = await store.pauseWatch(userId, watch.id);
        await ctx.answerCallbackQuery({
          text: paused ? "Отслеживание приостановлено" : "Уже приостановлено",
        });
        const updated = await store.findTrackedWatch(userId, watch.id);
        if (updated) {
          await renderPageCard(ctx, userId, updated, screenMessages, callbackMessageId ?? undefined);
        }
        return;
      }
      case "resume": {
        const resumed = await store.resumeWatch(userId, watch.id);
        await ctx.answerCallbackQuery({
          text: resumed ? "Отслеживание возобновлено" : "Страница уже активна",
        });
        const updated = await store.findTrackedWatch(userId, watch.id);
        if (updated) {
          await renderPageCard(ctx, userId, updated, screenMessages, callbackMessageId ?? undefined);
        }
        return;
      }
      case "delete": {
        await ctx.answerCallbackQuery();
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          `Удалить страницу «${pageTitle(watch)}» из отслеживания?`,
          deleteConfirmationKeyboard(watch.id),
          callbackMessageId ?? undefined,
        );
        return;
      }
      case "delete-cancel": {
        await ctx.answerCallbackQuery({ text: "Удаление отменено" });
        await renderPageCard(ctx, userId, watch, screenMessages, callbackMessageId ?? undefined);
        return;
      }
      case "delete-confirm": {
        const deleted = await store.deleteWatch(userId, watch.id);
        await ctx.answerCallbackQuery({ text: deleted ? "Страница удалена" : "Страница не найдена" });
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          deleted
            ? `Страница «${pageTitle(watch)}» удалена из отслеживания.`
            : "Не удалось удалить страницу.",
          mainNavigationKeyboard(),
          callbackMessageId ?? undefined,
        );
        return;
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;

    const text = ctx.message.text.trim();
    await tryDeleteIncomingMessage(ctx);

    if (text === MENU_ADD_PAGE) {
      await startAddPage(ctx, userId, pendingWatches, screenMessages, store, appConfig);
      return;
    }
    if (text === MENU_TRACKED_PAGES) {
      pendingWatches.delete(userId);
      await showTrackedPages(ctx, userId, store, screenMessages);
      return;
    }
    if (text === MENU_HELP) {
      pendingWatches.delete(userId);
      await renderScreen(ctx, userId, screenMessages, helpText(), mainNavigationKeyboard());
      return;
    }

    const pending = pendingWatches.get(userId);
    if (!pending) {
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        "Выберите действие в меню.",
        mainNavigationKeyboard(),
      );
      return;
    }

    if (pending.step === "WAITING_URL") {
      try {
        const normalized = new URL(text).toString();
        const next: WaitingInstruction = {
          step: "WAITING_INSTRUCTION",
          url: normalized,
          screenMessageId: pending.screenMessageId,
        };
        pendingWatches.set(userId, next);
        await askForInstruction(ctx, userId, screenMessages, next.screenMessageId);
      } catch {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          "Не удалось распознать ссылку. Отправьте полный URL, начинающийся с http:// или https://.",
          flowCancelKeyboard(),
          pending.screenMessageId,
        );
      }
      return;
    }

    if (pending.step === "WAITING_CONFIRMATION") {
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        formatPolicyPreview(pending.snapshot, pending.policy),
        policyConfirmationKeyboard(),
        pending.screenMessageId,
      );
      return;
    }

    const instruction = normalizeInstruction(text);
    if (instruction.length < 8) {
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        "Описание слишком короткое. Уточните, что должно появиться или произойти.",
        instructionNavigationKeyboard(),
        pending.screenMessageId,
      );
      return;
    }
    if (instruction.length > 2000) {
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        "Описание слишком длинное. Максимум 2000 символов.",
        instructionNavigationKeyboard(),
        pending.screenMessageId,
      );
      return;
    }

    await renderScreen(
      ctx,
      userId,
      screenMessages,
      "Проверяю доступность страницы…",
      undefined,
      pending.screenMessageId,
    );

    let snapshot: PageSnapshot;
    try {
      // URL проверяется до LLM-вызова, чтобы не расходовать токены на недоступную страницу.
      snapshot = await pageFetcher.fetch(pending.url);
    } catch (error) {
      pendingWatches.set(userId, pending);
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        formatPageLoadError(error),
        instructionNavigationKeyboard(),
        pending.screenMessageId,
      );
      return;
    }

    await renderScreen(
      ctx,
      userId,
      screenMessages,
      "Страница доступна. Формирую правило отслеживания…",
      undefined,
      pending.screenMessageId,
    );

    try {
      const policy = await semanticEvaluator.createPolicy(instruction);
      const next: WaitingConfirmation = {
        step: "WAITING_CONFIRMATION",
        url: pending.url,
        instruction,
        policy,
        snapshot,
        screenMessageId: pending.screenMessageId,
      };
      pendingWatches.set(userId, next);

      await renderScreen(
        ctx,
        userId,
        screenMessages,
        formatPolicyPreview(snapshot, policy),
        policyConfirmationKeyboard(),
        next.screenMessageId,
      );
    } catch (error) {
      pendingWatches.set(userId, pending);
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        formatPolicyError(error),
        instructionNavigationKeyboard(),
        pending.screenMessageId,
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
  screenMessages: ScreenMessageRegistry,
  store: JsonStore,
  appConfig: AppConfig,
): Promise<void> {
  const trackedCount = await store.countTrackedWatches(userId);
  if (trackedCount >= appConfig.maxActiveWatchesPerUser) {
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      `Достигнут лимит отслеживаемых страниц: ${appConfig.maxActiveWatchesPerUser}.`,
      mainNavigationKeyboard(),
    );
    return;
  }

  const screenMessageId = await renderScreen(
    ctx,
    userId,
    screenMessages,
    urlPromptText(),
    flowCancelKeyboard(),
  );
  pendingWatches.set(userId, { step: "WAITING_URL", screenMessageId });
}

async function askForUrl(
  ctx: Context,
  userId: string,
  screenMessages: ScreenMessageRegistry,
  screenMessageId: number,
): Promise<void> {
  await renderScreen(
    ctx,
    userId,
    screenMessages,
    urlPromptText(),
    flowCancelKeyboard(),
    screenMessageId,
  );
}

async function askForInstruction(
  ctx: Context,
  userId: string,
  screenMessages: ScreenMessageRegistry,
  screenMessageId: number,
): Promise<void> {
  await renderScreen(
    ctx,
    userId,
    screenMessages,
    instructionPromptText(),
    instructionNavigationKeyboard(),
    screenMessageId,
  );
}

async function showTrackedPages(
  ctx: Context,
  userId: string,
  store: JsonStore,
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  const watches = await store.listTrackedWatches(userId);
  if (watches.length === 0) {
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      "Сейчас ничего не отслеживается.",
      new InlineKeyboard().text("Добавить страницу", "nav:add"),
    );
    return;
  }

  const lines = ["Отслеживаемые страницы", ""];
  watches.forEach((watch, index) => {
    const status = watch.status === "ACTIVE" ? "отслеживается" : "приостановлено";
    lines.push(`${index + 1}. ${pageTitle(watch)}`, `   ${status}`, "");
  });

  await renderScreen(
    ctx,
    userId,
    screenMessages,
    lines.join("\n").trim(),
    trackedPagesKeyboard(watches),
  );
}

async function renderPageCard(
  ctx: Context,
  userId: string,
  watch: Watch,
  screenMessages: ScreenMessageRegistry,
  preferredMessageId?: number,
): Promise<void> {
  await renderScreen(
    ctx,
    userId,
    screenMessages,
    formatPageCard(watch),
    pageCardKeyboard(watch),
    preferredMessageId,
  );
}

async function checkPageAndRender(
  ctx: Context,
  userId: string,
  watch: Watch,
  store: JsonStore,
  checkService: WatchCheckService,
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  const screenMessageId = await renderScreen(
    ctx,
    userId,
    screenMessages,
    `Проверяю страницу «${pageTitle(watch)}»…`,
  );

  if (watch.pendingNotification) {
    await sendPermanentNotification(
      ctx,
      userId,
      watch,
      watch.pendingNotification,
      screenMessages,
    );
    await store.markNotificationDelivered({
      telegramUserId: userId,
      watchId: watch.id,
      fingerprint: watch.pendingNotification.fingerprint,
    });
    return;
  }

  try {
    const result = await checkService.check(watch);
    const updatedWatch = (await store.findTrackedWatch(userId, watch.id)) ?? result.watch;

    if (result.kind === "MATCH" && !result.duplicate) {
      await sendPermanentNotification(
        ctx,
        userId,
        updatedWatch,
        result.evaluation,
        screenMessages,
      );
      await store.markNotificationDelivered({
        telegramUserId: userId,
        watchId: watch.id,
        fingerprint: result.notificationFingerprint,
      });
      return;
    }

    await renderScreen(
      ctx,
      userId,
      screenMessages,
      [formatCheckResult(result), "", "────────", "", formatPageCard(updatedWatch)].join("\n"),
      pageCardKeyboard(updatedWatch),
      screenMessageId,
    );
  } catch (error) {
    const message =
      error instanceof WatchCheckInProgressError
        ? "Эта страница уже проверяется в фоне. Попробуйте ещё раз через несколько секунд."
        : `Не удалось выполнить проверку: ${toSafeErrorMessage(error)}`;
    const updatedWatch = (await store.findTrackedWatch(userId, watch.id)) ?? watch;
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      [message, "", formatPageCard(updatedWatch)].join("\n"),
      pageCardKeyboard(updatedWatch),
      screenMessageId,
    );
  }
}

async function sendPermanentNotification(
  ctx: Context,
  userId: string,
  watch: Watch,
  evaluation: {
    summary: string;
    evidence: string[];
  },
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    throw new Error("Telegram chat ID is unavailable.");
  }

  const transientScreenId = screenMessages.get(userId);
  if (transientScreenId !== undefined) {
    try {
      await ctx.api.deleteMessage(chatId, transientScreenId);
    } catch {
      // Экран мог быть уже удалён. Постоянное уведомление всё равно нужно доставить.
    } finally {
      screenMessages.delete(userId);
    }
  }

  await ctx.api.sendMessage(chatId, formatImportantChange(watch, evaluation), {
    link_preview_options: { is_disabled: true },
    reply_markup: importantNotificationKeyboard(watch),
  });
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
    return "Откройте «Отслеживаемые страницы» и выберите нужную страницу.";
  }
  return watches[0] ?? "Сейчас нет активных страниц для проверки.";
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
        ? "Сервис не смог уверенно подтвердить, что нужная информация уже появилась."
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

function mainNavigationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Добавить страницу", "nav:add")
    .row()
    .text("Отслеживаемые страницы", "nav:list");
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

function trackedPagesKeyboard(watches: Watch[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const watch of watches) {
    const status = watch.status === "ACTIVE" ? "Активна" : "Пауза";
    keyboard.text(`${status}: ${truncate(pageTitle(watch), 32)}`, `page:view:${watch.id}`).row();
  }
  return keyboard.text("Добавить страницу", "nav:add");
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
  return keyboard
    .url("Открыть страницу", watch.url)
    .row()
    .text("К списку", "nav:list");
}

function deleteConfirmationKeyboard(watchId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Да, удалить", `page:delete-confirm:${watchId}`)
    .text("Отмена", `page:delete-cancel:${watchId}`);
}

function parseNotificationAction(data: string): NotificationAction | null {
  const match = /^notification:(pause):([a-z0-9]+)$/.exec(data);
  if (!match) return null;
  const action = match[1];
  const watchId = match[2];
  if (action !== "pause" || !watchId) return null;
  return { action, watchId };
}

async function handleNotificationAction(
  ctx: Context,
  userId: string,
  notificationAction: NotificationAction,
  store: JsonStore,
): Promise<void> {
  const watch = await store.findTrackedWatch(userId, notificationAction.watchId);
  if (!watch) {
    await ctx.answerCallbackQuery({ text: "Страница не найдена.", show_alert: true });
    return;
  }

  const paused = await store.pauseWatch(userId, watch.id);
  await ctx.answerCallbackQuery({
    text: paused ? "Отслеживание приостановлено" : "Уже приостановлено",
  });

  const chatId = ctx.chat?.id;
  const messageId = getCallbackMessageId(ctx);
  if (chatId === undefined || messageId === null) return;

  try {
    await ctx.api.editMessageReplyMarkup(chatId, messageId, {
      reply_markup: new InlineKeyboard().url("Открыть страницу", watch.url),
    });
  } catch {
    // Уведомление остаётся постоянным, даже если Telegram не смог обновить кнопки.
  }
}

function parsePageAction(data: string): { action: PageAction; watchId: string } | null {
  const match = /^page:(view|check|pause|resume|delete|delete-confirm|delete-cancel):([a-z0-9]+)$/.exec(data);
  if (!match) return null;
  const action = match[1];
  const watchId = match[2];
  if (!action || !watchId) return null;
  return { action: action as PageAction, watchId };
}

async function renderScreen(
  ctx: Context,
  userId: string,
  screenMessages: ScreenMessageRegistry,
  text: string,
  keyboard?: InlineKeyboard,
  preferredMessageId?: number,
): Promise<number> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    throw new Error("Telegram chat ID is unavailable.");
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  const messageId = preferredMessageId ?? callbackMessageId ?? screenMessages.get(userId);
  const options = {
    ...(keyboard ? { reply_markup: keyboard } : {}),
    link_preview_options: { is_disabled: true },
  };

  if (messageId !== undefined) {
    const separatedByPermanentMessage =
      screenMessages.isSeparatedByPermanentMessage(userId, messageId);

    if (separatedByPermanentMessage) {
      try {
        await ctx.api.deleteMessage(chatId, messageId);
      } catch {
        // Старый UI-экран мог быть уже удалён пользователем или Telegram.
      } finally {
        screenMessages.delete(userId);
      }
    } else {
      try {
        await ctx.api.editMessageText(chatId, messageId, text, options);
        screenMessages.set(userId, messageId);
        return messageId;
      } catch (error) {
        if (isMessageNotModifiedError(error)) {
          screenMessages.set(userId, messageId);
          return messageId;
        }
        // Старое сообщение могло быть удалено или стать недоступным для редактирования.
      }
    }
  }

  const message = await ctx.reply(text, options);
  screenMessages.set(userId, message.message_id);
  return message.message_id;
}

async function tryDeleteIncomingMessage(ctx: Context): Promise<void> {
  if (!ctx.message) return;
  try {
    await ctx.deleteMessage();
  } catch {
    // Удаление — только UX-оптимизация. Ошибка не должна ломать основной сценарий.
  }
}

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

function isMessageNotModifiedError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("message is not modified");
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

function formatPolicyError(error: unknown): string {
  if (error instanceof PolicyNotUnderstoodError) {
    return [
      "Не удалось понять, что именно нужно отслеживать.",
      "",
      "Опишите задачу немного подробнее.",
      "",
      "Например: «Сообщи, когда откроется регистрация. Обновления программы и состава спикеров не учитывать».",
    ].join("\n");
  }
  if (error instanceof PolicyResponseError) {
    return [
      "Не удалось сформировать понятное правило.",
      "",
      "Попробуйте переформулировать, что именно должно появиться или произойти на странице.",
    ].join("\n");
  }
  return [
    "Сервис временно не смог сформировать правило.",
    "",
    "Попробуйте ещё раз чуть позже или измените описание.",
  ].join("\n");
}

function formatPageLoadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (raw.includes("HTTP 403")) {
    return "Сайт запретил автоматическую загрузку страницы (HTTP 403). Попробуйте другую публичную страницу.";
  }
  if (raw.includes("timed out")) {
    return "Страница не ответила вовремя. Попробуйте ещё раз или отправьте другую ссылку.";
  }
  if (raw.includes("private or non-routable")) {
    return "Этот адрес ведёт в локальную или закрытую сеть и не может быть проверен.";
  }
  if (raw.includes("Unsupported content type")) {
    return "По ссылке нет поддерживаемой текстовой HTML-страницы.";
  }
  return "Не удалось загрузить страницу. Проверьте ссылку и попробуйте ещё раз.";
}

function toSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? truncate(error.message, 300) : "неизвестная ошибка";
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

function urlPromptText(): string {
  return "Отправьте ссылку на публичную страницу. Поддерживаются HTTP/HTTPS-страницы без авторизации.";
}

function instructionPromptText(): string {
  return [
    "На что нужно обращать внимание?",
    "",
    "Опишите, что должно появиться или произойти на странице, а что можно не учитывать.",
    "",
    "Например: «Сообщи, когда откроется регистрация. Обновления программы и состава спикеров не учитывать».",
  ].join("\n");
}
