export { TTS, ttsDefinition, type TtsAssembly } from './definition.ts';
export { ttsConfigGroups, TTS_DEFAULTS, TTS_ID, TTS_VOICE_OPTIONS, ttsVoiceOptions, type TtsConfigSection } from './config.ts';
export { TtsWorld } from './world.ts';
export { speakable, SPEAK_MAX } from './clean.ts';
// the extension loader imports the package entry and expects the World as the default export
export { TTS as default } from './definition.ts';
