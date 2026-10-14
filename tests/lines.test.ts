import { describe, expect, it } from 'vitest';
import { speakable } from '../src/clean.ts';
import { lineOf } from '../src/world.ts';
import type { EventEnvelope } from 'cortico/core/types.ts';

const selfEvent = (meta: Record<string, unknown>): EventEnvelope => ({
  type: 'desktop-pet.self',
  source: 'desktop-pet',
  origin: 'internal',
  cursor: 7,
  ts: '2026-10-14T10:00:00.000Z',
  text: '',
  meta,
});

describe('speakable', () => {
  it('strips emoji, markup and urls, and keeps the words', () => {
    expect(speakable('你好！😊 今天*真不错*，看 https://example.com/x 这个。'))
      .toBe('你好！ 今天 真不错 ，看 这个。');
  });

  it('returns empty when only noise remains, and caps length', () => {
    expect(speakable('🎉🎉')).toBe('');
    const long = '好'.repeat(700);
    const spoken = speakable(long);
    expect(spoken.length).toBe(602); // 600 + the ellipsis
    expect(spoken.endsWith('……')).toBe(true);
  });
});

describe('lineOf', () => {
  it('joins say beats into one line', () => {
    expect(lineOf(selfEvent({ kind: 'say', beats: [{ text: '你好' }, { text: '今天做什么？' }] }), true))
      .toBe('你好。 今天做什么？');
  });

  it('reads the choices of an ask after the question, or skips them', () => {
    const ask = selfEvent({ kind: 'ask', askId: 'a1', question: '想听故事吗？', options: ['想', '不想'] });
    expect(lineOf(ask, true)).toBe('想听故事吗？。 可选：想；不想');
    expect(lineOf(ask, false)).toBe('想听故事吗？');
  });

  it('says nothing for activity and image-only records', () => {
    expect(lineOf(selfEvent({ kind: 'activity', steps: ['看屏幕'], ms: 120 }), true)).toBe('');
    expect(lineOf(selfEvent({ kind: 'say', beats: [{ text: '' }] }), true)).toBe('');
  });
});
