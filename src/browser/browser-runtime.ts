import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { UrlSafetyGuard } from "../fetcher/url-safety.js";

export interface BrowserRuntimeOptions {
  timeoutMs: number;
}

export class BrowserRuntime {
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    private readonly safety: UrlSafetyGuard,
    private readonly options: BrowserRuntimeOptions,
  ) {}

  async withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
      locale: "ru-RU",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 SemanticWatch/0.1",
    });

    try {
      await this.protectNetwork(context);
      const page = await context.newPage();
      page.setDefaultTimeout(this.options.timeoutMs);
      page.setDefaultNavigationTimeout(this.options.timeoutMs);
      return await operation(page);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const browserPromise = this.browserPromise;
    this.browserPromise = null;
    if (!browserPromise) return;
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => undefined);
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({ headless: true }).catch((error: unknown) => {
        this.browserPromise = null;
        throw new Error(
          "Не удалось запустить Chromium. Выполните `pnpm exec playwright install chromium`.",
          { cause: error },
        );
      });
    }
    return this.browserPromise;
  }

  private async protectNetwork(context: BrowserContext): Promise<void> {
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (this.safety.isBrowserInternalUrl(requestUrl)) {
        await route.continue();
        return;
      }

      try {
        await this.safety.assertBrowserRequestAllowed(requestUrl);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
  }
}

export async function waitForRenderedPage(page: Page, timeoutMs: number): Promise<void> {
  const networkIdleTimeout = Math.min(4_000, Math.max(1_000, Math.floor(timeoutMs / 3)));
  await page.waitForLoadState("networkidle", { timeout: networkIdleTimeout }).catch(() => undefined);
  await page.waitForTimeout(1_000);
}
