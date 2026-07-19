import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  AuthorizedUser,
  LlmUsage,
  PageSnapshot,
  StoreData,
  Watch,
  WatchPolicy,
} from "../domain/models.js";

const EMPTY_USAGE: LlmUsage = {
  date: "",
  count: 0,
};

const EMPTY_STORE: StoreData = {
  authorizedUsers: [],
  watches: [],
  llmUsage: EMPTY_USAGE,
};

export class JsonStore {
  private readonly filePath: string;
  private operationChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        await this.writeStore(EMPTY_STORE);
        return;
      }
      throw error;
    }
  }

  async isAuthorized(telegramUserId: string): Promise<boolean> {
    const store = await this.readStore();
    return store.authorizedUsers.some((user) => user.telegramUserId === telegramUserId);
  }

  async authorize(telegramUserId: string): Promise<void> {
    await this.mutate((store) => {
      if (store.authorizedUsers.some((user) => user.telegramUserId === telegramUserId)) {
        return;
      }
      const user: AuthorizedUser = {
        telegramUserId,
        activatedAt: new Date().toISOString(),
      };
      store.authorizedUsers.push(user);
    });
  }

  async countActiveWatches(telegramUserId: string): Promise<number> {
    const store = await this.readStore();
    return store.watches.filter(
      (watch) => watch.ownerTelegramId === telegramUserId && watch.status === "ACTIVE",
    ).length;
  }

  async createWatch(watch: Watch): Promise<void> {
    await this.mutate((store) => {
      store.watches.push(watch);
    });
  }

  async listActiveWatches(telegramUserId: string): Promise<Watch[]> {
    const store = await this.readStore();
    return store.watches
      .filter((watch) => watch.ownerTelegramId === telegramUserId && watch.status === "ACTIVE")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findActiveWatch(telegramUserId: string, watchId: string): Promise<Watch | null> {
    const store = await this.readStore();
    return (
      store.watches.find(
        (watch) =>
          watch.ownerTelegramId === telegramUserId &&
          watch.id === watchId &&
          watch.status === "ACTIVE",
      ) ?? null
    );
  }

  async updateWatchPolicy(
    telegramUserId: string,
    watchId: string,
    policy: WatchPolicy,
  ): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === watchId &&
          item.ownerTelegramId === telegramUserId &&
          item.status === "ACTIVE",
      );
      if (!watch) return;
      watch.policy = policy;
      updated = true;
    });
    return updated;
  }

  async updateWatchAfterCheck(options: {
    telegramUserId: string;
    watchId: string;
    expectedPreviousHash: string;
    snapshot: PageSnapshot;
    notificationFingerprint?: string;
  }): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === options.watchId &&
          item.ownerTelegramId === options.telegramUserId &&
          item.status === "ACTIVE",
      );
      if (!watch || watch.lastContentHash !== options.expectedPreviousHash) {
        return;
      }

      watch.url = options.snapshot.finalUrl;
      watch.pageTitle = options.snapshot.title;
      watch.lastCheckedAt = options.snapshot.fetchedAt;
      watch.lastContentHash = options.snapshot.hash;
      watch.lastSnapshot = options.snapshot.text;
      if (options.notificationFingerprint !== undefined) {
        watch.lastNotificationFingerprint = options.notificationFingerprint;
      }
      updated = true;
    });
    return updated;
  }

  async touchWatchCheck(
    telegramUserId: string,
    watchId: string,
    expectedHash: string,
    checkedAt: string,
  ): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === watchId &&
          item.ownerTelegramId === telegramUserId &&
          item.status === "ACTIVE",
      );
      if (!watch || watch.lastContentHash !== expectedHash) return;
      watch.lastCheckedAt = checkedAt;
      updated = true;
    });
    return updated;
  }

  async reserveLlmCall(maxCallsPerDay: number): Promise<{ allowed: boolean; used: number }> {
    let result = { allowed: false, used: 0 };
    await this.mutate((store) => {
      const today = utcDate(new Date());
      if (store.llmUsage.date !== today) {
        store.llmUsage = { date: today, count: 0 };
      }
      if (store.llmUsage.count >= maxCallsPerDay) {
        result = { allowed: false, used: store.llmUsage.count };
        return;
      }
      store.llmUsage.count += 1;
      result = { allowed: true, used: store.llmUsage.count };
    });
    return result;
  }

  async stopWatch(telegramUserId: string, watchId: string): Promise<boolean> {
    let stopped = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === watchId &&
          item.ownerTelegramId === telegramUserId &&
          item.status === "ACTIVE",
      );
      if (!watch) {
        return;
      }
      watch.status = "STOPPED";
      watch.stoppedAt = new Date().toISOString();
      stopped = true;
    });
    return stopped;
  }

  private async readStore(): Promise<StoreData> {
    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreData>;
    return {
      authorizedUsers: Array.isArray(parsed.authorizedUsers) ? parsed.authorizedUsers : [],
      watches: Array.isArray(parsed.watches) ? parsed.watches.map(normalizeWatch) : [],
      llmUsage: normalizeUsage(parsed.llmUsage),
    };
  }

  private async mutate(block: (store: StoreData) => void): Promise<void> {
    const operation = this.operationChain.then(async () => {
      const store = await this.readStore();
      block(store);
      await this.writeStore(store);
    });
    this.operationChain = operation.catch(() => undefined);
    await operation;
  }

  private async writeStore(store: StoreData): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function normalizeWatch(value: Watch): Watch {
  return {
    ...value,
    policy: value.policy ?? null,
    lastNotificationFingerprint: value.lastNotificationFingerprint ?? null,
  };
}

function normalizeUsage(value: LlmUsage | undefined): LlmUsage {
  if (!value || typeof value.date !== "string" || !Number.isInteger(value.count)) {
    return { ...EMPTY_USAGE };
  }
  return {
    date: value.date,
    count: Math.max(0, value.count),
  };
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
