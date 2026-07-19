import { dirname, join, resolve } from "node:path";
import { DeepSeekClient } from "./ai/deepseek-client.js";
import { SemanticEvaluator } from "./ai/semantic-evaluator.js";
import { BrowserRuntime } from "./browser/browser-runtime.js";
import { createBot } from "./bot/create-bot.js";
import { ScreenMessageRegistry } from "./bot/screen-message-registry.js";
import { WatchCheckService } from "./checker/watch-check-service.js";
import { config } from "./config/config.js";
import { BrowserPageFetcher } from "./fetcher/browser-page-fetcher.js";
import { UrlSafetyGuard } from "./fetcher/url-safety.js";
import { WatchScheduler } from "./scheduler/watch-scheduler.js";
import { JsonStore } from "./storage/json-store.js";
import { VisualEvidenceService } from "./visual/visual-evidence-service.js";

async function main(): Promise<void> {
  const store = new JsonStore(config.dataFile);
  await store.initialize();

  const urlSafety = new UrlSafetyGuard({
    demoMode: config.demoMode,
    demoUrl: config.demoUrl,
  });
  const browserRuntime = new BrowserRuntime(urlSafety, {
    timeoutMs: config.fetchTimeoutMs,
  });
  const pageFetcher = new BrowserPageFetcher(browserRuntime, urlSafety, {
    timeoutMs: config.fetchTimeoutMs,
    maxPageTextChars: config.maxPageTextChars,
    screenshotEnabled: config.resultScreenshotEnabled,
  });
  const visualEvidence = new VisualEvidenceService({
    screenshotEnabled: config.resultScreenshotEnabled,
    cacheDir: join(dirname(resolve(config.dataFile)), "visual-cache"),
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
  const checkService = new WatchCheckService(store, pageFetcher, semanticEvaluator, visualEvidence, {
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
    visualEvidence,
  );
  const scheduler = new WatchScheduler(
    bot.api,
    store,
    checkService,
    {
      tickSeconds: config.schedulerTickSeconds,
      errorRetryMinutes: config.errorRetryMinutes,
      notificationRetryMinutes: config.notificationRetryMinutes,
      maxChecksPerTick: config.maxChecksPerTick,
      maxNotificationAttempts: config.maxNotificationAttempts,
    },
    screenMessages,
    visualEvidence,
  );

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
    void Promise.allSettled([bot.stop(), browserRuntime.close()]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Shutdown step failed:", result.reason);
        }
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log("Semantic Watch bot started (long polling).", {
    resultScreenshots: config.resultScreenshotEnabled,
  });
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
