import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolveLlmProviderName } from '../src/infrastructure/providers/llm/index.js';

describe('LLM provider selection', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/test',
    DEVICE_AUTH_PEPPER: 'test-pepper-abcdefgh',
  };

  it('uses deepseek when LLM_PROVIDER=deepseek even if USE_FAKE_PROVIDERS', () => {
    const config = loadConfig({
      ...process.env,
      ...base,
      USE_FAKE_PROVIDERS: 'true',
      LLM_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'sk-test',
    } as NodeJS.ProcessEnv);
    expect(resolveLlmProviderName(config)).toBe('deepseek');
  });

  it('stays fake under auto + USE_FAKE_PROVIDERS even with DeepSeek key', () => {
    const config = loadConfig({
      ...process.env,
      ...base,
      USE_FAKE_PROVIDERS: 'true',
      LLM_PROVIDER: 'auto',
      DEEPSEEK_API_KEY: 'sk-test',
    } as NodeJS.ProcessEnv);
    expect(resolveLlmProviderName(config)).toBe('fake');
  });

  it('auto picks deepseek when fake providers off', () => {
    const config = loadConfig({
      ...process.env,
      ...base,
      USE_FAKE_PROVIDERS: 'false',
      LLM_PROVIDER: 'auto',
      DEEPSEEK_API_KEY: 'sk-test',
    } as NodeJS.ProcessEnv);
    expect(resolveLlmProviderName(config)).toBe('deepseek');
  });
});
