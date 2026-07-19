import { lookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { extractPageContent } from "./content-extractor.js";
import { sha256 } from "../utils/hash.js";
import type { PageSnapshot } from "../domain/models.js";

export interface SafePageFetcherOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  maxPageTextChars: number;
  demoMode: boolean;
  demoUrl: string;
  maxRedirects?: number;
}

export class SafePageFetcher {
  private readonly maxRedirects: number;

  constructor(private readonly options: SafePageFetcherOptions) {
    this.maxRedirects = options.maxRedirects ?? 3;
  }

  async fetch(url: string): Promise<PageSnapshot> {
    const requestedUrl = normalizeUrl(url);
    const response = await this.download(requestedUrl, 0);
    const extracted = extractPageContent(response.body, this.options.maxPageTextChars);

    return {
      requestedUrl,
      finalUrl: response.finalUrl,
      title: extracted.title,
      text: extracted.text,
      hash: sha256(extracted.text),
      fetchedAt: new Date().toISOString(),
    };
  }

  private async download(url: string, redirectCount: number): Promise<DownloadResult> {
    if (redirectCount > this.maxRedirects) {
      throw new Error("Too many redirects.");
    }

    const parsedUrl = new URL(url);
    this.validateUrlShape(parsedUrl);
    const allowLocalDemo = this.isExactDemoUrl(parsedUrl);
    if (!allowLocalDemo && isIP(parsedUrl.hostname) > 0 && isForbiddenAddress(parsedUrl.hostname)) {
      throw new Error("The URL points to a private or non-routable network address.");
    }

    const response = await requestUrl({
      url: parsedUrl,
      timeoutMs: this.options.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes,
      allowLocalDemo,
    });

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const locationHeader = response.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      if (!location) {
        throw new Error("Redirect response does not include a Location header.");
      }
      const nextUrl = new URL(location, parsedUrl).toString();
      return this.download(nextUrl, redirectCount + 1);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Page returned HTTP ${response.statusCode}.`);
    }

    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (!isSupportedContentType(contentType)) {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}.`);
    }

    return {
      finalUrl: parsedUrl.toString(),
      body: response.body,
    };
  }

  private validateUrlShape(url: URL): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP and HTTPS URLs are supported.");
    }
    if (url.username || url.password) {
      throw new Error("URLs with embedded credentials are not allowed.");
    }
    if (url.port && Number(url.port) <= 0) {
      throw new Error("Invalid URL port.");
    }
  }

  private isExactDemoUrl(url: URL): boolean {
    return this.options.demoMode && url.toString() === new URL(this.options.demoUrl).toString();
  }
}

interface DownloadResult {
  finalUrl: string;
  body: string;
}

interface RawResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface RequestUrlOptions {
  url: URL;
  timeoutMs: number;
  maxResponseBytes: number;
  allowLocalDemo: boolean;
}

function requestUrl(options: RequestUrlOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const requestImplementation = options.url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestOptions: RequestOptions = {
      protocol: options.url.protocol,
      hostname: options.url.hostname,
      port: options.url.port || undefined,
      path: `${options.url.pathname}${options.url.search}`,
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        "Accept-Encoding": "identity",
        "User-Agent": "SemanticWatch/0.1 (+page-change-monitor)",
      },
      lookup: createSafeLookup(options.allowLocalDemo),
    };

    const request = requestImplementation(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.length;
        if (receivedBytes > options.maxResponseBytes) {
          request.destroy(new Error("Page response is larger than the configured limit."));
          return;
        }
        chunks.push(buffer);
      });

      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error("Page request timed out."));
    });
    request.on("error", reject);
    request.end();
  });
}

function createSafeLookup(allowLocalDemo: boolean): NonNullable<RequestOptions["lookup"]> {
  return (hostname, options, callback) => {
    const requestedAll = options.all === true;
    const lookupOptions: LookupAllOptions = {
      all: true,
      verbatim: true,
    };
    if (options.family !== undefined) {
      lookupOptions.family = options.family;
    }
    if (options.hints !== undefined) {
      lookupOptions.hints = options.hints;
    }

    lookup(hostname, lookupOptions, (error, addresses) => {
      if (error) {
        callback(error, requestedAll ? [] : "", 0);
        return;
      }
      if (addresses.length === 0) {
        callback(new Error("The hostname did not resolve to an IP address."), requestedAll ? [] : "", 0);
        return;
      }

      if (!allowLocalDemo && addresses.some((entry) => isForbiddenAddress(entry.address))) {
        callback(
          new Error("The URL resolves to a private or non-routable network address."),
          requestedAll ? [] : "",
          0,
        );
        return;
      }

      if (requestedAll) {
        callback(null, addresses);
        return;
      }

      const selected = selectAddress(addresses, options.family);
      callback(null, selected.address, selected.family);
    });
  };
}

function selectAddress(
  addresses: LookupAddress[],
  requestedFamily: number | "IPv4" | "IPv6" | undefined,
): LookupAddress {
  const normalizedFamily = requestedFamily === "IPv4" ? 4 : requestedFamily === "IPv6" ? 6 : requestedFamily;
  if (normalizedFamily === 4 || normalizedFamily === 6) {
    return addresses.find((entry) => entry.family === normalizedFamily) ?? addresses[0]!;
  }
  return addresses[0]!;
}

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid URL.");
  }
  parsed.hash = "";
  return parsed.toString();
}

function isSupportedContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/html") ||
    contentType.startsWith("application/xhtml+xml") ||
    contentType.startsWith("text/plain")
  );
}

function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isForbiddenIpv4(address);
  }
  if (version === 6) {
    return isForbiddenIpv6(address);
  }
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
  if (normalized === "::" || normalized === "::1") {
    return true;
  }
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
