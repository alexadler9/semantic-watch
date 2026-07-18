import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const state = process.argv[2];
const allowedStates = new Set(["closed", "speakers", "open"]);
if (!state || !allowedStates.has(state)) {
  console.error("Usage: tsx demo-site/switch-state.ts <closed|speakers|open>");
  process.exit(1);
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const source = join(currentDirectory, "states", `${state}.html`);
const target = join(currentDirectory, "current.html");
await copyFile(source, target);
console.log(`Conference page state switched to: ${state}`);
