import type { TtsText } from './index.ts';

export const zh: TtsText = {
  label: '语音朗读',
  lamps: {
    speech: '朗读',
    speaking: '正在朗读',
    idle: '待命',
    failed: '合成失败',
  },
  config: {
    title: '语音朗读',
    enabled: '朗读桌宠的话',
    enabledHint: 'Coo 在气泡里说话的同时读出声来；提问的选项一并读出',
    voice: '音色',
    voiceHint: '选一个说话的声音；列表里没有的 Edge TTS 音色名也可以让 Coo 帮你填',
    rate: '语速',
    rateHint: '相对速度，正数更快',
    volume: '音量',
    volumeHint: '相对音量，正数更大',
    readOptions: '朗读选项',
    readOptionsHint: 'Coo 提问时把可选项也读出来',
  },
  hush: {
    stopped: '已停下朗读。',
    nothing: '朗读已停。',
  },
};
