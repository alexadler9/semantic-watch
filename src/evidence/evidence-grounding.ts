import type { NotificationFact } from "../domain/models.js";

export interface GroundEvidenceInput {
  aiEvidence: string[];
  currentText: string;
  diff: string;
  maxItems?: number;
}

export interface GroundResultItemsInput {
  aiItems: string[];
  currentText: string;
  diff: string;
  maxItems?: number;
}

export interface GroundNotificationFactsInput {
  aiFacts: NotificationFact[];
  currentText: string;
  diff: string;
  maxItems?: number;
}

interface RankedEvidence {
  text: string;
  score: number;
}

export function groundEvidence(input: GroundEvidenceInput): string[] {
  const maxItems = input.maxItems ?? 3;
  const pageLines = splitMeaningfulLines(input.currentText);
  const pageText = normalizeEvidenceText(input.currentText);
  const ranked = new Map<string, RankedEvidence>();

  for (const rawCandidate of input.aiEvidence) {
    const candidate = sanitizeEvidenceCandidate(rawCandidate);
    const grounded = findGroundedPageFragment(candidate, pageLines, pageText);
    if (!grounded) continue;
    addRanked(ranked, grounded, evidenceScore(grounded) + 1_000);
  }

  for (const addedLine of extractAddedDiffLines(input.diff)) {
    const grounded = findGroundedPageFragment(addedLine, pageLines, pageText);
    if (!grounded) continue;
    addRanked(ranked, grounded, evidenceScore(grounded));
  }

  const ordered = [...ranked.values()].sort((left, right) => right.score - left.score);
  const informative = ordered.filter((item) => isInformativeEvidence(item.text));
  return (informative.length > 0 ? informative : ordered)
    .slice(0, maxItems)
    .map((item) => item.text);
}

// Пользовательские данные сохраняют порядок AI-ответа, но каждый пункт должен
// подтверждаться текущей страницей либо одной из реальных строк diff.
export function groundResultItems(input: GroundResultItemsInput): string[] {
  const maxItems = input.maxItems ?? 12;
  const pageLines = splitMeaningfulLines(input.currentText);
  const pageText = normalizeEvidenceText(input.currentText);
  const diffLines = extractChangedDiffLines(input.diff);
  const result: string[] = [];
  const seen = new Set<string>();

  for (const rawItem of input.aiItems) {
    const candidates = evidenceSearchCandidates([rawItem]);
    let grounded: string | null = null;

    for (const candidate of candidates) {
      grounded =
        findGroundedPageFragment(candidate, pageLines, pageText) ??
        findGroundedLineFragment(candidate, diffLines);
      if (grounded) break;
    }

    if (!grounded) continue;
    const normalized = normalizeEvidenceText(grounded);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimResultItemLength(grounded));
    if (result.length >= maxItems) break;
  }

  return result;
}

// Значение факта остаётся компактным, если оно буквально присутствует в
// странице или diff. Это важно для чисел: строка "64 548 USD" не должна
// разрастаться до всей строки виджета с объёмом и временем обновления.
export function groundNotificationFacts(input: GroundNotificationFactsInput): NotificationFact[] {
  const maxItems = input.maxItems ?? 16;
  const pageLines = splitMeaningfulLines(input.currentText);
  const pageText = normalizeEvidenceText(input.currentText);
  const diffLines = extractChangedDiffLines(input.diff);
  const normalizedDiff = normalizeEvidenceText(diffLines.join("\n"));
  const result: NotificationFact[] = [];
  const seenIds = new Set<string>();
  const seenValues = new Set<string>();

  for (const fact of input.aiFacts) {
    const id = fact.id.trim();
    const candidate = sanitizeEvidenceCandidate(fact.value);
    if (!id || !candidate || seenIds.has(id)) continue;

    const normalizedCandidate = normalizeEvidenceText(candidate);
    let grounded: string | null = null;
    if (
      normalizedCandidate.length >= 2 &&
      (pageText.includes(normalizedCandidate) || normalizedDiff.includes(normalizedCandidate))
    ) {
      grounded = trimResultItemLength(candidate);
    } else {
      for (const searchCandidate of evidenceSearchCandidates([candidate])) {
        grounded =
          findGroundedPageFragment(searchCandidate, pageLines, pageText) ??
          findGroundedLineFragment(searchCandidate, diffLines);
        if (grounded) break;
      }
    }

    if (!grounded) continue;
    const normalizedGrounded = normalizeEvidenceText(grounded);
    if (!normalizedGrounded || seenValues.has(normalizedGrounded)) continue;

    seenIds.add(id);
    seenValues.add(normalizedGrounded);
    result.push({
      id,
      label: cleanFactLabel(fact.label),
      value: trimResultItemLength(grounded),
    });
    if (result.length >= maxItems) break;
  }

  return result;
}

export function sanitizeEvidenceCandidate(value: string): string {
  let result = value.trim();
  result = result.replace(/^\s*[+•*]\s*/, "");
  result = result.replace(/^\s*[-–—]\s+(?=\p{L}|\p{N})/u, "");
  result = result.replace(/^["'`«»“”]+|["'`«»“”]+$/g, "");
  return result.replace(/\s+/g, " ").trim();
}

export function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

export function isVolatileEvidence(value: string): boolean {
  const normalized = normalizeEvidenceText(value);
  return (
    /^(?:около\s+)?\d+\s*(?:секунд|секунды|секунда|минут|минуты|минута|часов|часа|час|дней|дня|день)\s+назад$/u.test(
      normalized,
    ) ||
    /^(?:сегодня|вчера|только что)$/u.test(normalized)
  );
}

export function evidenceSearchCandidates(evidence: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of evidence) {
    const cleaned = sanitizeEvidenceCandidate(raw);
    if (!cleaned) continue;
    for (const candidate of [cleaned, ...splitCandidate(cleaned)]) {
      const normalized = normalizeEvidenceText(candidate);
      if (normalized.length < 4 || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(candidate);
    }
  }
  return result;
}

function splitMeaningfulLines(value: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of value.split(/\r?\n/)) {
    const line = sanitizeEvidenceCandidate(rawLine);
    const normalized = normalizeEvidenceText(line);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(line);
  }
  return result;
}

function findGroundedPageFragment(
  candidate: string,
  pageLines: string[],
  normalizedPageText: string,
): string | null {
  if (!candidate) return null;
  const normalizedCandidate = normalizeEvidenceText(candidate);
  if (normalizedCandidate.length < 2) return null;

  if (normalizedPageText.includes(normalizedCandidate)) {
    const containingLine = pageLines
      .filter((line) => normalizeEvidenceText(line).includes(normalizedCandidate))
      .sort((left, right) => left.length - right.length)[0];
    return trimEvidenceLength(containingLine ?? candidate);
  }

  return findGroundedLineFragment(candidate, pageLines);
}

function findGroundedLineFragment(candidate: string, lines: string[]): string | null {
  const normalizedCandidate = normalizeEvidenceText(candidate);
  const candidateTokens = meaningfulTokens(normalizedCandidate);
  if (candidateTokens.length < 2) return null;

  let best: { line: string; score: number } | null = null;
  for (const line of lines) {
    const normalizedLine = normalizeEvidenceText(line);
    if (normalizedLine.includes(normalizedCandidate)) {
      return trimEvidenceLength(line);
    }

    const lineTokens = meaningfulTokens(normalizedLine);
    if (lineTokens.length === 0) continue;
    const intersection = candidateTokens.filter((token) => lineTokens.includes(token)).length;
    const coverage = intersection / candidateTokens.length;
    const precision = intersection / lineTokens.length;
    const score = coverage * 0.75 + Math.min(precision, 1) * 0.25;
    const enoughTokens = intersection >= Math.min(3, candidateTokens.length);
    if (!enoughTokens || coverage < 0.78) continue;
    if (!best || score > best.score || (score === best.score && line.length < best.line.length)) {
      best = { line, score };
    }
  }
  return best ? trimEvidenceLength(best.line) : null;
}

function extractAddedDiffLines(diff: string): string[] {
  const result: string[] = [];
  for (const rawLine of diff.split(/\r?\n/)) {
    if (!/^\+\s/.test(rawLine)) continue;
    const line = sanitizeEvidenceCandidate(rawLine);
    if (!line) continue;
    result.push(line);
  }
  return result;
}

function extractChangedDiffLines(diff: string): string[] {
  const result: string[] = [];
  for (const rawLine of diff.split(/\r?\n/)) {
    if (!/^[+-]\s/.test(rawLine)) continue;
    const line = sanitizeEvidenceCandidate(rawLine);
    if (!line) continue;
    result.push(line);
  }
  return result;
}

function isInformativeEvidence(value: string): boolean {
  const tokens = meaningfulTokens(normalizeEvidenceText(value));
  return (
    !isVolatileEvidence(value) &&
    !/^[\p{Lu}\d\s]{3,24}$/u.test(value) &&
    (value.length >= 18 || tokens.length >= 3)
  );
}

function evidenceScore(value: string): number {
  const normalized = normalizeEvidenceText(value);
  const tokens = meaningfulTokens(normalized);
  let score = Math.min(value.length, 240) + tokens.length * 18;
  if (/\d/u.test(value)) score += 12;
  if (/[.!?]/u.test(value)) score += 8;
  if (isVolatileEvidence(value)) score -= 220;
  if (/^[\p{Lu}\d\s]{3,24}$/u.test(value)) score -= 90;
  if (tokens.length <= 1) score -= 80;
  return score;
}

function addRanked(target: Map<string, RankedEvidence>, text: string, score: number): void {
  const normalized = normalizeEvidenceText(text);
  const previous = target.get(normalized);
  if (!previous || score > previous.score) {
    target.set(normalized, { text, score });
  }
}

function meaningfulTokens(value: string): string[] {
  return value.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

function splitCandidate(value: string): string[] {
  return value
    .split(/[\n;|]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

function cleanFactLabel(value: string | null): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= 100 ? normalized : `${normalized.slice(0, 97).trimEnd()}…`;
}

function trimEvidenceLength(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 297).trimEnd()}…`;
}

function trimResultItemLength(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 497).trimEnd()}…`;
}
