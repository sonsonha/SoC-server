import type {
  IntakeInterpretation,
  LlmProvider,
  PreparationStructure,
} from './types.js';
import {
  extractJsonObject,
  INTAKE_JSON_PROMPT,
  intakeSchema,
  normalizeIntake,
  structureJsonPrompt,
  structureSchema,
} from './shared.js';

/**
 * DeepSeek via OpenAI-compatible Chat Completions.
 * Docs: https://api-docs.deepseek.com/ — base https://api.deepseek.com
 */
export class DeepSeekLlmProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'deepseek-chat',
    private readonly baseUrl: string = 'https://api.deepseek.com',
  ) {}

  async interpretIntake(text: string, context: string): Promise<IntakeInterpretation> {
    const prompt = `${INTAKE_JSON_PROMPT}\n\nContext:\n${context}\n\nUser text:\n${text}`;
    const raw = await this.generateJson(prompt);
    return normalizeIntake(intakeSchema.parse(raw));
  }

  async structurePreparation(input: {
    topic: string;
    timeBudgetMinutes: number;
    candidate: { title: string; url: string; snippet: string };
  }): Promise<PreparationStructure> {
    const raw = await this.generateJson(structureJsonPrompt(input));
    return structureSchema.parse(raw);
  }

  async structureGoal(prompt: string): Promise<unknown> {
    return this.generateJson(prompt);
  }

  private async generateJson(prompt: string): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a precise JSON API. Reply with a single JSON object only — no markdown.',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DeepSeek API failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('DeepSeek returned empty response');
    return extractJsonObject(text);
  }
}
