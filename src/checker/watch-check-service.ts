import { SemanticEvaluator } from "../ai/semantic-evaluator.js";
import type { PendingNotification, SemanticEvaluation, Watch } from "../domain/models.js";
import { SafePageFetcher } from "../fetcher/safe-page-fetcher.js";
import { JsonStore } from "../storage/json-store.js";
import { sha256 } from "../utils/hash.js";
import { buildTextDiff } from "../utils/text-diff.js";
import { addMinutesIso } from "../utils/time.js";

export type WatchCheckResult =
  | { kind: "UNCHANGED"; watch: Watch }
  | { kind: "NO_MATCH"; watch: Watch; evaluation: SemanticEvaluation }
  | {
      kind: "MATCH";
      watch: Watch;
      evaluation: SemanticEvaluation;
      duplicate: boolean;
      notificationFingerprint: string;
    };

export interface WatchCheckServiceOptions {
  maxDiffChars: number;
  matchConfidenceThreshold: number;
  checkIntervalMinutes: number;
}

export class WatchCheckInProgressError extends Error {
  constructor(watchId: string) {
    super(`Watch ${watchId} is already being checked.`);
    this.name = "WatchCheckInProgressError";
  }
}

export class WatchCheckService {
  private readonly runningWatchIds = new Set<string>();

  constructor(
    private readonly store: JsonStore,
    private readonly pageFetcher: SafePageFetcher,
    private readonly semanticEvaluator: SemanticEvaluator,
    private readonly options: WatchCheckServiceOptions,
  ) {}

  async check(watch: Watch): Promise<WatchCheckResult> {
    if (this.runningWatchIds.has(watch.id)) {
      throw new WatchCheckInProgressError(watch.id);
    }

    this.runningWatchIds.add(watch.id);
    try {
      return await this.checkUnlocked(watch);
    } finally {
      this.runningWatchIds.delete(watch.id);
    }
  }

  private async checkUnlocked(watch: Watch): Promise<WatchCheckResult> {
    const snapshot = await this.pageFetcher.fetch(watch.url);
    const nextCheckAt = addMinutesIso(snapshot.fetchedAt, this.options.checkIntervalMinutes);

    if (snapshot.hash === watch.lastContentHash) {
      await this.store.touchWatchCheck({
        telegramUserId: watch.ownerTelegramId,
        watchId: watch.id,
        expectedHash: watch.lastContentHash,
        checkedAt: snapshot.fetchedAt,
        nextCheckAt,
      });
      return { kind: "UNCHANGED", watch };
    }

    let policy = watch.policy;
    if (!policy) {
      policy = await this.semanticEvaluator.createPolicy(watch.instruction);
      const stored = await this.store.updateWatchPolicy(watch.ownerTelegramId, watch.id, policy);
      if (!stored) {
        throw new Error("Watch was stopped while its AI policy was being created.");
      }
    }

    const diff = buildTextDiff(watch.lastSnapshot, snapshot.text, this.options.maxDiffChars);
    const evaluation = await this.semanticEvaluator.evaluateChange({
      instruction: watch.instruction,
      policy,
      previousState: watch.semanticState?.summary ?? null,
      diff,
    });

    const matched =
      evaluation.conditionMatched &&
      evaluation.confidence >= this.options.matchConfidenceThreshold;

    let notificationFingerprint: string | undefined;
    let duplicate = false;
    let pendingNotification: PendingNotification | undefined;

    if (matched) {
      validateEvidence(evaluation.evidence, snapshot.text);
      notificationFingerprint = buildNotificationFingerprint(policy.targetEvent, evaluation.evidence);
      duplicate = notificationFingerprint === watch.lastNotificationFingerprint;

      if (!duplicate) {
        pendingNotification = {
          id: notificationFingerprint.slice(0, 12),
          fingerprint: notificationFingerprint,
          summary: evaluation.summary,
          evidence: evaluation.evidence,
          createdAt: snapshot.fetchedAt,
          nextAttemptAt: snapshot.fetchedAt,
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
        };
      }
    }

    const updated = await this.store.updateWatchAfterCheck({
      telegramUserId: watch.ownerTelegramId,
      watchId: watch.id,
      expectedPreviousHash: watch.lastContentHash,
      snapshot,
      nextCheckAt,
      semanticStateSummary: evaluation.currentState,
      ...(pendingNotification ? { pendingNotification } : {}),
    });
    if (!updated) {
      throw new Error("Watch changed concurrently. Run the check again.");
    }

    const updatedWatch: Watch = {
      ...watch,
      policy,
      url: snapshot.finalUrl,
      pageTitle: snapshot.title,
      lastCheckedAt: snapshot.fetchedAt,
      nextCheckAt,
      lastContentHash: snapshot.hash,
      lastSnapshot: snapshot.text,
      semanticState: {
        summary: evaluation.currentState,
        updatedAt: snapshot.fetchedAt,
      },
      consecutiveFailures: 0,
      lastCheckError: null,
      pendingNotification: pendingNotification ?? null,
    };

    if (!matched) {
      return { kind: "NO_MATCH", watch: updatedWatch, evaluation };
    }

    return {
      kind: "MATCH",
      watch: updatedWatch,
      evaluation,
      duplicate,
      notificationFingerprint: notificationFingerprint ?? "",
    };
  }
}

function validateEvidence(evidence: string[], currentText: string): void {
  if (evidence.length === 0) {
    throw new Error("AI reported a match without evidence. Snapshot was not updated.");
  }
  const normalizedPage = normalizeForEvidence(currentText);
  const invalid = evidence.filter((quote) => !normalizedPage.includes(normalizeForEvidence(quote)));
  if (invalid.length > 0) {
    throw new Error("AI evidence was not found in the current page. Snapshot was not updated.");
  }
}

function buildNotificationFingerprint(targetEvent: string, evidence: string[]): string {
  return sha256(
    JSON.stringify({
      targetEvent: normalizeForEvidence(targetEvent),
      evidence: evidence.map(normalizeForEvidence).sort(),
    }),
  );
}

function normalizeForEvidence(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
}
