export function addMinutesIso(value: string | Date, minutes: number): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

export function addSecondsIso(value: string | Date, seconds: number): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + seconds * 1_000).toISOString();
}
