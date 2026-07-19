import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PageVisualObservation } from "../domain/models.js";

export interface VisualEvidenceOptions {
  screenshotEnabled: boolean;
  cacheDir: string;
}

export class VisualEvidenceService {
  private readonly cacheDir: string;

  constructor(private readonly options: VisualEvidenceOptions) {
    this.cacheDir = resolve(options.cacheDir);
  }

  isScreenshotEnabled(): boolean {
    return this.options.screenshotEnabled;
  }

  async prepareAndStore(input: {
    observation: PageVisualObservation | null;
    imageId: string;
  }): Promise<string | null> {
    if (!this.options.screenshotEnabled || !input.observation) return null;

    await mkdir(this.cacheDir, { recursive: true });
    const safeImageId = input.imageId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "result";
    const filePath = resolve(this.cacheDir, `${safeImageId}.png`);
    if (dirname(filePath) !== this.cacheDir) {
      throw new Error("Invalid visual cache file path.");
    }

    await writeFile(filePath, input.observation.image);
    return filePath;
  }

  async readPrepared(filePath: string | null): Promise<Buffer | null> {
    const safePath = this.resolvePreparedPath(filePath);
    if (!safePath) return null;
    try {
      return await readFile(safePath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async removePrepared(filePath: string | null): Promise<void> {
    const safePath = this.resolvePreparedPath(filePath);
    if (!safePath) return;
    await unlink(safePath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  private resolvePreparedPath(filePath: string | null): string | null {
    if (!filePath) return null;
    const resolvedPath = resolve(filePath);
    if (dirname(resolvedPath) !== this.cacheDir || !resolvedPath.toLowerCase().endsWith(".png")) {
      throw new Error("Visual cache path is outside the configured directory.");
    }
    return resolvedPath;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
