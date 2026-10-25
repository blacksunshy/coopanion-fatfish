/** The voices the config offers, plus how a config value becomes the metadata Edge TTS expects. */

export interface VoiceOption {
  /** The Edge TTS ShortName, the value stored in the config. */
  id: string;
  /** The human label, in Chinese where one exists. */
  label: string;
}

/**
 * The voices worth picking from — every Chinese one Edge TTS still serves, plus a few common
 * foreign ones. Any other Edge TTS ShortName can be typed in by hand.
 *
 * Kept in step with the service's own list. `zh-CN-XiaomoNeural` used to be here and has been
 * dropped by the service; keeping it made that choice fail synthesis and leave the pet silent.
 */
export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声 · 温暖' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声 · 活泼' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声 · 阳光' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声 · 播音' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男声 · 浑厚' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 少年音' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北口音' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西口音' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声' },
  { id: 'zh-TW-HsiaoYuNeural', label: '曉雨 · 台湾女声' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲 · 台湾男声' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 粤语女声' },
  { id: 'zh-HK-WanLungNeural', label: '萬龍 · 粤语男声' },
  { id: 'en-US-AriaNeural', label: 'Aria · English' },
  { id: 'en-US-JennyNeural', label: 'Jenny · English' },
  { id: 'en-US-GuyNeural', label: 'Guy · English' },
  { id: 'ja-JP-NanamiNeural', label: '七海 · 日本語' },
  { id: 'ko-KR-SunHiNeural', label: '선히 · 한국어' },
];

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** One voice pack: a voice together with the pace and tone that suit it. */
export interface VoicePreset {
  id: string;
  label: string;
  /** The label the English UI shows; `label` is Chinese. */
  labelEn: string;
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
}

/** The preset value that means "use the voice, rate, volume and pitch chosen below". */
export const CUSTOM_PRESET = 'custom';

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'warm', label: '温柔女声 · 晓晓', labelEn: 'Warm · Xiaoxiao', voice: 'zh-CN-XiaoxiaoNeural', rate: '-5%', volume: '+0%', pitch: '-2Hz' },
  { id: 'lively', label: '活泼少女 · 晓伊', labelEn: 'Lively · Xiaoyi', voice: 'zh-CN-XiaoyiNeural', rate: '+8%', volume: '+0%', pitch: '+2Hz' },
  { id: 'boy', label: '少年音 · 云夏', labelEn: 'Boy · Yunxia', voice: 'zh-CN-YunxiaNeural', rate: '+5%', volume: '+0%', pitch: '+0Hz' },
  { id: 'broadcast', label: '播音腔 · 云扬', labelEn: 'Broadcast · Yunyang', voice: 'zh-CN-YunyangNeural', rate: '-5%', volume: '+10%', pitch: '-2Hz' },
  { id: 'northeast', label: '东北口音 · 晓北', labelEn: 'Northeast · Xiaobei', voice: 'zh-CN-liaoning-XiaobeiNeural', rate: '+0%', volume: '+0%', pitch: '+0Hz' },
  { id: 'shaanxi', label: '陕西口音 · 晓妮', labelEn: 'Shaanxi · Xiaoni', voice: 'zh-CN-shaanxi-XiaoniNeural', rate: '+0%', volume: '+0%', pitch: '+0Hz' },
  { id: 'cantonese', label: '粤语女声 · 曉曼', labelEn: 'Cantonese · HiuMaan', voice: 'zh-HK-HiuMaanNeural', rate: '+0%', volume: '+0%', pitch: '+0Hz' },
  { id: 'taiwan', label: '台湾女声 · 曉臻', labelEn: 'Taiwan · HsiaoChen', voice: 'zh-TW-HsiaoChenNeural', rate: '+0%', volume: '+0%', pitch: '+0Hz' },
  { id: 'english', label: 'English · Aria', labelEn: 'English · Aria', voice: 'en-US-AriaNeural', rate: '+0%', volume: '+0%', pitch: '+0Hz' },
];

/** The rate values the config offers; Edge TTS takes relative percentages. */
export const RATE_OPTIONS = ['-30%', '-15%', '-5%', '+0%', '+5%', '+15%', '+30%'] as const;
/** The pitch values the config offers; Edge TTS takes relative hertz. */
export const PITCH_OPTIONS = ['-20Hz', '-10Hz', '-2Hz', '+0Hz', '+2Hz', '+10Hz', '+20Hz'] as const;
/** The volume values the config offers. */
export const VOLUME_OPTIONS = ['-30%', '+0%', '+20%', '+50%'] as const;
