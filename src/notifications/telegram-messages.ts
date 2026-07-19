import type { SemanticEvaluation, Watch } from "../domain/models.js";

export function formatImportantChange(
  watch: Pick<Watch, "url">,
  evaluation: Pick<SemanticEvaluation, "summary" | "evidence">,
  duplicate = false,
): string {
  const header = duplicate
    ? "Это изменение уже было отправлено ранее."
    : "Обнаружено важное изменение.";

  return [
    header,
    "",
    evaluation.summary,
    "",
    "Подтверждение на странице:",
    ...evaluation.evidence.map((quote) => `• ${quote}`),
    "",
    watch.url,
  ].join("\n");
}
