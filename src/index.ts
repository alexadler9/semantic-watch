import { DeepSeekClient } from "./ai/deepseek-client.js";
import { SemanticEvaluator } from "./ai/semantic-evaluator.js";
import { createBot } from "./bot/create-bot.js";
import { ScreenMessageRegistry } from "./bot/screen-message-registry.js";
import { WatchCheckService } from "./checker/watch-check-service.js";
import { config } from "./config/config.js";
import { SafePageFetcher } from "./fetcher/safe-page-fetcher.js";
import { WatchScheduler } from "./scheduler/watch-scheduler.js";
import { JsonStore } from "./storage/json-store.js";

async function main(): Promise<void> {
  const store = new JsonStore(config.dataFile);
  await store.initialize();

  const pageFetcher = new SafePageFetcher({
    timeoutMs: config.fetchTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxPageTextChars: config.maxPageTextChars,
    demoMode: config.demoMode,
    demoUrl: config.demoUrl,
  });

  const deepSeekClient = new DeepSeekClient({
    apiKey: config.deepSeekApiKey,
    baseUrl: config.deepSeekBaseUrl,
    model: config.deepSeekModel,
    timeoutMs: config.deepSeekTimeoutMs,
  });
  const semanticEvaluator = new SemanticEvaluator(deepSeekClient, store, {
    maxLlmCallsPerDay: config.maxLlmCallsPerDay,
  });
  const checkService = new WatchCheckService(store, pageFetcher, semanticEvaluator, {
    maxDiffChars: config.maxDiffChars,
    matchConfidenceThreshold: config.matchConfidenceThreshold,
    checkIntervalMinutes: config.defaultCheckIntervalMinutes,
  });

  const screenMessages = new ScreenMessageRegistry();
  const bot = createBot(
    config,
    store,
    pageFetcher,
    semanticEvaluator,
    checkService,
    screenMessages,
  );
  const scheduler = new WatchScheduler(bot.api, store, checkService, {
    tickSeconds: config.schedulerTickSeconds,
    errorRetryMinutes: config.errorRetryMinutes,
    notificationRetryMinutes: config.notificationRetryMinutes,
    maxChecksPerTick: config.maxChecksPerTick,
    maxNotificationAttempts: config.maxNotificationAttempts,
  }, screenMessages);

  await bot.api.setMyCommands([
    { command: "start", description: "Открыть главное меню" },
    { command: "watch", description: "Добавить страницу" },
    { command: "list", description: "Показать отслеживаемые страницы" },
    { command: "check", description: "Проверить активную страницу сейчас" },
    { command: "cancel", description: "Отменить текущую настройку" },
  ]);

  if (config.schedulerEnabled) {
    scheduler.start();
  } else {
    console.log("Watch scheduler is disabled by configuration.");
  }

  const shutdown = (): void => {
    scheduler.stop();
    void bot.stop().catch((error) => {
      console.error("Telegram bot shutdown failed:", error);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log("Semantic Watch bot started (long polling).");
  await bot.start({
    onStart: (botInfo) => {
      console.log(`Telegram bot @${botInfo.username} is ready.`);
    },
  });
}

main().catch((error) => {
  console.error("Semantic Watch failed to start:", error);
  process.exit(1);
});
