import type {
  PageObservation,
  PageSnapshot,
  PageVisualObservation,
} from "../domain/models.js";
import { sha256 } from "../utils/hash.js";
import { BrowserRuntime, waitForRenderedPage } from "../browser/browser-runtime.js";
import type { PageFetchOptions, PageFetcher } from "./page-fetcher.js";
import { UrlSafetyGuard } from "./url-safety.js";

export interface BrowserPageFetcherOptions {
  timeoutMs: number;
  maxPageTextChars: number;
  screenshotEnabled: boolean;
}

export class BrowserPageFetcher implements PageFetcher {
  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly safety: UrlSafetyGuard,
    private readonly options: BrowserPageFetcherOptions,
  ) {}

  async fetch(rawUrl: string, fetchOptions: PageFetchOptions = {}): Promise<PageObservation> {
    const requestedUrl = await this.safety.normalizeUserUrl(rawUrl);

    return this.runtime.withPage(async (page) => {
      const response = await page.goto(requestedUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.options.timeoutMs,
      });
      if (response && response.status() >= 400) {
        throw new Error(`Page returned HTTP ${response.status()}.`);
      }

      await waitForRenderedPage(page, this.options.timeoutMs);
      const finalUrl = page.url();
      await this.safety.assertBrowserRequestAllowed(finalUrl);

      const title = normalizeInline(await page.title()) || null;
      const rawText = await page.locator("body").innerText({ timeout: this.options.timeoutMs });
      const text = normalizeRenderedText(rawText).slice(0, this.options.maxPageTextChars).trim();
      if (!text) {
        throw new Error("The rendered page does not contain readable text.");
      }

      const fetchedAt = new Date().toISOString();
      const snapshot: PageSnapshot = {
        requestedUrl,
        finalUrl,
        title,
        text,
        hash: sha256(text),
        fetchedAt,
      };

      const shouldCaptureVisual =
        fetchOptions.captureVisual === true && this.options.screenshotEnabled;
      if (!shouldCaptureVisual) {
        return { snapshot, visual: null };
      }

      try {
        const visual = await captureVisualObservation(page);
        return { snapshot, visual };
      } catch (error) {
        console.warn("Could not capture a consistent page image; semantic check will continue.", {
          url: finalUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        return { snapshot, visual: null };
      }
    });
  }
}

async function captureVisualObservation(
  page: import("playwright").Page,
): Promise<PageVisualObservation> {
  const image = await page.screenshot({
    type: "png",
    fullPage: false,
    animations: "disabled",
    scale: "css",
  });

  return { image };
}

function normalizeRenderedText(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map(normalizeInline)
    .filter(Boolean);

  const result: string[] = [];
  for (const line of lines) {
    if (result.at(-1) !== line) result.push(line);
  }
  return result.join("\n");
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
