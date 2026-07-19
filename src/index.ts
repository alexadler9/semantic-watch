import { DeepSeekClient } from "./ai/deepseek-client.js";
import { SemanticEvaluator } from "./ai/semantic-evaluator.js";
import { createBot } from "./bot/create-bot.js";
import { WatchCheckService } from "./checker/watch-check-service.js";
import { config } from "./config/config.js";
import { SafePageFetcher } from "./fetcher/safe-page-fetcher.js";
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
  });

  const bot = createBot(config, store, pageFetcher, semanticEvaluator, checkService);

  await bot.api.setMyCommands([
    { command: "start", description: "Описание сервиса" },
    { command: "watch", description: "Создать наблюдение" },
    { command: "list", description: "Активные наблюдения" },
    { command: "check", description: "Проверить страницу сейчас" },
    { command: "stop", description: "Остановить наблюдение по ID" },
    { command: "cancel", description: "Отменить текущий диалог" },
  ]);

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
