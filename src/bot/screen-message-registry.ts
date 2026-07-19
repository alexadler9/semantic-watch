interface ScreenMessageState {
  messageId: number;
  separatedByPermanentMessage: boolean;
}

/**
 * Tracks the single transient UI message used by the interactive bot screens.
 * Permanent result notifications are deliberately not registered here.
 */
export class ScreenMessageRegistry {
  private readonly screens = new Map<string, ScreenMessageState>();

  get(userId: string): number | undefined {
    return this.screens.get(userId)?.messageId;
  }

  set(userId: string, messageId: number): this {
    const current = this.screens.get(userId);
    this.screens.set(userId, {
      messageId,
      separatedByPermanentMessage:
        current?.messageId === messageId
          ? current.separatedByPermanentMessage
          : false,
    });
    return this;
  }

  delete(userId: string): boolean {
    return this.screens.delete(userId);
  }

  markSeparatedByPermanentMessage(userId: string): void {
    const current = this.screens.get(userId);
    if (!current) return;
    current.separatedByPermanentMessage = true;
  }

  isSeparatedByPermanentMessage(userId: string, messageId: number): boolean {
    const current = this.screens.get(userId);
    return (
      current?.messageId === messageId &&
      current.separatedByPermanentMessage
    );
  }
}
