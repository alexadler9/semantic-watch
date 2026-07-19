import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  AuthorizedUser,
  DeliveredResult,
  LlmUsage,
  NotificationFact,
  NotificationMessageBlock,
  NotificationMessagePart,
  PageSnapshot,
  PendingNotification,
  PolicyRevision,
  SemanticState,
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

export interface PendingNotificationItem {
  watch: Watch;
  notification: PendingNotification;
}

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
      if (store.authorizedUsers.some((user) => user.telegramUserId === telegramUserId)) return;
      const user: AuthorizedUser = {
        telegramUserId,
        activatedAt: new Date().toISOString(),
      };
      store.authorizedUsers.push(user);
    });
  }

  async countTrackedWatches(telegramUserId: string): Promise<number> {
    const store = await this.readStore();
    return store.watches.filter(
      (watch) => watch.ownerTelegramId === telegramUserId && watch.status !== "STOPPED",
    ).length;
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

  async listTrackedWatches(telegramUserId: string): Promise<Watch[]> {
    const store = await this.readStore();
    return store.watches
      .filter((watch) => watch.ownerTelegramId === telegramUserId && watch.status !== "STOPPED")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listActiveWatches(telegramUserId: string): Promise<Watch[]> {
    const store = await this.readStore();
    return store.watches
      .filter((watch) => watch.ownerTelegramId === telegramUserId && watch.status === "ACTIVE")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listDueWatches(nowIso: string, limit: number): Promise<Watch[]> {
    const store = await this.readStore();
    return store.watches
      .filter(
        (watch) =>
          watch.status === "ACTIVE" &&
          watch.pendingNotification === null &&
          watch.nextCheckAt <= nowIso,
      )
      .sort((left, right) => left.nextCheckAt.localeCompare(right.nextCheckAt))
      .slice(0, limit);
  }

  async listPendingNotifications(
    nowIso: string,
    maxAttempts: number,
    limit: number,
  ): Promise<PendingNotificationItem[]> {
    const store = await this.readStore();
    return store.watches
      .filter(
        (watch) =>
          watch.status === "ACTIVE" &&
          watch.pendingNotification !== null &&
          watch.pendingNotification.nextAttemptAt <= nowIso &&
          watch.pendingNotification.attempts < maxAttempts,
      )
      .sort((left, right) =>
        (left.pendingNotification?.nextAttemptAt ?? "").localeCompare(
          right.pendingNotification?.nextAttemptAt ?? "",
        ),
      )
      .slice(0, limit)
      .flatMap((watch) =>
        watch.pendingNotification ? [{ watch, notification: watch.pendingNotification }] : [],
      );
  }

  async findTrackedWatch(telegramUserId: string, watchId: string): Promise<Watch | null> {
    const store = await this.readStore();
    return (
      store.watches.find(
        (watch) =>
          watch.ownerTelegramId === telegramUserId &&
          watch.id === watchId &&
          watch.status !== "STOPPED",
      ) ?? null
    );
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
      if (watch.policyHistory.length === 0) {
        watch.policyVersion = Math.max(1, watch.policyVersion);
        watch.policyHistory.push({
          version: watch.policyVersion,
          policy,
          reason: "Правило восстановлено для записи предыдущей версии приложения.",
          createdAt: new Date().toISOString(),
        });
      }
      updated = true;
    });
    return updated;
  }

  async applyRefinedPolicy(options: {
    telegramUserId: string;
    watchId: string;
    resultId: string;
    policy: WatchPolicy;
    reason: string;
  }): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === options.watchId &&
          item.ownerTelegramId === options.telegramUserId &&
          item.status !== "STOPPED",
      );
      const result = watch?.lastDeliveredResult;
      if (!watch || !result || result.id !== options.resultId) return;

      const version = Math.max(1, watch.policyVersion) + 1;
      const revision: PolicyRevision = {
        version,
        policy: options.policy,
        reason: options.reason,
        createdAt: new Date().toISOString(),
      };

      watch.policy = options.policy;
      watch.policyVersion = version;
      watch.policyHistory.push(revision);
      watch.lastDeliveredResult = {
        ...result,
        feedbackStatus: "REJECTED",
        feedbackReason: options.reason,
      };
      updated = true;
    });
    return updated;
  }

  async confirmDeliveredResult(options: {
    telegramUserId: string;
    watchId: string;
    resultId: string;
  }): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === options.watchId &&
          item.ownerTelegramId === options.telegramUserId &&
          item.status !== "STOPPED",
      );
      const result = watch?.lastDeliveredResult;
      if (!watch || !result || result.id !== options.resultId) return;
      watch.lastDeliveredResult = {
        ...result,
        feedbackStatus: "CONFIRMED",
        feedbackReason: null,
      };
      updated = true;
    });
    return updated;
  }

  async updateWatchAfterCheck(options: {
    telegramUserId: string;
    watchId: string;
    expectedPreviousHash: string;
    snapshot: PageSnapshot;
    nextCheckAt: string;
    semanticStateSummary: string;
    pendingNotification?: PendingNotification;
  }): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === options.watchId &&
          item.ownerTelegramId === options.telegramUserId &&
          item.status === "ACTIVE",
      );
      if (!watch || watch.lastContentHash !== options.expectedPreviousHash) return;

      watch.url = options.snapshot.finalUrl;
      watch.pageTitle = options.snapshot.title;
      watch.lastCheckedAt = options.snapshot.fetchedAt;
      watch.nextCheckAt = options.nextCheckAt;
      watch.lastContentHash = options.snapshot.hash;
      watch.lastSnapshot = options.snapshot.text;
      watch.semanticState = {
        summary: options.semanticStateSummary,
        updatedAt: options.snapshot.fetchedAt,
      };
      watch.consecutiveFailures = 0;
      watch.lastCheckError = null;
      watch.pendingNotification = options.pendingNotification ?? null;
      updated = true;
    });
    return updated;
  }

  async touchWatchCheck(options: {
    telegramUserId: string;
    watchId: string;
    expectedHash: string;
    checkedAt: string;
    nextCheckAt: string;
  }): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === options.watchId &&
          item.ownerTelegramId === options.telegramUserId &&
          item.status === "ACTIVE",
      );
      if (!watch || watch.lastContentHash !== options.expectedHash) return;
      watch.lastCheckedAt = options.checkedAt;
      watch.nextCheckAt = options.nextCheckAt;
      watch.consecutiveFailures = 0;
      watch.lastCheckError = null;
      updated = true;
    });
    return updated;
  }

  async recordWatchCheckFailure(options: {
    telegramUserId: string;
    watchId: string;
    error: string;
    nextCheckAt: string;
  }): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === options.watchId &&
          item.ownerTelegramId === options.telegramUserId &&
          item.status === "ACTIVE",
      );
      if (!watch) return;
      watch.consecutiveFailures += 1;
      watch.lastCheckError = options.error;
      watch.nextCheckAt = options.nextCheckAt;
      updated = true;
    });
    return updated;
  }

  async markNotificationDelivered(options: {
    telegramUserId: string;
    watchId: string;
    fingerprint: string;
  }): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === options.watchId &&
          item.ownerTelegramId === options.telegramUserId &&
          item.status === "ACTIVE",
      );
      const pending = watch?.pendingNotification;
      if (!watch || !pending || pending.fingerprint !== options.fingerprint) return;

      const delivered: DeliveredResult = {
        id: pending.id,
        fingerprint: pending.fingerprint,
        summary: pending.summary,
        notificationFacts: pending.notificationFacts,
        notificationBlocks: pending.notificationBlocks,
        resultTitle: pending.resultTitle,
        resultItems: pending.resultItems,
        evidence: pending.evidence,
        createdAt: pending.createdAt,
        deliveredAt: new Date().toISOString(),
        feedbackStatus: "PENDING",
        feedbackReason: null,
      };
      watch.lastNotificationFingerprint = options.fingerprint;
      watch.lastDeliveredResult = delivered;
      watch.pendingNotification = null;
      updated = true;
    });
    return updated;
  }

  async recordNotificationFailure(options: {
    telegramUserId: string;
    watchId: string;
    fingerprint: string;
    error: string;
    attemptedAt: string;
    nextAttemptAt: string;
  }): Promise<boolean> {
    let updated = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === options.watchId &&
          item.ownerTelegramId === options.telegramUserId &&
          item.status === "ACTIVE",
      );
      const pending = watch?.pendingNotification;
      if (!watch || !pending || pending.fingerprint !== options.fingerprint) return;
      pending.attempts += 1;
      pending.lastAttemptAt = options.attemptedAt;
      pending.lastError = options.error;
      pending.nextAttemptAt = options.nextAttemptAt;
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

  async pauseWatch(telegramUserId: string, watchId: string): Promise<boolean> {
    let paused = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === watchId &&
          item.ownerTelegramId === telegramUserId &&
          item.status === "ACTIVE",
      );
      if (!watch) return;
      watch.status = "PAUSED";
      paused = true;
    });
    return paused;
  }

  async resumeWatch(telegramUserId: string, watchId: string): Promise<boolean> {
    let resumed = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === watchId &&
          item.ownerTelegramId === telegramUserId &&
          item.status === "PAUSED",
      );
      if (!watch) return;
      watch.status = "ACTIVE";
      watch.nextCheckAt = new Date().toISOString();
      resumed = true;
    });
    return resumed;
  }

  async deleteWatch(telegramUserId: string, watchId: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((store) => {
      const watch = store.watches.find(
        (item) =>
          item.id === watchId &&
          item.ownerTelegramId === telegramUserId &&
          item.status !== "STOPPED",
      );
      if (!watch) return;
      watch.status = "STOPPED";
      watch.stoppedAt = new Date().toISOString();
      watch.pendingNotification = null;
      deleted = true;
    });
    return deleted;
  }

  async stopWatch(telegramUserId: string, watchId: string): Promise<boolean> {
    return this.deleteWatch(telegramUserId, watchId);
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
  const fallbackCheckTime =
    typeof value.lastCheckedAt === "string" ? value.lastCheckedAt : new Date(0).toISOString();
  const policy = normalizePolicy(value.policy);
  const policyVersion = Number.isInteger(value.policyVersion)
    ? Math.max(policy ? 1 : 0, value.policyVersion)
    : policy
      ? 1
      : 0;
  const policyHistory = normalizePolicyHistory(value.policyHistory, policy, policyVersion, value.createdAt);

  return {
    ...value,
    status: normalizeWatchStatus(value.status),
    policy,
    policyVersion,
    policyHistory,
    semanticState: normalizeSemanticState(value.semanticState),
    lastNotificationFingerprint: value.lastNotificationFingerprint ?? null,
    pendingNotification: normalizePendingNotification(value.pendingNotification),
    lastDeliveredResult: normalizeDeliveredResult(value.lastDeliveredResult),
    nextCheckAt: value.nextCheckAt ?? fallbackCheckTime,
    consecutiveFailures: Number.isInteger(value.consecutiveFailures)
      ? Math.max(0, value.consecutiveFailures)
      : 0,
    lastCheckError: value.lastCheckError ?? null,
  };
}

function normalizePolicy(value: WatchPolicy | null | undefined): WatchPolicy | null {
  if (!value || typeof value.targetEvent !== "string") return null;
  return {
    targetEvent: value.targetEvent,
    requiredSignals: Array.isArray(value.requiredSignals)
      ? value.requiredSignals.filter((item) => typeof item === "string")
      : [],
    ignoredChanges: Array.isArray(value.ignoredChanges)
      ? value.ignoredChanges.filter((item) => typeof item === "string")
      : [],
    requestedOutput:
      typeof value.requestedOutput === "string" && value.requestedOutput.trim().length > 0
        ? value.requestedOutput.trim()
        : null,
    notificationInstruction:
      typeof value.notificationInstruction === "string" && value.notificationInstruction.trim().length > 0
        ? value.notificationInstruction.trim()
        : null,
  };
}

function normalizePolicyHistory(
  value: PolicyRevision[] | undefined,
  policy: WatchPolicy | null,
  version: number,
  createdAt: string,
): PolicyRevision[] {
  if (Array.isArray(value) && value.length > 0) {
    return value.flatMap((item) => {
      const normalizedPolicy = normalizePolicy(item.policy);
      if (!normalizedPolicy || !Number.isInteger(item.version)) return [];
      return [
        {
          version: Math.max(1, item.version),
          policy: normalizedPolicy,
          reason: typeof item.reason === "string" ? item.reason : "Правило обновлено.",
          createdAt: typeof item.createdAt === "string" ? item.createdAt : createdAt,
        },
      ];
    });
  }
  if (!policy) return [];
  return [
    {
      version: Math.max(1, version),
      policy,
      reason: "Исходное правило отслеживания.",
      createdAt,
    },
  ];
}

function normalizeSemanticState(value: SemanticState | null | undefined): SemanticState | null {
  if (!value || typeof value.summary !== "string") return null;
  return {
    summary: value.summary,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function normalizeWatchStatus(value: Watch["status"] | undefined): Watch["status"] {
  if (value === "PAUSED" || value === "STOPPED") return value;
  return "ACTIVE";
}

function normalizePendingNotification(
  value: PendingNotification | null | undefined,
): PendingNotification | null {
  if (!value || typeof value.fingerprint !== "string") return null;
  return {
    id:
      typeof value.id === "string" && value.id.length > 0
        ? value.id
        : value.fingerprint.replace(/[^a-z0-9]/gi, "").slice(0, 12),
    fingerprint: value.fingerprint,
    summary: typeof value.summary === "string" ? value.summary : "На странице найдена информация.",
    notificationFacts: normalizeNotificationFacts(value.notificationFacts),
    notificationBlocks: normalizeNotificationBlocks(value.notificationBlocks),
    resultTitle:
      typeof value.resultTitle === "string" && value.resultTitle.trim().length > 0
        ? value.resultTitle.trim()
        : null,
    resultItems: Array.isArray(value.resultItems)
      ? value.resultItems.filter((item) => typeof item === "string")
      : [],
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((item) => typeof item === "string")
      : [],
    visualFilePath:
      typeof value.visualFilePath === "string" && value.visualFilePath.trim().length > 0
        ? value.visualFilePath
        : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    nextAttemptAt:
      typeof value.nextAttemptAt === "string" ? value.nextAttemptAt : new Date().toISOString(),
    attempts: Number.isInteger(value.attempts) ? Math.max(0, value.attempts) : 0,
    lastAttemptAt: typeof value.lastAttemptAt === "string" ? value.lastAttemptAt : null,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
  };
}

function normalizeDeliveredResult(value: DeliveredResult | null | undefined): DeliveredResult | null {
  if (!value || typeof value.id !== "string" || typeof value.fingerprint !== "string") return null;
  return {
    id: value.id,
    fingerprint: value.fingerprint,
    summary: typeof value.summary === "string" ? value.summary : "На странице найдена информация.",
    notificationFacts: normalizeNotificationFacts(value.notificationFacts),
    notificationBlocks: normalizeNotificationBlocks(value.notificationBlocks),
    resultTitle:
      typeof value.resultTitle === "string" && value.resultTitle.trim().length > 0
        ? value.resultTitle.trim()
        : null,
    resultItems: Array.isArray(value.resultItems)
      ? value.resultItems.filter((item) => typeof item === "string")
      : [],
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((item) => typeof item === "string")
      : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    deliveredAt: typeof value.deliveredAt === "string" ? value.deliveredAt : new Date().toISOString(),
    feedbackStatus:
      value.feedbackStatus === "CONFIRMED" || value.feedbackStatus === "REJECTED"
        ? value.feedbackStatus
        : "PENDING",
    feedbackReason: typeof value.feedbackReason === "string" ? value.feedbackReason : null,
  };
}

function normalizeNotificationFacts(value: NotificationFact[] | undefined): NotificationFact[] {
  if (!Array.isArray(value)) return [];
  const result: NotificationFact[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item.id !== "string" || typeof item.value !== "string") continue;
    const id = item.id.trim();
    const factValue = item.value.trim();
    if (!id || !factValue || ids.has(id)) continue;
    ids.add(id);
    result.push({
      id,
      label:
        typeof item.label === "string" && item.label.trim().length > 0
          ? item.label.trim()
          : null,
      value: factValue,
    });
    if (result.length >= 16) break;
  }
  return result;
}

function normalizeNotificationBlocks(
  value: NotificationMessageBlock[] | undefined,
): NotificationMessageBlock[] {
  if (!Array.isArray(value)) return [];
  const result: NotificationMessageBlock[] = [];
  for (const block of value) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "PARAGRAPH": {
        if (!Array.isArray(block.parts)) break;
        const parts: NotificationMessagePart[] = [];
        for (const part of block.parts) {
          if (part?.kind === "TEXT" && typeof part.text === "string") {
            parts.push({ kind: "TEXT", text: part.text });
          } else if (part?.kind === "FACT" && typeof part.factId === "string") {
            parts.push({ kind: "FACT", factId: part.factId });
          }
        }
        if (parts.length > 0) result.push({ type: "PARAGRAPH", parts });
        break;
      }
      case "LIST": {
        if (!Array.isArray(block.factIds)) break;
        const factIds = block.factIds.filter((id): id is string => typeof id === "string");
        if (factIds.length > 0) {
          result.push({
            type: "LIST",
            title: typeof block.title === "string" && block.title.trim() ? block.title.trim() : null,
            factIds,
          });
        }
        break;
      }
      case "KEY_VALUE": {
        if (!Array.isArray(block.rows)) break;
        const rows = block.rows.flatMap((row) =>
          row && typeof row.label === "string" && typeof row.factId === "string"
            ? [{ label: row.label, factId: row.factId }]
            : [],
        );
        if (rows.length > 0) {
          result.push({
            type: "KEY_VALUE",
            title: typeof block.title === "string" && block.title.trim() ? block.title.trim() : null,
            rows,
          });
        }
        break;
      }
      case "QUOTE":
        if (typeof block.factId === "string") {
          result.push({ type: "QUOTE", factId: block.factId });
        }
        break;
    }
    if (result.length >= 8) break;
  }
  return result;
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
