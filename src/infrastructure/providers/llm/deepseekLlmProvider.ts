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

export type DeepSeekUsage = {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export class DeepSeekProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'DeepSeekProviderError';
  }
}

const USER_UNAVAILABLE =
  'AI suggestions are unavailable right now. You can continue manually.';

/**
 * DeepSeek Platform via OpenAI-compatible Chat Completions.
 * Docs: https://api-docs.deepseek.com/ — base https://api.deepseek.com
 * Default Goal Structuring model: deepseek-v4-flash (cheapest; override via DEEPSEEK_MODEL).
 */
export class DeepSeekLlmProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'deepseek-v4-flash',
    private readonly baseUrl: string = 'https://api.deepseek.com',
  ) {}

  async interpretIntake(text: string, context: string): Promise<IntakeInterpretation> {
    const prompt = `${INTAKE_JSON_PROMPT}\n\nContext:\n${context}\n\nUser text:\n${text}`;
    const raw = await this.generateJson(prompt, { thinking: false });
    return normalizeIntake(intakeSchema.parse(raw));
  }

  async structurePreparation(input: {
    topic: string;
    timeBudgetMinutes: number;
    candidate: { title: string; url: string; snippet: string };
  }): Promise<PreparationStructure> {
    const raw = await this.generateJson(structureJsonPrompt(input), { thinking: false });
    return structureSchema.parse(raw);
  }

  /** Goal structuring: JSON object. Pro uses thinking; Flash skips it (cost). */
  async structureGoal(prompt: string): Promise<unknown> {
    const useThinking = !this.model.toLowerCase().includes('flash');
    return this.generateJson(prompt, {
      thinking: useThinking,
      reasoningEffort: useThinking ? 'high' : undefined,
      maxTokens: 16_384,
      oneRetry: true,
    });
  }

  private async generateJson(
    prompt: string,
    opts: {
      thinking: boolean;
      reasoningEffort?: 'low' | 'high' | 'max';
      maxTokens?: number;
      oneRetry?: boolean;
    },
  ): Promise<unknown> {
    const started = Date.now();
    let attempt = 0;
    const maxAttempts = opts.oneRetry ? 2 : 1;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await this.requestJsonOnce(prompt, opts, started, attempt);
      } catch (err) {
        const e = err as DeepSeekProviderError;
        const retryable = e instanceof DeepSeekProviderError && e.retryable && attempt < maxAttempts;
        if (!retryable) throw err;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    throw new DeepSeekProviderError(USER_UNAVAILABLE, 503, 'AI_UNAVAILABLE');
  }

  private async requestJsonOnce(
    prompt: string,
    opts: {
      thinking: boolean;
      reasoningEffort?: 'low' | 'high' | 'max';
      maxTokens?: number;
    },
    started: number,
    attempt: number,
  ): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a precise JSON API for Personal OS Goal structuring. Reply with a single JSON object only — no markdown fences, no prose.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      stream: false,
      temperature: 0.2,
      max_tokens: opts.maxTokens ?? 4_096,
    };
    if (opts.thinking) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = opts.reasoningEffort ?? 'high';
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new DeepSeekProviderError(USER_UNAVAILABLE, 503, 'AI_UNAVAILABLE', true);
    }

    if (res.status === 401 || res.status === 403) {
      console.error('deepseek.auth_failed', { provider: 'deepseek', model: this.model, status: res.status });
      throw new DeepSeekProviderError(USER_UNAVAILABLE, 503, 'AI_UNAVAILABLE', false);
    }
    if (res.status === 429) {
      console.error('deepseek.rate_limited', { provider: 'deepseek', model: this.model, attempt });
      throw new DeepSeekProviderError(USER_UNAVAILABLE, 429, 'AI_RATE_LIMITED', true);
    }
    if (res.status >= 500) {
      console.error('deepseek.upstream_5xx', { provider: 'deepseek', model: this.model, status: res.status, attempt });
      throw new DeepSeekProviderError(USER_UNAVAILABLE, 503, 'AI_UNAVAILABLE', true);
    }
    if (!res.ok) {
      console.error('deepseek.request_failed', {
        provider: 'deepseek',
        model: this.model,
        status: res.status,
        attempt,
      });
      throw new DeepSeekProviderError(USER_UNAVAILABLE, 503, 'AI_UNAVAILABLE', false);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; reasoning_content?: string | null };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      model?: string;
    };

    const usage: DeepSeekUsage = {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
      totalTokens: data.usage?.total_tokens,
    };
    const finishReason = data.choices?.[0]?.finish_reason ?? null;
    console.info('deepseek.completion', {
      provider: 'deepseek',
      model: data.model ?? this.model,
      durationMs: Date.now() - started,
      attempt,
      success: true,
      finishReason,
      thinking: opts.thinking,
      reasoningEffort: opts.thinking ? (opts.reasoningEffort ?? 'high') : null,
      ...usage,
    });

    const text = data.choices?.[0]?.message?.content;
    if (!text?.trim()) {
      console.error('deepseek.empty_content', {
        provider: 'deepseek',
        model: data.model ?? this.model,
        finishReason,
        code: 'AI_JSON_INVALID',
      });
      throw new DeepSeekProviderError(
        'AI returned an invalid suggestion. You can continue manually.',
        502,
        'AI_JSON_INVALID',
        false,
      );
    }

    try {
      return extractJsonObject(text);
    } catch {
      console.error('deepseek.json_invalid', {
        provider: 'deepseek',
        model: data.model ?? this.model,
        finishReason,
        code: 'AI_JSON_INVALID',
        contentLength: text.length,
      });
      throw new DeepSeekProviderError(
        'AI returned an invalid suggestion. You can continue manually.',
        502,
        'AI_JSON_INVALID',
        false,
      );
    }
  }
}
