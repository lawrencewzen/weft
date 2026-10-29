import { describe, expect, it } from 'vitest';
import {
  defaultEnabledRule,
  formatTokenNum,
  parseContextInput,
  sortAvailableProviders,
} from './providerFormat';
import type { Available } from './providerTypes';

describe('formatTokenNum', () => {
  it('formats null and undefined as unknown', () => {
    expect(formatTokenNum(null)).toBe('未知');
    expect(formatTokenNum(undefined)).toBe('未知');
    expect(formatTokenNum(null, 'Unknown')).toBe('Unknown');
  });

  it('formats exact and decimal millions with M', () => {
    expect(formatTokenNum(1_000_000)).toBe('1M');
    expect(formatTokenNum(2_000_000)).toBe('2M');
    expect(formatTokenNum(1_048_576)).toBe('1.05M');
    expect(formatTokenNum(1_500_000)).toBe('1.5M');
  });

  it('formats thousands with K', () => {
    expect(formatTokenNum(262_144)).toBe('262K');
    expect(formatTokenNum(128_000)).toBe('128K');
    expect(formatTokenNum(65_536)).toBe('66K');
    expect(formatTokenNum(8_192)).toBe('8K');
    expect(formatTokenNum(1_000)).toBe('1K');
  });

  it('formats values under 1000 as integers', () => {
    expect(formatTokenNum(500)).toBe('500');
    expect(formatTokenNum(0)).toBe('0');
  });
});

describe('parseContextInput', () => {
  it('returns null on empty or whitespace input to reset override', () => {
    expect(parseContextInput('')).toBeNull();
    expect(parseContextInput('   ')).toBeNull();
    expect(parseContextInput(null)).toBeNull();
    expect(parseContextInput(undefined)).toBeNull();
  });

  it('parses k and m suffixes case-insensitively', () => {
    expect(parseContextInput('128k')).toBe(128_000);
    expect(parseContextInput('128K')).toBe(128_000);
    expect(parseContextInput(' 256 k ')).toBe(256_000);
    expect(parseContextInput('1m')).toBe(1_000_000);
    expect(parseContextInput('1M')).toBe(1_000_000);
    expect(parseContextInput('1.5m')).toBe(1_500_000);
  });

  it('parses raw integers with optional separators', () => {
    expect(parseContextInput('131072')).toBe(131_072);
    expect(parseContextInput('131,072')).toBe(131_072);
    expect(parseContextInput('1_000_000')).toBe(1_000_000);
    expect(parseContextInput(65536)).toBe(65_536);
  });

  it('returns undefined for invalid or out-of-range inputs', () => {
    expect(parseContextInput('abc')).toBeUndefined();
    expect(parseContextInput('0')).toBeUndefined();
    expect(parseContextInput('-100')).toBeUndefined();
    expect(parseContextInput('500')).toBeUndefined(); // < 1000
    expect(parseContextInput('200000000')).toBeUndefined(); // > 100M
  });
});

describe('defaultEnabledRule', () => {
  it('enables all models when count <= 6', () => {
    expect(defaultEnabledRule(0)).toBe(true);
    expect(defaultEnabledRule(1)).toBe(true);
    expect(defaultEnabledRule(2)).toBe(true);
    expect(defaultEnabledRule(6)).toBe(true);
  });

  it('disables all models when count > 6', () => {
    expect(defaultEnabledRule(7)).toBe(false);
    expect(defaultEnabledRule(17)).toBe(false);
    expect(defaultEnabledRule(44)).toBe(false);
  });
});

describe('sortAvailableProviders', () => {
  it('puts popular providers first, and sorts within groups by name', () => {
    const list: Available[] = [
      { id: 'baseten', name: 'Baseten', authMethods: ['api_key'], modelCount: 10, popular: false, envDetected: false, connected: false },
      { id: 'openai', name: 'OpenAI', authMethods: ['api_key', 'oauth'], modelCount: 44, popular: true, envDetected: false, connected: false },
      { id: 'azure', name: 'Azure', authMethods: ['api_key'], modelCount: 20, popular: false, envDetected: false, connected: false },
      { id: 'deepseek', name: 'DeepSeek', authMethods: ['api_key'], modelCount: 2, popular: true, envDetected: false, connected: false },
    ];

    const sorted = sortAvailableProviders(list);
    expect(sorted.map((item) => item.id)).toEqual(['deepseek', 'openai', 'azure', 'baseten']);
  });
});
