import { z } from "zod";
import type { SemanticEvaluation, WatchPolicy } from "../domain/models.js";
import { JsonStore } from "../storage/json-store.js";
import { DeepSeekClient } from "./deepseek-client.js";

const watchPolicySchema = z.object({
  targetEvent: z.string().trim().min(3).max(500),
  requiredSignals: z.array(z.string().trim().min(2).max(300)).min(1).max(8),
  ignoredChanges: z.array(z.string().trim().min(2).max(300)).max(8),
});

// Сначала разбираем ответ мягко, чтобы пустые признаки трактовать как просьбу уточнить задачу,
// а не показывать пользователю внутреннюю ошибку валидации.
const policyEnvelopeSchema = z.object({
  understood: z.boolean().optional(),
  targetEvent: z.string().optional(),
  requiredSignals: z.array(z.string()).optional(),
  ignoredChanges: z.array(z.string()).optional(),
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

export class PolicyNotUnderstoodError extends Error {
  constructor() {
    super("Не удалось понять, что именно нужно отслеживать.");
    this.name = "PolicyNotUnderstoodError";
  }
}

export class PolicyResponseError extends Error {
  constructor(cause?: unknown) {
    super("AI вернул некорректное правило отслеживания.", { cause });
    this.name = "PolicyResponseError";
  }
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

    const envelope = policyEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new PolicyResponseError(envelope.error);
    }

    const value = envelope.data;
    const targetEvent = value.targetEvent?.trim() ?? "";
    const requiredSignals = (value.requiredSignals ?? []).map((item) => item.trim()).filter(Boolean);
    const ignoredChanges = (value.ignoredChanges ?? []).map((item) => item.trim()).filter(Boolean);

    if (value.understood === false || targetEvent.length < 3 || requiredSignals.length === 0) {
      throw new PolicyNotUnderstoodError();
    }

    const parsed = watchPolicySchema.safeParse({
      targetEvent,
      requiredSignals,
      ignoredChanges,
    });
    if (!parsed.success) {
      throw new PolicyResponseError(parsed.error);
    }
    return parsed.data;
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
        `\nСтруктурированное правило отслеживания (JSON):\n${JSON.stringify(input.policy, null, 2)}`,
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
Ты формируешь правило семантического отслеживания веб-страницы.
Верни только один JSON-объект без markdown и пояснений.

Сначала оцени, удалось ли понять конкретную цель пользователя.
Если текст бессмысленный, состоит из случайных слов или не содержит того, что нужно искать на странице, верни:
{
  "understood": false
}

Если цель понятна, верни:
{
  "understood": true,
  "targetEvent": "краткое описание того, что нужно обнаружить",
  "requiredSignals": ["минимум один проверяемый признак"],
  "ignoredChanges": ["то, что пользователь просит не учитывать"]
}

Правила:
- requiredSignals всегда содержит хотя бы один содержательный признак;
- не выдумывай конкретные факты, которых нет в инструкции;
- формулируй признаки обобщённо;
- если пользователь не назвал игнорируемые обновления, верни пустой ignoredChanges;
- не пытайся придать смысл случайному или слишком общему набору слов.

Пример:
{
  "understood": true,
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
