/**
 * The voice half's data: which voices the dropdown offers, and how a voice pack becomes the
 * settings the speaker gets. The service's own voice list is the reference — a voice it stopped
 * serving must not stay in the list, or picking it leaves the pet silent.
 */
import { describe, expect, it } from 'vitest';
import {
  PRESET_OPTIONS_KIND,
  VOICE_OPTIONS_KIND,
  FATFISH_DEFAULTS,
  presetOptionRows,
  resolveSpeak,
  voiceOptionRows,
} from '../src/config.ts';
import { CUSTOM_PRESET, VOICE_OPTIONS, VOICE_PRESETS } from '../src/voices.ts';

describe('the voice list', () => {
  it('offers every Chinese voice the service still serves', () => {
    const ids = VOICE_OPTIONS.map((voice) => voice.id);
    for (const id of [
      'zh-CN-XiaoxiaoNeural',
      'zh-CN-XiaoyiNeural',
      'zh-CN-YunxiNeural',
      'zh-CN-YunyangNeural',
      'zh-CN-YunjianNeural',
      'zh-CN-YunxiaNeural',
      'zh-CN-liaoning-XiaobeiNeural',
      'zh-CN-shaanxi-XiaoniNeural',
      'zh-TW-HsiaoChenNeural',
      'zh-TW-HsiaoYuNeural',
      'zh-TW-YunJheNeural',
      'zh-HK-HiuMaanNeural',
      'zh-HK-HiuGaaiNeural',
      'zh-HK-WanLungNeural',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('drops the voice the service no longer serves', () => {
    expect(VOICE_OPTIONS.map((voice) => voice.id)).not.toContain('zh-CN-XiaomoNeural');
  });

  it('serves its rows under the kind the dropdown asks for', () => {
    expect(voiceOptionRows().find((row) => row.value === 'zh-CN-XiaoxiaoNeural')?.label).toContain('晓晓');
  });
});

describe('voice packs', () => {
  it('lists custom first, then every pack, in the app language', () => {
    const rows = presetOptionRows('zh');
    expect(rows[0]).toEqual({ value: CUSTOM_PRESET, label: '自定义' });
    expect(rows.map((row) => row.value)).toContain(VOICE_PRESETS[0].id);
    expect(presetOptionRows('en')[0].label).toBe('Custom');
    expect(presetOptionRows('en').find((row) => row.value === 'warm')?.label).toBe('Warm · Xiaoxiao');
  });

  it('gives the pack settings when one is chosen', () => {
    const pack = VOICE_PRESETS.find((candidate) => candidate.id === 'broadcast')!;
    expect(
      resolveSpeak({ ...FATFISH_DEFAULTS, preset: 'broadcast', voice: 'zh-CN-XiaoyiNeural' }),
    ).toEqual({ voice: pack.voice, rate: pack.rate, volume: pack.volume, pitch: pack.pitch });
  });

  it('uses the four custom settings when custom is chosen', () => {
    expect(
      resolveSpeak({
        ...FATFISH_DEFAULTS,
        preset: CUSTOM_PRESET,
        voice: 'zh-TW-YunJheNeural',
        rate: '+15%',
        volume: '+20%',
        pitch: '-10Hz',
      }),
    ).toEqual({ voice: 'zh-TW-YunJheNeural', rate: '+15%', volume: '+20%', pitch: '-10Hz' });
  });

  it('falls back to the custom settings for a pack id it does not know', () => {
    expect(resolveSpeak({ ...FATFISH_DEFAULTS, preset: 'gone', voice: 'zh-CN-YunxiNeural' }).voice).toBe(
      'zh-CN-YunxiNeural',
    );
  });

  it('fills defaults for a config written before the pack existed', () => {
    expect(resolveSpeak({ voice: '', rate: '', volume: '' })).toEqual({
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      volume: '+0%',
      pitch: '+0Hz',
    });
  });
});

describe('the config schema', () => {
  it('names both dropdowns so the framework can serve their rows', () => {
    expect(VOICE_OPTIONS_KIND).toBe('fatfish.voices');
    expect(PRESET_OPTIONS_KIND).toBe('fatfish.presets');
  });
});
