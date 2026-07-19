import { truncate } from "../utils/text.js";

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
    };
  }>;
}

export class DeepSeekClient {
  constructor(private readonly options: DeepSeekClientOptions) {}

  async requestJson(systemPrompt: string, userPrompt: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          temperature: 0.1,
          max_tokens: 1200,
          stream: false,
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`DeepSeek returned HTTP ${response.status}: ${truncate(raw, 300)}`);
      }

      const completion = JSON.parse(raw) as ChatCompletionResponse;
      const choice = completion.choices?.[0];
      if (!choice) {
        throw new Error("DeepSeek response does not contain a completion choice.");
      }
      if (choice.finish_reason === "length") {
        throw new Error("DeepSeek JSON response was truncated by the token limit.");
      }

      const content = choice.message?.content?.trim();
      if (!content) {
        throw new Error("DeepSeek returned an empty JSON response.");
      }

      try {
        return JSON.parse(content) as unknown;
      } catch {
        throw new Error("DeepSeek returned invalid JSON content.");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("DeepSeek request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
