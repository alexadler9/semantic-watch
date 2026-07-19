import { SemanticEvaluator } from "../ai/semantic-evaluator.js";
import type {
  PendingNotification,
  SemanticEvaluation,
  Watch,
} from "../domain/models.js";
import {
  groundEvidence,
  groundNotificationFacts,
  isVolatileEvidence,
  normalizeEvidenceText,
} from "../evidence/evidence-grounding.js";
import type { PageFetcher } from "../fetcher/page-fetcher.js";
import {
  notificationFactValues,
  sanitizeNotificationBlocks,
} from "../notifications/notification-content.js";
import { JsonStore } from "../storage/json-store.js";
import type { VisualEvidenceService } from "../visual/visual-evidence-service.js";
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
    private readonly pageFetcher: PageFetcher,
    private readonly semanticEvaluator: SemanticEvaluator,
    private readonly visualEvidence: VisualEvidenceService,
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
    const observation = await this.pageFetcher.fetch(watch.url, { captureVisual: true });
    const snapshot = observation.snapshot;
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
    let evaluation = await this.semanticEvaluator.evaluateChange({
      instruction: watch.instruction,
      policy,
      previousState: watch.semanticState?.summary ?? null,
      diff,
    });

    const matched =
      evaluation.conditionMatched &&
      evaluation.confidence >= this.options.matchConfidenceThreshold;

    if (matched) {
      const outputWasRequested =
        policy.requestedOutput !== null || instructionRequestsOutput(watch.instruction);
      const rawFacts = outputWasRequested ? evaluation.notificationFacts : [];
      const groundedFacts = groundNotificationFacts({
        aiFacts: rawFacts,
        currentText: snapshot.text,
        diff,
        maxItems: 16,
      });
      const groundedBlocks = sanitizeNotificationBlocks({
        blocks: outputWasRequested ? evaluation.notificationBlocks : [],
        facts: groundedFacts,
        instruction: watch.instruction,
        policy,
      });
      const groundedResultItems = notificationFactValues(groundedFacts);
      const groundedEvidence = groundEvidence({
        aiEvidence: [...evaluation.evidence, ...groundedResultItems.slice(0, 3)],
        currentText: snapshot.text,
        diff,
      });

      if (groundedEvidence.length === 0) {
        console.warn("AI match has no exact evidence anchor; notification will be sent without quotes.", {
          watchId: watch.id,
        });
      }
      if (outputWasRequested && groundedFacts.length === 0) {
        console.warn("The user requested result data, but no notification fact could be grounded.", {
          watchId: watch.id,
        });
      }

      evaluation = {
        ...evaluation,
        notificationFacts: groundedFacts,
        notificationBlocks: groundedBlocks,
        resultTitle:
          groundedResultItems.length > 0
            ? normalizeResultTitle(
                evaluation.resultTitle ??
                  policy.requestedOutput ??
                  inferResultTitle(watch.instruction),
              )
            : null,
        resultItems: groundedResultItems,
        evidence: groundedEvidence,
      };
    } else {
      evaluation = {
        ...evaluation,
        notificationFacts: [],
        notificationBlocks: [],
        resultTitle: null,
        resultItems: [],
        evidence: [],
      };
    }

    let notificationFingerprint: string | undefined;
    let duplicate = false;
    let pendingNotification: PendingNotification | undefined;

    if (matched) {
      notificationFingerprint = buildNotificationFingerprint(
        policy.targetEvent,
        evaluation.resultItems,
        evaluation.evidence,
        evaluation.summary,
      );
      duplicate = notificationFingerprint === watch.lastNotificationFingerprint;

      if (!duplicate) {
        let visualFilePath: string | null = null;
        if (observation.visual) {
          try {
            visualFilePath = await this.visualEvidence.prepareAndStore({
              observation: observation.visual,
              imageId: `${watch.id}-${notificationFingerprint.slice(0, 24)}`,
            });
          } catch (error) {
            console.warn("Could not prepare the captured page image; notification stays text-only.", {
              watchId: watch.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        pendingNotification = {
          id: notificationFingerprint.slice(0, 12),
          fingerprint: notificationFingerprint,
          summary: evaluation.summary,
          notificationFacts: evaluation.notificationFacts,
          notificationBlocks: evaluation.notificationBlocks,
          resultTitle: evaluation.resultTitle,
          resultItems: evaluation.resultItems,
          evidence: evaluation.evidence,
          visualFilePath,
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
      await this.visualEvidence.removePrepared(pendingNotification?.visualFilePath ?? null).catch(() => undefined);
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

function buildNotificationFingerprint(
  targetEvent: string,
  resultItems: string[],
  evidence: string[],
  summary: string,
): string {
  const stableResultItems = resultItems.filter((item) => !isVolatileEvidence(item));
  const stableEvidence = evidence.filter((item) => !isVolatileEvidence(item));
  const fingerprintItems =
    stableResultItems.length > 0
      ? stableResultItems
      : stableEvidence.length > 0
        ? stableEvidence
        : resultItems.length > 0
          ? resultItems
          : evidence;

  return sha256(
    JSON.stringify({
      targetEvent: normalizeEvidenceText(targetEvent),
      result:
        fingerprintItems.length > 0
          ? fingerprintItems.map(normalizeEvidenceText).sort()
          : [normalizeEvidenceText(summary)],
    }),
  );
}

function instructionRequestsOutput(instruction: string): boolean {
  const hasOutputVerb =
    /(?:покаж|вывед|вывод|перечисл|пришл|присыла|напиш|пиш|добав.{0,12}(?:сообщен|уведомлен)|укаж.{0,12}(?:сообщен|уведомлен)|include|list|show|display|send)/iu.test(
      instruction,
    );
  const hasOutputTarget =
    /(?:данн|заголов|назван|список|цен|курс|процент|изменен|разниц|дат|значен|элемент|новост|item|title|name|price|rate|percent|change|date|value)/iu.test(
      instruction,
    );
  return hasOutputVerb && hasOutputTarget;
}

function inferResultTitle(instruction: string): string {
  if (/заголов|title/iu.test(instruction)) return "Новые заголовки";
  if (/цен|price/iu.test(instruction)) return "Изменившиеся цены";
  if (/дат|date/iu.test(instruction)) return "Новые даты";
  if (/значен|value/iu.test(instruction)) return "Изменившиеся значения";
  if (/назван|name/iu.test(instruction)) return "Новые названия";
  return "Запрошенные данные";
}

function normalizeResultTitle(value: string): string {
  const normalized = value.replace(/[:\s]+$/g, "").replace(/\s+/g, " ").trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117).trimEnd()}…`;
}
