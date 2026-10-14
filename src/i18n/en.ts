import type { TtsText } from './index.ts';

export const en: TtsText = {
  label: 'Voice',
  lamps: {
    speech: 'Voice',
    speaking: 'Speaking',
    idle: 'Idle',
    failed: 'Synthesis failed',
  },
  config: {
    title: 'Voice',
    enabled: 'Speak the pet\'s replies',
    enabledHint: 'Coo reads its bubble lines aloud; question choices are read too',
    voice: 'Voice',
    voiceHint: 'The voice that reads aloud; ask Coo to set any Edge TTS ShortName the list lacks',
    rate: 'Rate',
    rateHint: 'Relative speed; positive is faster',
    volume: 'Volume',
    volumeHint: 'Relative volume; positive is louder',
    readOptions: 'Read choices aloud',
    readOptionsHint: 'When Coo asks a question, its options are read too',
  },
  hush: {
    stopped: 'Voice stopped.',
    nothing: 'Nothing was playing.',
  },
};
