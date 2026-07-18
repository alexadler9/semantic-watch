import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/config.js";
import { JsonStore } from "../storage/json-store.js";

export class AccessService {
  constructor(
    private readonly appConfig: AppConfig,
    private readonly store: JsonStore,
  ) {}

  async isAllowed(telegramUserId: string): Promise<boolean> {
    return (
      this.appConfig.telegramOwnerIds.has(telegramUserId) ||
      (await this.store.isAuthorized(telegramUserId))
    );
  }

  async activate(telegramUserId: string, providedKey: string): Promise<boolean> {
    const configuredKey = this.appConfig.accessKey;
    if (!configuredKey || !safeEquals(configuredKey, providedKey.trim())) {
      return false;
    }
    await this.store.authorize(telegramUserId);
    return true;
  }

  isActivationEnabled(): boolean {
    return this.appConfig.accessKey !== null;
  }
}

function safeEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
