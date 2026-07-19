import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import {
  PolicyNotUnderstoodError,
  PolicyResponseError,
  type FeedbackReason,
  type PolicyPreparation,
  type SemanticEvaluator,
} from "../ai/semantic-evaluator.js";
import {
  WatchCheckInProgressError,
  type WatchCheckResult,
  type WatchCheckService,
} from "../checker/watch-check-service.js";
import type { AppConfig } from "../config/config.js";
import type {
  DeliveredResult,
  PageSnapshot,
  PendingNotification,
  Watch,
  WatchPolicy,
} from "../domain/models.js";
import { SafePageFetcher } from "../fetcher/safe-page-fetcher.js";
import {
  formatImportantChange,
  importantNotificationKeyboard,
  resolvedNotificationKeyboard,
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
const POLICY_CLARIFY_CUSTOM = "policy:clarify-custom";

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

interface WaitingClarification extends PendingBase {
  step: "WAITING_CLARIFICATION";
  url: string;
  instruction: string;
  snapshot: PageSnapshot;
  question: string;
  options: string[];
}

interface WaitingClarificationText extends PendingBase {
  step: "WAITING_CLARIFICATION_TEXT";
  url: string;
  instruction: string;
  snapshot: PageSnapshot;
  question: string;
  options: string[];
}

interface WaitingConfirmation extends PendingBase {
  step: "WAITING_CONFIRMATION";
  url: string;
  instruction: string;
  policy: WatchPolicy;
  currentState: string;
  snapshot: PageSnapshot;
}

type PendingWatch =
  | WaitingUrl
  | WaitingInstruction
  | WaitingClarification
  | WaitingClarificationText
  | WaitingConfirmation;

interface FeedbackBase {
  watchId: string;
  resultId: string;
  notificationMessageId: number;
  screenMessageId: number;
}

interface WaitingFeedbackReason extends FeedbackBase {
  step: "WAITING_FEEDBACK_REASON";
  reasons: FeedbackReason[];
}

interface WaitingFeedbackText extends FeedbackBase {
  step: "WAITING_FEEDBACK_TEXT";
}

interface WaitingFeedbackConfirmation extends FeedbackBase {
  step: "WAITING_FEEDBACK_CONFIRMATION";
  reason: string;
  proposedPolicy: WatchPolicy;
  explanation: string;
}

type PendingFeedback =
  | WaitingFeedbackReason
  | WaitingFeedbackText
  | WaitingFeedbackConfirmation;

type PageAction =
  | "view"
  | "check"
  | "pause"
  | "resume"
  | "delete"
  | "delete-confirm"
  | "delete-cancel";

type NotificationAction =
  | { action: "pause"; watchId: string }
  | { action: "accept" | "reject"; watchId: string; resultId: string };

type FeedbackAction =
  | { action: "reason"; resultId: string; index: number }
  | { action: "custom" | "save" | "edit" | "cancel"; resultId: string };

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
  const pendingFeedback = new Map<string, PendingFeedback>();

  bot.command("start", async (ctx) => {
    await tryDeleteIncomingMessage(ctx);
    const userId = getUserId(ctx);
    pendingWatches.delete(userId);
    pendingFeedback.delete(userId);

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
    pendingFeedback.delete(userId);
    await startAddPage(ctx, userId, pendingWatches, screenMessages, store, appConfig);
  });

  bot.command("list", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await tryDeleteIncomingMessage(ctx);
    pendingWatches.delete(userId);
    pendingFeedback.delete(userId);
    await showTrackedPages(ctx, userId, store, screenMessages);
  });

  bot.command("check", async (ctx) => {
    const userId = await requireAccess(ctx, accessService);
    if (!userId) return;
    await tryDeleteIncomingMessage(ctx);
    pendingWatches.delete(userId);
    pendingFeedback.delete(userId);

    const resolved = await resolveWatchForCommandCheck(store, userId, ctx.match.trim());
    if (typeof resolved === "string") {
      await renderScreen(ctx, userId, screenMessages, resolved, mainNavigationKeyboard());
      return;
    }
    await checkPageAndRender(ctx, userId, resolved, store, checkService, screenMessages);
  });

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

    const watchDraft = pendingWatches.get(userId);
    const feedbackDraft = pendingFeedback.get(userId);
    pendingWatches.delete(userId);
    pendingFeedback.delete(userId);
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      watchDraft || feedbackDraft ? "Настройка отменена." : "Сейчас нет незавершённой настройки.",
      mainNavigationKeyboard(),
      watchDraft?.screenMessageId ?? feedbackDraft?.screenMessageId,
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
      await handleNotificationAction(
        ctx,
        userId,
        notificationAction,
        store,
        semanticEvaluator,
        pendingFeedback,
        screenMessages,
      );
      return;
    }

    const callbackMessageId = getCallbackMessageId(ctx);
    if (callbackMessageId !== null) {
      screenMessages.set(userId, callbackMessageId);
    }

    const feedbackAction = parseFeedbackAction(data);
    if (feedbackAction) {
      await handleFeedbackAction(
        ctx,
        userId,
        feedbackAction,
        store,
        semanticEvaluator,
        pendingFeedback,
        screenMessages,
      );
      return;
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

      if (pending.step === "WAITING_CONFIRMATION" || pending.step === "WAITING_CLARIFICATION") {
        const next: WaitingInstruction = {
          step: "WAITING_INSTRUCTION",
          url: pending.url,
          screenMessageId: pending.screenMessageId,
        };
        pendingWatches.set(userId, next);
        await askForInstruction(ctx, userId, screenMessages, next.screenMessageId);
        return;
      }

      if (pending.step === "WAITING_CLARIFICATION_TEXT") {
        const next: WaitingClarification = {
          step: "WAITING_CLARIFICATION",
          url: pending.url,
          instruction: pending.instruction,
          snapshot: pending.snapshot,
          question: pending.question,
          options: pending.options,
          screenMessageId: pending.screenMessageId,
        };
        pendingWatches.set(userId, next);
        await renderPolicyClarification(ctx, userId, screenMessages, next);
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

    const clarificationIndex = parsePolicyClarificationIndex(data);
    if (clarificationIndex !== null) {
      await ctx.answerCallbackQuery({ text: "Уточняю правило" });
      const pending = pendingWatches.get(userId);
      if (!pending || pending.step !== "WAITING_CLARIFICATION") {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          "Уточнение устарело. Начните настройку заново.",
          mainNavigationKeyboard(),
          callbackMessageId ?? undefined,
        );
        return;
      }
      const selected = pending.options[clarificationIndex];
      if (!selected) {
        await ctx.answerCallbackQuery({ text: "Вариант устарел." });
        return;
      }
      await preparePolicyFromInstruction(
        ctx,
        userId,
        pending,
        `${pending.instruction}\nУточнение пользователя: ${selected}`,
        semanticEvaluator,
        pendingWatches,
        screenMessages,
      );
      return;
    }

    if (data === POLICY_CLARIFY_CUSTOM) {
      await ctx.answerCallbackQuery();
      const pending = pendingWatches.get(userId);
      if (!pending || pending.step !== "WAITING_CLARIFICATION") {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          "Уточнение устарело. Начните настройку заново.",
          mainNavigationKeyboard(),
          callbackMessageId ?? undefined,
        );
        return;
      }
      const next: WaitingClarificationText = {
        ...pending,
        step: "WAITING_CLARIFICATION_TEXT",
      };
      pendingWatches.set(userId, next);
      await renderScreen(
        ctx,
        userId,
        screenMessages,
        "Напишите уточнение своими словами.",
        instructionNavigationKeyboard(),
        next.screenMessageId,
      );
      return;
    }

    if (data === "nav:add") {
      await ctx.answerCallbackQuery();
      pendingFeedback.delete(userId);
      await startAddPage(ctx, userId, pendingWatches, screenMessages, store, appConfig);
      return;
    }

    if (data === "nav:list") {
      await ctx.answerCallbackQuery();
      pendingWatches.delete(userId);
      pendingFeedback.delete(userId);
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
      case "view":
        await ctx.answerCallbackQuery();
        await renderPageCard(ctx, userId, watch, screenMessages, callbackMessageId ?? undefined);
        return;
      case "check":
        if (watch.status !== "ACTIVE") {
          await ctx.answerCallbackQuery({ text: "Сначала возобновите отслеживание." });
          return;
        }
        await ctx.answerCallbackQuery({ text: "Проверяю" });
        await checkPageAndRender(ctx, userId, watch, store, checkService, screenMessages);
        return;
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
      case "delete":
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
      case "delete-cancel":
        await ctx.answerCallbackQuery({ text: "Удаление отменено" });
        await renderPageCard(ctx, userId, watch, screenMessages, callbackMessageId ?? undefined);
        return;
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
      pendingFeedback.delete(userId);
      await startAddPage(ctx, userId, pendingWatches, screenMessages, store, appConfig);
      return;
    }
    if (text === MENU_TRACKED_PAGES) {
      pendingWatches.delete(userId);
      pendingFeedback.delete(userId);
      await showTrackedPages(ctx, userId, store, screenMessages);
      return;
    }
    if (text === MENU_HELP) {
      pendingWatches.delete(userId);
      pendingFeedback.delete(userId);
      await renderScreen(ctx, userId, screenMessages, helpText(), mainNavigationKeyboard());
      return;
    }

    const feedbackDraft = pendingFeedback.get(userId);
    if (feedbackDraft?.step === "WAITING_FEEDBACK_TEXT") {
      const clarification = normalizeInstruction(text);
      if (clarification.length < 5 || clarification.length > 1000) {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          "Опишите причину чуть подробнее, но не длиннее 1000 символов.",
          feedbackTextKeyboard(feedbackDraft.resultId),
          feedbackDraft.screenMessageId,
        );
        return;
      }
      await prepareRefinedPolicy(
        ctx,
        userId,
        feedbackDraft,
        clarification,
        store,
        semanticEvaluator,
        pendingFeedback,
        screenMessages,
      );
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
        formatPolicyPreview(pending.snapshot, pending.policy, pending.currentState),
        policyConfirmationKeyboard(),
        pending.screenMessageId,
      );
      return;
    }

    if (pending.step === "WAITING_CLARIFICATION") {
      await renderPolicyClarification(ctx, userId, screenMessages, pending);
      return;
    }

    if (pending.step === "WAITING_CLARIFICATION_TEXT") {
      const clarification = normalizeInstruction(text);
      if (clarification.length < 5 || clarification.length > 1000) {
        await renderScreen(
          ctx,
          userId,
          screenMessages,
          "Уточнение должно содержать от 5 до 1000 символов.",
          instructionNavigationKeyboard(),
          pending.screenMessageId,
        );
        return;
      }
      await preparePolicyFromInstruction(
        ctx,
        userId,
        pending,
        `${pending.instruction}\nУточнение пользователя: ${clarification}`,
        semanticEvaluator,
        pendingWatches,
        screenMessages,
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

    const base = {
      url: pending.url,
      instruction,
      snapshot,
      screenMessageId: pending.screenMessageId,
    };
    await preparePolicyFromInstruction(
      ctx,
      userId,
      base,
      instruction,
      semanticEvaluator,
      pendingWatches,
      screenMessages,
    );
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

async function preparePolicyFromInstruction(
  ctx: Context,
  userId: string,
  base: {
    url: string;
    instruction: string;
    snapshot: PageSnapshot;
    screenMessageId: number;
  },
  effectiveInstruction: string,
  semanticEvaluator: SemanticEvaluator,
  pendingWatches: Map<string, PendingWatch>,
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  await renderScreen(
    ctx,
    userId,
    screenMessages,
    "Страница доступна. Формирую правило отслеживания…",
    undefined,
    base.screenMessageId,
  );

  try {
    const preparation = await semanticEvaluator.preparePolicy({
      instruction: effectiveInstruction,
      pageText: base.snapshot.text,
    });
    await applyPolicyPreparation(
      ctx,
      userId,
      base,
      effectiveInstruction,
      preparation,
      pendingWatches,
      screenMessages,
    );
  } catch (error) {
    const next: WaitingInstruction = {
      step: "WAITING_INSTRUCTION",
      url: base.url,
      screenMessageId: base.screenMessageId,
    };
    pendingWatches.set(userId, next);
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      formatPolicyError(error),
      instructionNavigationKeyboard(),
      base.screenMessageId,
    );
  }
}

async function applyPolicyPreparation(
  ctx: Context,
  userId: string,
  base: {
    url: string;
    instruction: string;
    snapshot: PageSnapshot;
    screenMessageId: number;
  },
  effectiveInstruction: string,
  preparation: PolicyPreparation,
  pendingWatches: Map<string, PendingWatch>,
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  if (preparation.kind === "NEEDS_CLARIFICATION") {
    const next: WaitingClarification = {
      step: "WAITING_CLARIFICATION",
      url: base.url,
      instruction: effectiveInstruction,
      snapshot: base.snapshot,
      question: preparation.question,
      options: preparation.options,
      screenMessageId: base.screenMessageId,
    };
    pendingWatches.set(userId, next);
    await renderPolicyClarification(ctx, userId, screenMessages, next);
    return;
  }

  const next: WaitingConfirmation = {
    step: "WAITING_CONFIRMATION",
    url: base.url,
    instruction: effectiveInstruction,
    policy: preparation.policy,
    currentState: preparation.currentState,
    snapshot: base.snapshot,
    screenMessageId: base.screenMessageId,
  };
  pendingWatches.set(userId, next);
  await renderScreen(
    ctx,
    userId,
    screenMessages,
    formatPolicyPreview(next.snapshot, next.policy, next.currentState),
    policyConfirmationKeyboard(),
    next.screenMessageId,
  );
}

async function renderPolicyClarification(
  ctx: Context,
  userId: string,
  screenMessages: ScreenMessageRegistry,
  pending: WaitingClarification,
): Promise<void> {
  await renderScreen(
    ctx,
    userId,
    screenMessages,
    ["Нужно небольшое уточнение.", "", pending.question].join("\n"),
    policyClarificationKeyboard(pending.options),
    pending.screenMessageId,
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
    await sendPermanentNotification(ctx, userId, watch, watch.pendingNotification, screenMessages);
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

    if (result.kind === "MATCH" && !result.duplicate && updatedWatch.pendingNotification) {
      await sendPermanentNotification(
        ctx,
        userId,
        updatedWatch,
        updatedWatch.pendingNotification,
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
  notification: PendingNotification,
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error("Telegram chat ID is unavailable.");

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

  await ctx.api.sendMessage(chatId, formatImportantChange(watch, notification), {
    link_preview_options: { is_disabled: true },
    reply_markup: importantNotificationKeyboard(watch, notification),
  });
}

async function handleNotificationAction(
  ctx: Context,
  userId: string,
  action: NotificationAction,
  store: JsonStore,
  semanticEvaluator: SemanticEvaluator,
  pendingFeedback: Map<string, PendingFeedback>,
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  const watch = await store.findTrackedWatch(userId, action.watchId);
  if (!watch) {
    await ctx.answerCallbackQuery({ text: "Страница не найдена.", show_alert: true });
    return;
  }

  if (action.action === "pause") {
    const paused = await store.pauseWatch(userId, watch.id);
    await ctx.answerCallbackQuery({
      text: paused ? "Отслеживание приостановлено" : "Уже приостановлено",
    });
    await editNotificationKeyboard(ctx, { ...watch, status: paused ? "PAUSED" : watch.status });
    return;
  }

  const result = watch.lastDeliveredResult;
  if (!result || result.id !== action.resultId) {
    await ctx.answerCallbackQuery({ text: "Этот результат уже устарел.", show_alert: true });
    return;
  }

  if (action.action === "accept") {
    const confirmed = await store.confirmDeliveredResult({
      telegramUserId: userId,
      watchId: watch.id,
      resultId: result.id,
    });
    await ctx.answerCallbackQuery({
      text: confirmed ? "Спасибо, правило сработало верно" : "Ответ уже сохранён",
    });
    await editNotificationKeyboard(ctx, watch);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Готовлю варианты уточнения" });
  let reasons: FeedbackReason[];
  try {
    reasons = await semanticEvaluator.suggestFeedbackReasons({
      instruction: watch.instruction,
      policy: watch.policy ?? fallbackPolicy(watch),
      summary: result.summary,
      evidence: result.evidence,
    });
  } catch {
    reasons = fallbackFeedbackReasons();
  }

  const screenMessageId = await sendNewScreenBelowNotification(
    ctx,
    userId,
    screenMessages,
    "Почему этот результат не подходит?",
    feedbackReasonsKeyboard(result.id, reasons),
  );
  const notificationMessageId = getCallbackMessageId(ctx);
  if (notificationMessageId === null) return;
  pendingFeedback.set(userId, {
    step: "WAITING_FEEDBACK_REASON",
    watchId: watch.id,
    resultId: result.id,
    notificationMessageId,
    screenMessageId,
    reasons,
  });
}

async function handleFeedbackAction(
  ctx: Context,
  userId: string,
  action: FeedbackAction,
  store: JsonStore,
  semanticEvaluator: SemanticEvaluator,
  pendingFeedback: Map<string, PendingFeedback>,
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  const pending = pendingFeedback.get(userId);
  if (!pending || pending.resultId !== action.resultId) {
    await ctx.answerCallbackQuery({ text: "Черновик уточнения устарел.", show_alert: true });
    return;
  }

  if (action.action === "cancel") {
    pendingFeedback.delete(userId);
    await ctx.answerCallbackQuery({ text: "Правило не изменено" });
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      "Уточнение отменено. Исходное правило осталось без изменений.",
      mainNavigationKeyboard(),
      pending.screenMessageId,
    );
    return;
  }

  if (action.action === "custom" || action.action === "edit") {
    await ctx.answerCallbackQuery();
    const next: WaitingFeedbackText = {
      step: "WAITING_FEEDBACK_TEXT",
      watchId: pending.watchId,
      resultId: pending.resultId,
      notificationMessageId: pending.notificationMessageId,
      screenMessageId: pending.screenMessageId,
    };
    pendingFeedback.set(userId, next);
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      "Объясните своими словами, почему результат не подходит и что нужно учитывать дальше.",
      feedbackTextKeyboard(pending.resultId),
      pending.screenMessageId,
    );
    return;
  }

  if (action.action === "reason") {
    if (pending.step !== "WAITING_FEEDBACK_REASON") {
      await ctx.answerCallbackQuery({ text: "Выберите причину заново." });
      return;
    }
    const reason = pending.reasons[action.index];
    if (!reason) {
      await ctx.answerCallbackQuery({ text: "Вариант устарел." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Уточняю правило" });
    await prepareRefinedPolicy(
      ctx,
      userId,
      pending,
      reason.clarification,
      store,
      semanticEvaluator,
      pendingFeedback,
      screenMessages,
    );
    return;
  }

  if (pending.step !== "WAITING_FEEDBACK_CONFIRMATION") {
    await ctx.answerCallbackQuery({ text: "Сначала подготовьте новое правило." });
    return;
  }

  const saved = await store.applyRefinedPolicy({
    telegramUserId: userId,
    watchId: pending.watchId,
    resultId: pending.resultId,
    policy: pending.proposedPolicy,
    reason: pending.reason,
  });
  await ctx.answerCallbackQuery({
    text: saved ? "Новое правило сохранено" : "Не удалось сохранить правило",
  });
  if (!saved) return;

  pendingFeedback.delete(userId);
  const watch = await store.findTrackedWatch(userId, pending.watchId);
  if (watch) {
    await editMessageKeyboardById(ctx, pending.notificationMessageId, resolvedNotificationKeyboard(watch));
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      ["Правило обновлено.", "", pending.explanation, "", formatPageCard(watch)].join("\n"),
      pageCardKeyboard(watch),
      pending.screenMessageId,
    );
  }
}

async function prepareRefinedPolicy(
  ctx: Context,
  userId: string,
  pending: FeedbackBase,
  reason: string,
  store: JsonStore,
  semanticEvaluator: SemanticEvaluator,
  pendingFeedback: Map<string, PendingFeedback>,
  screenMessages: ScreenMessageRegistry,
): Promise<void> {
  const watch = await store.findTrackedWatch(userId, pending.watchId);
  const result = watch?.lastDeliveredResult;
  if (!watch || !watch.policy || !result || result.id !== pending.resultId) {
    pendingFeedback.delete(userId);
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      "Результат уже устарел. Правило не изменено.",
      mainNavigationKeyboard(),
      pending.screenMessageId,
    );
    return;
  }

  await renderScreen(
    ctx,
    userId,
    screenMessages,
    "Уточняю правило по вашему ответу…",
    undefined,
    pending.screenMessageId,
  );

  try {
    const refined = await semanticEvaluator.refinePolicy({
      instruction: watch.instruction,
      currentPolicy: watch.policy,
      resultSummary: result.summary,
      evidence: result.evidence,
      userClarification: reason,
    });
    const next: WaitingFeedbackConfirmation = {
      step: "WAITING_FEEDBACK_CONFIRMATION",
      watchId: watch.id,
      resultId: result.id,
      notificationMessageId: pending.notificationMessageId,
      screenMessageId: pending.screenMessageId,
      reason,
      proposedPolicy: refined.policy,
      explanation: refined.explanation,
    };
    pendingFeedback.set(userId, next);
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      formatRefinedPolicyPreview(refined.policy, refined.explanation),
      feedbackConfirmationKeyboard(result.id),
      next.screenMessageId,
    );
  } catch {
    const next: WaitingFeedbackText = {
      step: "WAITING_FEEDBACK_TEXT",
      watchId: watch.id,
      resultId: result.id,
      notificationMessageId: pending.notificationMessageId,
      screenMessageId: pending.screenMessageId,
    };
    pendingFeedback.set(userId, next);
    await renderScreen(
      ctx,
      userId,
      screenMessages,
      "Не удалось подготовить новое правило. Попробуйте сформулировать уточнение другими словами.",
      feedbackTextKeyboard(result.id),
      next.screenMessageId,
    );
  }
}

async function editNotificationKeyboard(ctx: Context, watch: Watch): Promise<void> {
  const messageId = getCallbackMessageId(ctx);
  if (messageId === null) return;
  await editMessageKeyboardById(ctx, messageId, resolvedNotificationKeyboard(watch));
}

async function editMessageKeyboardById(
  ctx: Context,
  messageId: number,
  keyboard: InlineKeyboard,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  try {
    await ctx.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
  } catch {
    // Исходное уведомление остаётся в истории, даже если Telegram не обновил кнопки.
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
  if (watches.length === 0) return "Сейчас нет активных страниц для проверки.";
  if (watches.length > 1) return "Откройте «Отслеживаемые страницы» и выберите нужную страницу.";
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
    policyVersion: 1,
    policyHistory: [
      {
        version: 1,
        policy: draft.policy,
        reason: "Исходное правило подтверждено пользователем.",
        createdAt: now,
      },
    ],
    semanticState: {
      summary: draft.currentState,
      updatedAt: draft.snapshot.fetchedAt,
    },
    status: "ACTIVE",
    createdAt: now,
    stoppedAt: null,
    lastCheckedAt: draft.snapshot.fetchedAt,
    nextCheckAt: addMinutesIso(draft.snapshot.fetchedAt, checkIntervalMinutes),
    lastContentHash: draft.snapshot.hash,
    lastSnapshot: draft.snapshot.text,
    lastNotificationFingerprint: null,
    pendingNotification: null,
    lastDeliveredResult: null,
    consecutiveFailures: 0,
    lastCheckError: null,
    pageTitle: draft.snapshot.title,
  };
}

function formatPolicyPreview(snapshot: PageSnapshot, policy: WatchPolicy, currentState: string): string {
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
    "Сейчас на странице:",
    currentState,
    "",
    "Всё верно?",
  ].join("\n");
}

function formatRefinedPolicyPreview(policy: WatchPolicy, explanation: string): string {
  return [
    "Я уточнил правило:",
    "",
    explanation,
    "",
    "Что отслеживаем:",
    policy.targetEvent,
    ...formatListBlock("На что обращать внимание:", policy.requiredSignals),
    ...formatListBlock("Что не учитывать:", policy.ignoredChanges),
    "",
    "Сохранить новую версию?",
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
  ];

  if (watch.semanticState) {
    lines.push("", "Сейчас на странице:", truncate(watch.semanticState.summary, 300));
  }
  lines.push("", `Версия правила: ${Math.max(1, watch.policyVersion)}`);
  lines.push(`Последняя проверка: ${formatDate(watch.lastCheckedAt)}`);

  if (watch.status === "ACTIVE") lines.push(`Следующая проверка: ${formatDate(watch.nextCheckAt)}`);
  if (watch.pendingNotification) lines.push("Найденный результат ожидает доставки.");
  if (watch.lastCheckError) lines.push(`Последняя ошибка: ${truncate(watch.lastCheckError, 160)}`);
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

function policyClarificationKeyboard(options: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  options.forEach((option, index) => {
    keyboard.text(truncate(option, 45), `policy:clarify:${index}`).row();
  });
  return keyboard
    .text("Написать свой вариант", POLICY_CLARIFY_CUSTOM)
    .row()
    .text("Назад", FLOW_BACK)
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

function feedbackReasonsKeyboard(resultId: string, reasons: FeedbackReason[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  reasons.forEach((reason, index) => {
    keyboard.text(truncate(reason.label, 45), `feedback:reason:${resultId}:${index}`).row();
  });
  return keyboard
    .text("Другая причина", `feedback:custom:${resultId}`)
    .row()
    .text("Отмена", `feedback:cancel:${resultId}`);
}

function feedbackTextKeyboard(resultId: string): InlineKeyboard {
  return new InlineKeyboard().text("Отмена", `feedback:cancel:${resultId}`);
}

function feedbackConfirmationKeyboard(resultId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Сохранить правило", `feedback:save:${resultId}`)
    .row()
    .text("Уточнить вручную", `feedback:edit:${resultId}`)
    .text("Отмена", `feedback:cancel:${resultId}`);
}

function parseNotificationAction(data: string): NotificationAction | null {
  const pause = /^notification:pause:([a-z0-9]+)$/.exec(data);
  if (pause?.[1]) return { action: "pause", watchId: pause[1] };

  const feedback = /^notification:(accept|reject):([a-z0-9]+):([a-z0-9]+)$/.exec(data);
  if (!feedback?.[1] || !feedback[2] || !feedback[3]) return null;
  return {
    action: feedback[1] as "accept" | "reject",
    watchId: feedback[2],
    resultId: feedback[3],
  };
}

function parseFeedbackAction(data: string): FeedbackAction | null {
  const reason = /^feedback:reason:([a-z0-9]+):(\d+)$/.exec(data);
  if (reason?.[1] && reason[2]) {
    return { action: "reason", resultId: reason[1], index: Number(reason[2]) };
  }
  const simple = /^feedback:(custom|save|edit|cancel):([a-z0-9]+)$/.exec(data);
  if (!simple?.[1] || !simple[2]) return null;
  return { action: simple[1] as "custom" | "save" | "edit" | "cancel", resultId: simple[2] };
}

function parsePolicyClarificationIndex(data: string): number | null {
  const match = /^policy:clarify:(\d+)$/.exec(data);
  return match?.[1] ? Number(match[1]) : null;
}

function parsePageAction(data: string): { action: PageAction; watchId: string } | null {
  const match = /^page:(view|check|pause|resume|delete|delete-confirm|delete-cancel):([a-z0-9]+)$/.exec(data);
  if (!match?.[1] || !match[2]) return null;
  return { action: match[1] as PageAction, watchId: match[2] };
}

async function sendNewScreenBelowNotification(
  ctx: Context,
  userId: string,
  screenMessages: ScreenMessageRegistry,
  text: string,
  keyboard: InlineKeyboard,
): Promise<number> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error("Telegram chat ID is unavailable.");

  const previousScreenId = screenMessages.get(userId);
  if (previousScreenId !== undefined) {
    try {
      await ctx.api.deleteMessage(chatId, previousScreenId);
    } catch {
      // Старый служебный экран мог быть уже удалён.
    } finally {
      screenMessages.delete(userId);
    }
  }

  const message = await ctx.reply(text, {
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
  screenMessages.set(userId, message.message_id);
  return message.message_id;
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
  if (chatId === undefined) throw new Error("Telegram chat ID is unavailable.");

  const callbackMessageId = getCallbackMessageId(ctx);
  const messageId = preferredMessageId ?? callbackMessageId ?? screenMessages.get(userId);
  const options = {
    ...(keyboard ? { reply_markup: keyboard } : {}),
    link_preview_options: { is_disabled: true },
  };

  if (messageId !== undefined) {
    const separated = screenMessages.isSeparatedByPermanentMessage(userId, messageId);
    if (separated) {
      try {
        await ctx.api.deleteMessage(chatId, messageId);
      } catch {
        // Старый экран мог быть удалён пользователем.
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
    // Удаление — только UX-оптимизация.
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
  if (await accessService.isAllowed(userId)) return userId;
  await ctx.reply(unauthorizedText(userId, accessService.isActivationEnabled()));
  return null;
}

function getUserId(ctx: Context): string {
  const id = ctx.from?.id;
  if (!id) throw new Error("Telegram user ID is unavailable.");
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
    ].join("\n");
  }
  if (error instanceof PolicyResponseError) {
    return [
      "Не удалось сформировать понятное правило.",
      "",
      "Попробуйте переформулировать задачу.",
    ].join("\n");
  }
  return "Сервис временно не смог сформировать правило. Попробуйте ещё раз чуть позже.";
}

function formatPageLoadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (raw.includes("HTTP 403")) return "Сайт запретил автоматическую загрузку страницы (HTTP 403).";
  if (raw.includes("timed out")) return "Страница не ответила вовремя. Попробуйте ещё раз.";
  if (raw.includes("private or non-routable")) return "Этот адрес ведёт в локальную или закрытую сеть.";
  if (raw.includes("Unsupported content type")) return "По ссылке нет поддерживаемой текстовой HTML-страницы.";
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
    "Добавьте страницу, опишите цель, и сервис будет проверять её автоматически.",
  ].join("\n");
}

function helpText(): string {
  return [
    "Как пользоваться Semantic Watch:",
    "",
    "1. Нажмите «Добавить страницу».",
    "2. Отправьте URL.",
    "3. Опишите, что нужно найти.",
    "4. Ответьте на уточняющий вопрос, если задача неоднозначна.",
    "5. Проверьте правило и подтвердите его.",
    "",
    "После найденного результата можно подтвердить его или нажать «Не подходит». AI предложит уточнение правила, но сохранит его только после вашего подтверждения.",
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

function fallbackFeedbackReasons(): FeedbackReason[] {
  return [
    { label: "Не та аудитория", clarification: "Информация относится не к той аудитории, которая мне нужна." },
    { label: "Событие ещё не произошло", clarification: "Сообщать только когда действие действительно станет доступно, а не будет только анонсировано." },
    { label: "Такие результаты неинтересны", clarification: "Исключить результаты такого типа из дальнейшего отслеживания." },
  ];
}

function fallbackPolicy(watch: Watch): WatchPolicy {
  return {
    targetEvent: watch.instruction,
    requiredSignals: [watch.instruction],
    ignoredChanges: [],
  };
}
