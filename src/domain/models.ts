export type WatchStatus = "ACTIVE" | "PAUSED" | "STOPPED";
export type ResultFeedbackStatus = "PENDING" | "CONFIRMED" | "REJECTED";

export interface AuthorizedUser {
  telegramUserId: string;
  activatedAt: string;
}

export interface WatchPolicy {
  targetEvent: string;
  requiredSignals: string[];
  ignoredChanges: string[];
  requestedOutput: string | null;
  notificationInstruction: string | null;
}

export interface PolicyRevision {
  version: number;
  policy: WatchPolicy;
  reason: string;
  createdAt: string;
}

export interface SemanticState {
  summary: string;
  updatedAt: string;
}

export interface NotificationFact {
  id: string;
  label: string | null;
  value: string;
}

export type NotificationMessagePart =
  | { kind: "TEXT"; text: string }
  | { kind: "FACT"; factId: string };

export type NotificationMessageBlock =
  | {
      type: "PARAGRAPH";
      parts: NotificationMessagePart[];
    }
  | {
      type: "LIST";
      title: string | null;
      factIds: string[];
    }
  | {
      type: "KEY_VALUE";
      title: string | null;
      rows: Array<{ label: string; factId: string }>;
    }
  | {
      type: "QUOTE";
      factId: string;
    };

export interface SemanticEvaluation {
  meaningfulChange: boolean;
  conditionMatched: boolean;
  confidence: number;
  summary: string;
  notificationFacts: NotificationFact[];
  notificationBlocks: NotificationMessageBlock[];
  // Legacy fields are kept for feedback history and old persisted notifications.
  resultTitle: string | null;
  resultItems: string[];
  evidence: string[];
  currentState: string;
}

export interface PendingNotification {
  id: string;
  fingerprint: string;
  summary: string;
  notificationFacts: NotificationFact[];
  notificationBlocks: NotificationMessageBlock[];
  resultTitle: string | null;
  resultItems: string[];
  evidence: string[];
  visualFilePath: string | null;
  createdAt: string;
  nextAttemptAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface DeliveredResult {
  id: string;
  fingerprint: string;
  summary: string;
  notificationFacts: NotificationFact[];
  notificationBlocks: NotificationMessageBlock[];
  resultTitle: string | null;
  resultItems: string[];
  evidence: string[];
  createdAt: string;
  deliveredAt: string;
  feedbackStatus: ResultFeedbackStatus;
  feedbackReason: string | null;
}

export interface Watch {
  id: string;
  ownerTelegramId: string;
  url: string;
  instruction: string;
  policy: WatchPolicy | null;
  policyVersion: number;
  policyHistory: PolicyRevision[];
  semanticState: SemanticState | null;
  status: WatchStatus;
  createdAt: string;
  stoppedAt: string | null;
  lastCheckedAt: string;
  nextCheckAt: string;
  lastContentHash: string;
  lastSnapshot: string;
  lastNotificationFingerprint: string | null;
  pendingNotification: PendingNotification | null;
  lastDeliveredResult: DeliveredResult | null;
  consecutiveFailures: number;
  lastCheckError: string | null;
  pageTitle: string | null;
}

export interface LlmUsage {
  date: string;
  count: number;
}

export interface StoreData {
  authorizedUsers: AuthorizedUser[];
  watches: Watch[];
  llmUsage: LlmUsage;
}

export interface PageSnapshot {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  text: string;
  hash: string;
  fetchedAt: string;
}

export interface PageVisualObservation {
  image: Buffer;
}

export interface PageObservation {
  snapshot: PageSnapshot;
  visual: PageVisualObservation | null;
}
