import type { PageObservation } from "../domain/models.js";

export interface PageFetchOptions {
  captureVisual?: boolean;
}

export interface PageFetcher {
  fetch(url: string, options?: PageFetchOptions): Promise<PageObservation>;
}
