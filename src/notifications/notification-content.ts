import type {
  NotificationFact,
  NotificationMessageBlock,
  NotificationMessagePart,
  WatchPolicy,
} from "../domain/models.js";
import { normalizeEvidenceText } from "../evidence/evidence-grounding.js";

export function sanitizeNotificationBlocks(input: {
  blocks: NotificationMessageBlock[];
  facts: NotificationFact[];
  instruction: string;
  policy: WatchPolicy;
}): NotificationMessageBlock[] {
  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const usedFactIds = new Set<string>();
  const context = [
    input.instruction,
    input.policy.requestedOutput ?? "",
    input.policy.notificationInstruction ?? "",
  ].join("\n");
  const result: NotificationMessageBlock[] = [];

  for (const block of input.blocks) {
    if (result.length >= 8) break;

    switch (block.type) {
      case "PARAGRAPH": {
        const parts: NotificationMessagePart[] = [];
        const blockFactIds = new Set<string>();
        for (const part of block.parts) {
          if (part.kind === "FACT") {
            if (!factsById.has(part.factId) || usedFactIds.has(part.factId)) continue;
            blockFactIds.add(part.factId);
            parts.push({ kind: "FACT", factId: part.factId });
            continue;
          }

          const text = sanitizeLiteralText(part.text, context, input.facts);
          if (text) parts.push({ kind: "TEXT", text });
        }
        if (blockFactIds.size === 0) break;
        for (const factId of blockFactIds) usedFactIds.add(factId);
        result.push({ type: "PARAGRAPH", parts: trimDanglingTextParts(parts) });
        break;
      }

      case "LIST": {
        const factIds = uniqueAvailableFactIds(block.factIds, factsById, usedFactIds);
        if (factIds.length === 0) break;
        factIds.forEach((id) => usedFactIds.add(id));
        result.push({
          type: "LIST",
          title: sanitizeHeading(block.title),
          factIds,
        });
        break;
      }

      case "KEY_VALUE": {
        const rows: Array<{ label: string; factId: string }> = [];
        for (const row of block.rows) {
          if (!factsById.has(row.factId) || usedFactIds.has(row.factId)) continue;
          const label = sanitizeHeading(row.label) ?? factsById.get(row.factId)?.label;
          if (!label) continue;
          usedFactIds.add(row.factId);
          rows.push({ label, factId: row.factId });
        }
        if (rows.length === 0) break;
        result.push({
          type: "KEY_VALUE",
          title: sanitizeHeading(block.title),
          rows,
        });
        break;
      }

      case "QUOTE": {
        if (!factsById.has(block.factId) || usedFactIds.has(block.factId)) break;
        usedFactIds.add(block.factId);
        result.push({ type: "QUOTE", factId: block.factId });
        break;
      }
    }
  }

  if (result.length > 0) return result;
  return fallbackBlocks(input.facts, input.policy.requestedOutput);
}

export function renderNotificationBlocks(
  facts: NotificationFact[],
  blocks: NotificationMessageBlock[],
): string | null {
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const rendered: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "PARAGRAPH": {
        const text = renderParagraph(block.parts, factsById);
        if (text) rendered.push(text);
        break;
      }
      case "LIST": {
        const items = block.factIds.flatMap((id) => {
          const value = factsById.get(id)?.value;
          return value ? [`• ${value}`] : [];
        });
        if (items.length === 0) break;
        rendered.push([...(block.title ? [`${block.title}:`] : []), ...items].join("\n"));
        break;
      }
      case "KEY_VALUE": {
        const rows = block.rows.flatMap((row) => {
          const value = factsById.get(row.factId)?.value;
          return value ? [`${row.label}: ${value}`] : [];
        });
        if (rows.length === 0) break;
        rendered.push([...(block.title ? [block.title] : []), ...rows].join("\n"));
        break;
      }
      case "QUOTE": {
        const value = factsById.get(block.factId)?.value;
        if (value) rendered.push(`«${value}»`);
        break;
      }
    }
  }

  const text = rendered.join("\n\n").trim();
  return text || null;
}

export function notificationFactValues(facts: NotificationFact[]): string[] {
  return facts.map((fact) => fact.value);
}

function renderParagraph(
  parts: NotificationMessagePart[],
  factsById: Map<string, NotificationFact>,
): string | null {
  let text = "";
  for (const part of parts) {
    if (part.kind === "TEXT") {
      text += part.text;
    } else {
      text += factsById.get(part.factId)?.value ?? "";
    }
  }

  const normalized = text
    .replace(/\s+([,.:;!?%])/g, "$1")
    .replace(/([,;!?])(?=\p{L})/gu, "$1 ")
    .replace(/:(?=[\p{L}\p{N}])/gu, ": ")
    .replace(/\s*→\s*/g, " → ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function uniqueAvailableFactIds(
  ids: string[],
  factsById: Map<string, NotificationFact>,
  usedFactIds: Set<string>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!factsById.has(id) || usedFactIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function fallbackBlocks(
  facts: NotificationFact[],
  requestedOutput: string | null,
): NotificationMessageBlock[] {
  if (facts.length === 0) return [];
  if (facts.length === 1) {
    const first = facts[0];
    return first
      ? [{ type: "PARAGRAPH", parts: [{ kind: "FACT", factId: first.id }] }]
      : [];
  }
  return [
    {
      type: "LIST",
      title: sanitizeHeading(requestedOutput),
      factIds: facts.map((fact) => fact.id),
    },
  ];
}

function sanitizeLiteralText(
  value: string,
  context: string,
  facts: NotificationFact[],
): string | null {
  const compact = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
  if (!compact.trim() || compact.length > 160) return null;

  const normalized = normalizeEvidenceText(compact);
  for (const fact of facts) {
    const normalizedFact = normalizeEvidenceText(fact.value);
    if (normalizedFact.length >= 3 && normalized.includes(normalizedFact)) return null;
  }

  // Dynamic-looking values must be represented by FACT references. A literal
  // containing them is allowed only when it was explicitly written by the user.
  const looksDynamic = /\d|[%$€£₽¥]|\b(?:usd|eur|rub|btc|eth)\b/iu.test(compact);
  const normalizedContext = normalizeEvidenceText(context);
  if (looksDynamic && !normalizedContext.includes(normalized)) return null;

  return compact;
}

function sanitizeHeading(value: string | null | undefined): string | null {
  const normalized = value?.replace(/[:\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117).trimEnd()}…`;
}

function trimDanglingTextParts(parts: NotificationMessagePart[]): NotificationMessagePart[] {
  const firstFactIndex = parts.findIndex((part) => part.kind === "FACT");
  let lastFactIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.kind === "FACT") {
      lastFactIndex = index;
      break;
    }
  }
  if (firstFactIndex < 0 || lastFactIndex < 0) return [];

  const sliced = parts.slice(0, lastFactIndex + 1);
  // Leading labels and punctuation are useful, but orphaned trailing text after
  // a removed fact is not.
  return sliced;
}
