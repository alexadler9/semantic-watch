import type { SemanticEvaluation, Watch } from "../domain/models.js";
import { SafePageFetcher } from "../fetcher/safe-page-fetcher.js";
import { JsonStore } from "../storage/json-store.js";
import { sha256 } from "../utils/hash.js";
import { buildTextDiff } from "../utils/text-diff.js";
import { SemanticEvaluator } from "../ai/semantic-evaluator.js";

export type WatchCheckResult =
  | { kind: "UNCHANGED"; watch: Watch }
  | { kind: "NO_MATCH"; watch: Watch; evaluation: SemanticEvaluation }
  | { kind: "MATCH"; watch: Watch; evaluation: SemanticEvaluation; duplicate: boolean };

export interface WatchCheckServiceOptions {
  maxDiffChars: number;
  matchConfidenceThreshold: number;
}

export class WatchCheckService {
  constructor(
    private readonly store: JsonStore,
    private readonly pageFetcher: SafePageFetcher,
    private readonly semanticEvaluator: SemanticEvaluator,
    private readonly options: WatchCheckServiceOptions,
  ) {}

  async check(watch: Watch): Promise<WatchCheckResult> {
    const snapshot = await this.pageFetcher.fetch(watch.url);
    if (snapshot.hash === watch.lastContentHash) {
      await this.store.touchWatchCheck(
        watch.ownerTelegramId,
        watch.id,
        watch.lastContentHash,
        snapshot.fetchedAt,
      );
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
      diff,
    });

    const matched =
      evaluation.conditionMatched &&
      evaluation.confidence >= this.options.matchConfidenceThreshold;

    let fingerprint: string | undefined;
    let duplicate = false;
    if (matched) {
      validateEvidence(evaluation.evidence, snapshot.text);
      fingerprint = buildNotificationFingerprint(policy.targetEvent, evaluation.evidence);
      duplicate = fingerprint === watch.lastNotificationFingerprint;
    }

    const updated = await this.store.updateWatchAfterCheck({
      telegramUserId: watch.ownerTelegramId,
      watchId: watch.id,
      expectedPreviousHash: watch.lastContentHash,
      snapshot,
      ...(fingerprint !== undefined ? { notificationFingerprint: fingerprint } : {}),
    });
    if (!updated) {
      throw new Error("Watch changed concurrently. Run the check again.");
    }

    if (!matched) {
      return { kind: "NO_MATCH", watch, evaluation };
    }
    return { kind: "MATCH", watch, evaluation, duplicate };
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
