import { z } from "zod";
import type { SemanticEvaluation, WatchPolicy } from "../domain/models.js";
import { JsonStore } from "../storage/json-store.js";
import { DeepSeekClient } from "./deepseek-client.js";

const watchPolicySchema = z.object({
  targetEvent: z.string().min(3).max(500),
  requiredSignals: z.array(z.string().min(2).max(300)).min(1).max(8),
  ignoredChanges: z.array(z.string().min(2).max(300)).max(8),
});

const evaluationSchema = z.object({
  meaningfulChange: z.boolean(),
  conditionMatched: z.boolean(),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(600),
  evidence: z.array(z.string().min(2).max(300)).max(5),
});

export interface SemanticEvaluatorOptions {
  maxLlmCallsPerDay: number;
}

export class SemanticEvaluator {
  constructor(
    private readonly client: DeepSeekClient,
    private readonly store: JsonStore,
    private readonly options: SemanticEvaluatorOptions,
  ) {}

  async createPolicy(instruction: string): Promise<WatchPolicy> {
    await this.reserveCall();
    const payload = await this.client.requestJson(
      POLICY_SYSTEM_PROMPT,
      `Пользовательская инструкция:\n${instruction}`,
    );
    return watchPolicySchema.parse(payload);
  }

  async evaluateChange(input: {
    instruction: string;
    policy: WatchPolicy;
    diff: string;
  }): Promise<SemanticEvaluation> {
    await this.reserveCall();
    const payload = await this.client.requestJson(
      EVALUATION_SYSTEM_PROMPT,
      [
        `Исходная инструкция пользователя:\n${input.instruction}`,
        `\nСтруктурированное правило наблюдения (JSON):\n${JSON.stringify(input.policy, null, 2)}`,
        `\nИзменение текста страницы:\n${input.diff}`,
      ].join("\n"),
    );
    return evaluationSchema.parse(payload);
  }

  private async reserveCall(): Promise<void> {
    const reservation = await this.store.reserveLlmCall(this.options.maxLlmCallsPerDay);
    if (!reservation.allowed) {
      throw new Error(`Daily AI request limit reached: ${this.options.maxLlmCallsPerDay}.`);
    }
  }
}

const POLICY_SYSTEM_PROMPT = `
Ты формируешь правило семантического мониторинга веб-страницы.
Верни только один JSON-объект без markdown и пояснений.

Нужно понять:
- какое изменение пользователь считает целевым событием;
- какие признаки подтверждают, что событие действительно произошло;
- какие изменения пользователь просит игнорировать.

Не добавляй конкретные факты, которых нет в инструкции. Формулируй признаки обобщённо.

Пример JSON:
{
  "targetEvent": "Открылась регистрация для участников",
  "requiredSignals": [
    "появилась возможность зарегистрироваться",
    "появилась активная форма или кнопка регистрации"
  ],
  "ignoredChanges": [
    "изменения списка спикеров",
    "изменения программы"
  ]
}
`.trim();

const EVALUATION_SYSTEM_PROMPT = `
Ты оцениваешь изменение текста веб-страницы относительно пользовательского условия.
Верни только один JSON-объект без markdown и пояснений.

Правила:
- conditionMatched=true только если добавленный или изменённый текст подтверждает целевое событие;
- не считай намерение, обещание или будущую дату фактом наступления события;
- учитывай ignoredChanges;
- evidence содержит 1-5 коротких ТОЧНЫХ цитат только из строк с префиксом "+" в предоставленном diff;
- если условие не выполнено, evidence должен быть пустым;
- confidence — число от 0 до 1;
- summary — краткое объяснение на русском языке.

Пример JSON:
{
  "meaningfulChange": true,
  "conditionMatched": true,
  "confidence": 0.93,
  "summary": "На странице открылась регистрация участников",
  "evidence": ["Регистрация открыта", "Зарегистрироваться"]
}
`.trim();
