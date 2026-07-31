import type { AppConfig } from '../../../config.js';
import { FakeLlmProvider } from './fakeLlmProvider.js';
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

export class GeminiLlmProvider implements LlmProvider {
  constructor(private readonly apiKey: string) {}

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

  private async generateJson(prompt: string): Promise<unknown> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) {
      throw new Error(`Gemini API failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned empty response');
    return extractJsonObject(text);
  }
}

export { intakeSchema, structureSchema };
