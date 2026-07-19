import { InlineKeyboard } from "grammy";
import type { PendingNotification, SemanticEvaluation, Watch } from "../domain/models.js";

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
  result: Pick<PendingNotification, "id">,
): InlineKeyboard {
  return new InlineKeyboard()
    .text("Да, это оно", `notification:accept:${watch.id}:${result.id}`)
    .text("Не подходит", `notification:reject:${watch.id}:${result.id}`)
    .row()
    .url("Открыть страницу", watch.url)
    .row()
    .text("Приостановить отслеживание", `notification:pause:${watch.id}`);
}

export function resolvedNotificationKeyboard(
  watch: Pick<Watch, "id" | "url" | "status">,
): InlineKeyboard {
  const keyboard = new InlineKeyboard().url("Открыть страницу", watch.url);
  if (watch.status === "ACTIVE") {
    keyboard.row().text("Приостановить отслеживание", `notification:pause:${watch.id}`);
  }
  return keyboard;
}
