export type WatchStatus = "ACTIVE" | "STOPPED";

export interface AuthorizedUser {
  telegramUserId: string;
  activatedAt: string;
}

export interface Watch {
  id: string;
  ownerTelegramId: string;
  url: string;
  instruction: string;
  status: WatchStatus;
  createdAt: string;
  stoppedAt: string | null;
  lastCheckedAt: string;
  lastContentHash: string;
  lastSnapshot: string;
  pageTitle: string | null;
}

export interface StoreData {
  authorizedUsers: AuthorizedUser[];
  watches: Watch[];
}

export interface PageSnapshot {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  text: string;
  hash: string;
  fetchedAt: string;
}
