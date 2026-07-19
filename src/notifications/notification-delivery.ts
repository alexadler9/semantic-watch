import { InputFile, type Api } from "grammy";
import type { PendingNotification, Watch } from "../domain/models.js";
import type { VisualEvidenceService } from "../visual/visual-evidence-service.js";
import {
  formatImportantChange,
  importantNotificationKeyboard,
} from "./telegram-messages.js";

export async function deliverImportantNotification(input: {
  api: Api;
  chatId: string | number;
  watch: Watch;
  notification: PendingNotification;
  visualEvidence: VisualEvidenceService;
}): Promise<void> {
  const text = formatImportantChange(input.watch, input.notification);
  const keyboard = importantNotificationKeyboard(input.watch, input.notification);
  let delivered = false;

  try {
    const image = await input.visualEvidence.readPrepared(input.notification.visualFilePath);
    if (image) {
      try {
        if (text.length <= 1024) {
          await input.api.sendPhoto(
            input.chatId,
            new InputFile(image, `semantic-watch-${input.notification.id}.png`),
            {
              caption: text,
              reply_markup: keyboard,
            },
          );
          delivered = true;
          return;
        }

        await input.api.sendMessage(input.chatId, text, {
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        });
        try {
          await input.api.sendPhoto(
            input.chatId,
            new InputFile(image, `semantic-watch-${input.notification.id}.png`),
          );
        } catch (error) {
          console.warn("Text notification was delivered, but its captured image could not be sent.", {
            watchId: input.watch.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        delivered = true;
        return;
      } catch (error) {
        console.warn("Captured page image could not be sent; sending text notification instead.", {
          watchId: input.watch.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await input.api.sendMessage(input.chatId, text, {
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    delivered = true;
  } finally {
    if (delivered) {
      await input.visualEvidence
        .removePrepared(input.notification.visualFilePath)
        .catch((error: unknown) => {
          console.warn("Could not remove delivered visual cache file.", {
            watchId: input.watch.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}
