export { FATFISH, fatfishDefinition, type FatfishAssembly } from './definition.ts';
export { DEFAULT_URL, FATFISH_DEFAULTS, FATFISH_ID, RELAY_MAX, SEND_MAX, VOICE_OPTIONS_KIND, fatfishConfigGroups, voiceOptionRows, type FatfishConfigSection } from './config.ts';
export { FatfishWorld, lineOf, type FatfishWorldOptions } from './world.ts';
export { DshClient, parseHostFrame, PROTOCOL_VERSION, type DshClientOptions, type HostFrame } from './client.ts';
export { speakable, SPEAK_MAX } from './clean.ts';
export { fatfishText, type FatfishText } from './i18n/index.ts';
// the extension loader imports the package entry and expects the World as the default export
export { FATFISH as default } from './definition.ts';
