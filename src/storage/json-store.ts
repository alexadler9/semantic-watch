import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AuthorizedUser, StoreData, Watch } from "../domain/models.js";

const EMPTY_STORE: StoreData = {
  authorizedUsers: [],
  watches: [],
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
      watches: Array.isArray(parsed.watches) ? parsed.watches : [],
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
