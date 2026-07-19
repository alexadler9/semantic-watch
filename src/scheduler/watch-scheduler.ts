import type { Api } from "grammy";
import { ScreenMessageRegistry } from "../bot/screen-message-registry.js";
import { WatchCheckInProgressError, WatchCheckService } from "../checker/watch-check-service.js";
import {
  formatImportantChange,
  importantNotificationKeyboard,
} from "../notifications/telegram-messages.js";
import { JsonStore } from "../storage/json-store.js";
import { truncate } from "../utils/text.js";
import { addMinutesIso } from "../utils/time.js";

export interface WatchSchedulerOptions {
  tickSeconds: number;
  errorRetryMinutes: number;
  notificationRetryMinutes: number;
  maxChecksPerTick: number;
  maxNotificationAttempts: number;
}

export class WatchScheduler {
  private timer: NodeJS.Timeout | null = null;
  private tickRunning = false;

  constructor(
    private readonly api: Api,
    private readonly store: JsonStore,
    private readonly checkService: WatchCheckService,
    private readonly options: WatchSchedulerOptions,
    private readonly screenMessages: ScreenMessageRegistry,
  ) {}

  start(): void {
    if (this.timer) return;

    // Первый проход запускаем сразу: после рестарта просроченные проверки не ждут следующий интервал.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.tickSeconds * 1_000);
    this.timer.unref();
    console.log(`Watch scheduler started. Tick: ${this.options.tickSeconds}s.`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log("Watch scheduler stopped.");
  }

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;

    try {
      await this.deliverPendingNotifications();
      await this.checkDueWatches();
      await this.deliverPendingNotifications();
    } catch (error) {
      console.error("Scheduler tick failed:", toLogError(error));
    } finally {
      this.tickRunning = false;
    }
  }

  private async checkDueWatches(): Promise<void> {
    const dueWatches = await this.store.listDueWatches(
      new Date().toISOString(),
      this.options.maxChecksPerTick,
    );

    for (const watch of dueWatches) {
      try {
        const result = await this.checkService.check(watch);
        console.log("Scheduled watch checked", {
          watchId: watch.id,
          result: result.kind,
          duplicate: result.kind === "MATCH" ? result.duplicate : undefined,
        });
      } catch (error) {
        if (error instanceof WatchCheckInProgressError) {
          continue;
        }

        const message = toLogError(error);
        await this.store.recordWatchCheckFailure({
          telegramUserId: watch.ownerTelegramId,
          watchId: watch.id,
          error: message,
          nextCheckAt: addMinutesIso(new Date(), this.options.errorRetryMinutes),
        });
        console.warn("Scheduled watch check failed", {
          watchId: watch.id,
          error: message,
        });
      }
    }
  }

  private async deliverPendingNotifications(): Promise<void> {
    const pendingItems = await this.store.listPendingNotifications(
      new Date().toISOString(),
      this.options.maxNotificationAttempts,
      this.options.maxChecksPerTick,
    );

    for (const item of pendingItems) {
      const attemptedAt = new Date().toISOString();
      try {
        await this.api.sendMessage(
          item.watch.ownerTelegramId,
          formatImportantChange(item.watch, item.notification),
          {
            link_preview_options: { is_disabled: true },
            reply_markup: importantNotificationKeyboard(item.watch, item.notification),
          },
        );
        this.screenMessages.markSeparatedByPermanentMessage(item.watch.ownerTelegramId);
        await this.store.markNotificationDelivered({
          telegramUserId: item.watch.ownerTelegramId,
          watchId: item.watch.id,
          fingerprint: item.notification.fingerprint,
        });
        console.log("Watch notification delivered", { watchId: item.watch.id });
      } catch (error) {
        const message = toLogError(error);
        await this.store.recordNotificationFailure({
          telegramUserId: item.watch.ownerTelegramId,
          watchId: item.watch.id,
          fingerprint: item.notification.fingerprint,
          error: message,
          attemptedAt,
          nextAttemptAt: addMinutesIso(attemptedAt, this.options.notificationRetryMinutes),
        });
        console.warn("Watch notification delivery failed", {
          watchId: item.watch.id,
          error: message,
        });
      }
    }
  }
}

function toLogError(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), 500);
}
