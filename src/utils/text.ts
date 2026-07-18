export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function normalizeInstruction(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
