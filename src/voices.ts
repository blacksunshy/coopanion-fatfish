/** The voices the config offers, plus how a config value becomes the metadata Edge TTS expects. */

export interface VoiceOption {
  /** The Edge TTS ShortName, the value stored in the config. */
  id: string;
  /** The human label, in Chinese where one exists. */
  label: string;
}

/** A short list of voices worth picking from; any other Edge TTS ShortName can be typed in by hand. */
export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声 · 温暖' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声 · 活泼' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨 · 女声 · 沉稳' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声 · 阳光' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声 · 播音' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男声 · 浑厚' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 少年音' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北口音' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声' },
  { id: 'zh-HK-WanLungNeural', label: '萬龍 · 粤语男声' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声' },
  { id: 'en-US-AriaNeural', label: 'Aria · English' },
  { id: 'en-US-JennyNeural', label: 'Jenny · English' },
  { id: 'en-US-GuyNeural', label: 'Guy · English' },
  { id: 'ja-JP-NanamiNeural', label: '七海 · 日本語' },
  { id: 'ko-KR-SunHiNeural', label: '선히 · 한국어' },
];

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** The rate values the config offers; Edge TTS takes relative percentages. */
export const RATE_OPTIONS = ['-30%', '-15%', '+0%', '+15%', '+30%'] as const;
/** The volume values the config offers. */
export const VOLUME_OPTIONS = ['-30%', '+0%', '+20%', '+50%'] as const;
