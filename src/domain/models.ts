export type WatchStatus = "ACTIVE" | "PAUSED" | "STOPPED";

export interface AuthorizedUser {
  telegramUserId: string;
  activatedAt: string;
}

export interface WatchPolicy {
  targetEvent: string;
  requiredSignals: string[];
  ignoredChanges: string[];
}

export interface SemanticEvaluation {
  meaningfulChange: boolean;
  conditionMatched: boolean;
  confidence: number;
  summary: string;
  evidence: string[];
}

export interface PendingNotification {
  fingerprint: string;
  summary: string;
  evidence: string[];
  createdAt: string;
  nextAttemptAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface Watch {
  id: string;
  ownerTelegramId: string;
  url: string;
  instruction: string;
  policy: WatchPolicy | null;
  status: WatchStatus;
  createdAt: string;
  stoppedAt: string | null;
  lastCheckedAt: string;
  nextCheckAt: string;
  lastContentHash: string;
  lastSnapshot: string;
  lastNotificationFingerprint: string | null;
  pendingNotification: PendingNotification | null;
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
