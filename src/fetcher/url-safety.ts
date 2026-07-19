import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface UrlSafetyOptions {
  demoMode: boolean;
  demoUrl: string;
}

export class UrlSafetyGuard {
  private readonly demoUrl: URL;
  private readonly safeHostCache = new Map<string, { expiresAt: number; validation: Promise<void> }>();

  constructor(private readonly options: UrlSafetyOptions) {
    this.demoUrl = new URL(options.demoUrl);
  }

  async normalizeUserUrl(raw: string): Promise<string> {
    const url = normalizeUrl(raw);
    await this.assertAllowed(url, true);
    return url.toString();
  }

  async assertBrowserRequestAllowed(raw: string): Promise<void> {
    const url = new URL(raw);
    await this.assertAllowed(url, false);
  }

  isBrowserInternalUrl(raw: string): boolean {
    return raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("about:");
  }

  private async assertAllowed(url: URL, userProvided: boolean): Promise<void> {
    validateUrlShape(url);

    if (this.isAllowedDemoUrl(url, userProvided)) {
      return;
    }

    if (isIP(url.hostname) > 0) {
      if (isForbiddenAddress(url.hostname)) {
        throw new Error("The URL points to a private or non-routable network address.");
      }
      return;
    }

    const cacheKey = `${url.hostname.toLowerCase()}:${url.port || defaultPort(url.protocol)}`;
    const now = Date.now();
    let cached = this.safeHostCache.get(cacheKey);
    if (!cached || cached.expiresAt <= now) {
      const validation = validateResolvedHost(url.hostname);
      cached = { expiresAt: now + 30_000, validation };
      this.safeHostCache.set(cacheKey, cached);
      validation.catch(() => this.safeHostCache.delete(cacheKey));
    }
    await cached.validation;
  }

  private isAllowedDemoUrl(url: URL, userProvided: boolean): boolean {
    if (!this.options.demoMode) return false;
    if (userProvided) return url.toString() === this.demoUrl.toString();
    return url.origin === this.demoUrl.origin;
  }
}

async function validateResolvedHost(hostname: string): Promise<void> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("The hostname did not resolve to an IP address.");
  }
  if (addresses.some((entry) => isForbiddenAddress(entry.address))) {
    throw new Error("The URL resolves to a private or non-routable network address.");
  }
}

function normalizeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Invalid URL.");
  }
  url.hash = "";
  return url;
}

function validateUrlShape(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isForbiddenIpv4(address);
  if (version === 6) return isForbiddenIpv6(address);
  return true;
}

function isForbiddenIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isForbiddenIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);
    return isIP(mappedIpv4) === 4 ? isForbiddenIpv4(mappedIpv4) : true;
  }
  return false;
}
