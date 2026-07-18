import { config } from "./config/config.js";
import { createBot } from "./bot/create-bot.js";
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

  const bot = createBot(config, store, pageFetcher);

  await bot.api.setMyCommands([
    { command: "start", description: "Описание сервиса" },
    { command: "watch", description: "Создать наблюдение" },
    { command: "list", description: "Активные наблюдения" },
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
