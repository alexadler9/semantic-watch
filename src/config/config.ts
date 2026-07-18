import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value?.trim().toLowerCase() === "true");

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_IDS: z.string().optional().default(""),
  ACCESS_KEY: z.string().optional().default(""),
  DATA_FILE: z.string().optional().default("./data/store.json"),
  MAX_ACTIVE_WATCHES_PER_USER: z.coerce.number().int().min(1).max(20).default(5),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(2_097_152),
  MAX_PAGE_TEXT_CHARS: z.coerce.number().int().min(1000).max(100_000).default(30_000),
  DEMO_MODE: booleanFromEnv,
  DEMO_URL: z.string().url().optional().default("http://127.0.0.1:3001/"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

const ownerIds = new Set(
  parsed.data.TELEGRAM_OWNER_IDS.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const accessKey = parsed.data.ACCESS_KEY.trim() || null;
if (ownerIds.size === 0 && accessKey === null) {
  console.error("Configure TELEGRAM_OWNER_IDS or ACCESS_KEY before starting the bot.");
  process.exit(1);
}

export interface AppConfig {
  telegramBotToken: string;
  telegramOwnerIds: ReadonlySet<string>;
  accessKey: string | null;
  dataFile: string;
  maxActiveWatchesPerUser: number;
  fetchTimeoutMs: number;
  maxResponseBytes: number;
  maxPageTextChars: number;
  demoMode: boolean;
  demoUrl: string;
}

export const config: AppConfig = {
  telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
  telegramOwnerIds: ownerIds,
  accessKey,
  dataFile: parsed.data.DATA_FILE,
  maxActiveWatchesPerUser: parsed.data.MAX_ACTIVE_WATCHES_PER_USER,
  fetchTimeoutMs: parsed.data.FETCH_TIMEOUT_MS,
  maxResponseBytes: parsed.data.MAX_RESPONSE_BYTES,
  maxPageTextChars: parsed.data.MAX_PAGE_TEXT_CHARS,
  demoMode: parsed.data.DEMO_MODE,
  demoUrl: new URL(parsed.data.DEMO_URL).toString(),
};
