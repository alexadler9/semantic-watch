import { InlineKeyboard } from "grammy";
import type { PendingNotification, SemanticEvaluation, Watch } from "../domain/models.js";
import { renderNotificationBlocks } from "./notification-content.js";

export function formatImportantChange(
  _watch: Pick<Watch, "url" | "policy">,
  evaluation: Pick<
    SemanticEvaluation,
    | "summary"
    | "notificationFacts"
    | "notificationBlocks"
    | "resultTitle"
    | "resultItems"
    | "evidence"
  >,
  duplicate = false,
): string {
  const header = duplicate
    ? "Этот результат уже отправлялся ранее."
    : "На странице появилась нужная информация.";

  const renderedContent = renderNotificationBlocks(
    evaluation.notificationFacts,
    evaluation.notificationBlocks,
  );

  // Structured content replaces summary instead of being appended to it. This
  // prevents the same price, percentage or list item from appearing twice.
  return [header, "", renderedContent ?? evaluation.summary].join("\n");
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
