import { InlineKeyboard } from "grammy";
import type { SemanticEvaluation, Watch } from "../domain/models.js";

export function formatImportantChange(
  watch: Pick<Watch, "url">,
  evaluation: Pick<SemanticEvaluation, "summary" | "evidence">,
  duplicate = false,
): string {
  const header = duplicate
    ? "Этот результат уже отправлялся ранее."
    : "На странице появилась нужная информация.";

  return [
    header,
    "",
    evaluation.summary,
    "",
    "Подтверждение на странице:",
    ...evaluation.evidence.map((quote) => `• ${quote}`),
  ].join("\n");
}

export function importantNotificationKeyboard(
  watch: Pick<Watch, "id" | "url">,
): InlineKeyboard {
  return new InlineKeyboard()
    .url("Открыть страницу", watch.url)
    .row()
    .text("Приостановить отслеживание", `notification:pause:${watch.id}`);
}
