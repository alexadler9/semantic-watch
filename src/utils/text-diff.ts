import { truncate } from "./text.js";

export function buildTextDiff(previousText: string, currentText: string, maxChars: number): string {
  const previousLines = splitLines(previousText);
  const currentLines = splitLines(currentText);
  const previousCounts = countLines(previousLines);
  const currentCounts = countLines(currentLines);

  const removed = subtractLines(previousLines, currentCounts);
  const added = subtractLines(currentLines, previousCounts);

  const sections: string[] = [];
  if (removed.length > 0) {
    sections.push(`REMOVED:\n${removed.map((line) => `- ${line}`).join("\n")}`);
  }
  if (added.length > 0) {
    sections.push(`ADDED:\n${added.map((line) => `+ ${line}`).join("\n")}`);
  }
  if (sections.length === 0) {
    sections.push("The normalized lines are the same, but their order or formatting changed.");
  }

  return truncate(sections.join("\n\n"), maxChars);
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function subtractLines(lines: string[], available: Map<string, number>): string[] {
  const remaining = new Map(available);
  const result: string[] = [];
  for (const line of lines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
    } else {
      result.push(line);
    }
  }
  return result;
}
