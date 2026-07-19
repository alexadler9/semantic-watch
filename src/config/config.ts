import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value?.trim().toLowerCase() === "true");

const booleanDefaultTrueFromEnv = z
  .string()
  .optional()
  .transform((value) => value === undefined || value.trim().toLowerCase() === "true");


const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_IDS: z.string().optional().default(""),
  ACCESS_KEY: z.string().optional().default(""),
  DATA_FILE: z.string().optional().default("./data/store.json"),
  MAX_ACTIVE_WATCHES_PER_USER: z.coerce.number().int().min(1).max(20).default(5),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(2_097_152),
  MAX_PAGE_TEXT_CHARS: z.coerce.number().int().min(1000).max(100_000).default(30_000),
  MAX_DIFF_CHARS: z.coerce.number().int().min(1000).max(50_000).default(12_000),
  MAX_LLM_CALLS_PER_DAY: z.coerce.number().int().min(1).max(1000).default(50),
  MATCH_CONFIDENCE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_BASE_URL: z.string().url().optional().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().min(1).optional().default("deepseek-v4-flash"),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  SCHEDULER_ENABLED: booleanDefaultTrueFromEnv,
  SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  DEFAULT_CHECK_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  ERROR_RETRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  NOTIFICATION_RETRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  MAX_CHECKS_PER_TICK: z.coerce.number().int().min(1).max(100).default(10),
  MAX_NOTIFICATION_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
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
  maxDiffChars: number;
  maxLlmCallsPerDay: number;
  matchConfidenceThreshold: number;
  deepSeekApiKey: string;
  deepSeekBaseUrl: string;
  deepSeekModel: string;
  deepSeekTimeoutMs: number;
  schedulerEnabled: boolean;
  schedulerTickSeconds: number;
  defaultCheckIntervalMinutes: number;
  errorRetryMinutes: number;
  notificationRetryMinutes: number;
  maxChecksPerTick: number;
  maxNotificationAttempts: number;
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
  maxDiffChars: parsed.data.MAX_DIFF_CHARS,
  maxLlmCallsPerDay: parsed.data.MAX_LLM_CALLS_PER_DAY,
  matchConfidenceThreshold: parsed.data.MATCH_CONFIDENCE_THRESHOLD,
  deepSeekApiKey: parsed.data.DEEPSEEK_API_KEY,
  deepSeekBaseUrl: parsed.data.DEEPSEEK_BASE_URL.replace(/\/+$/, ""),
  deepSeekModel: parsed.data.DEEPSEEK_MODEL,
  deepSeekTimeoutMs: parsed.data.DEEPSEEK_TIMEOUT_MS,
  schedulerEnabled: parsed.data.SCHEDULER_ENABLED,
  schedulerTickSeconds: parsed.data.SCHEDULER_TICK_SECONDS,
  defaultCheckIntervalMinutes: parsed.data.DEFAULT_CHECK_INTERVAL_MINUTES,
  errorRetryMinutes: parsed.data.ERROR_RETRY_MINUTES,
  notificationRetryMinutes: parsed.data.NOTIFICATION_RETRY_MINUTES,
  maxChecksPerTick: parsed.data.MAX_CHECKS_PER_TICK,
  maxNotificationAttempts: parsed.data.MAX_NOTIFICATION_ATTEMPTS,
  demoMode: parsed.data.DEMO_MODE,
  demoUrl: new URL(parsed.data.DEMO_URL).toString(),
};
