export * from './types.js';
export { FakeLlmProvider } from './fakeLlmProvider.js';
export { GeminiLlmProvider } from './geminiLlmProvider.js';
export { DeepSeekLlmProvider } from './deepseekLlmProvider.js';
export { intakeSchema, structureSchema } from './shared.js';

import type { AppConfig } from '../../../config.js';
import { DeepSeekLlmProvider } from './deepseekLlmProvider.js';
import { FakeLlmProvider } from './fakeLlmProvider.js';
import { GeminiLlmProvider } from './geminiLlmProvider.js';
import type { LlmProvider } from './types.js';

export type LlmProviderName = 'fake' | 'gemini' | 'deepseek';

export function resolveLlmProviderName(config: AppConfig): LlmProviderName {
  if (config.LLM_PROVIDER === 'fake') return 'fake';
  if (config.LLM_PROVIDER === 'deepseek') return 'deepseek';
  if (config.LLM_PROVIDER === 'gemini') return 'gemini';
  // auto
  if (!config.USE_FAKE_PROVIDERS && config.DEEPSEEK_API_KEY) return 'deepseek';
  if (!config.USE_FAKE_PROVIDERS && config.GEMINI_API_KEY) return 'gemini';
  return 'fake';
}

export function createLlmProvider(config: AppConfig): LlmProvider {
  const name = resolveLlmProviderName(config);
  if (name === 'deepseek') {
    if (!config.DEEPSEEK_API_KEY) {
      throw new Error('LLM_PROVIDER=deepseek requires DEEPSEEK_API_KEY');
    }
    return new DeepSeekLlmProvider(config.DEEPSEEK_API_KEY, config.DEEPSEEK_MODEL);
  }
  if (name === 'gemini') {
    if (!config.GEMINI_API_KEY) {
      throw new Error('LLM_PROVIDER=gemini requires GEMINI_API_KEY');
    }
    return new GeminiLlmProvider(config.GEMINI_API_KEY);
  }
  return new FakeLlmProvider();
}
