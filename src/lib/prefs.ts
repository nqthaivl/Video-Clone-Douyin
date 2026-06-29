/** Persist sidebar / workflow defaults across app restarts (localStorage). */

export const PrefKeys = {
  targetLanguage: "targetLanguageCode",
  sourceLanguage: "sourceLanguageCode",
  dubTiming: "dubTimingStrategy",
  srtTargetLanguage: "srtTargetLanguageCode",
  srtTiming: "srtTimingStrategy",
  batchTargetLanguage: "batchTargetLanguageCode",
  srtVoiceId: "srtVoiceId",
  batchVoiceId: "batchVoiceId",
  translateProvider: "translateProvider",
  asrBackend: "asrBackend",
  asrModelRepo: "asrModelRepo",
  defaultVoiceId: "defaultVoiceId",
  exportAudioMode: "exportAudioMode",
  exportBgVolume: "exportBgVolume",
  exportDubVolume: "exportDubVolume",
  exportSubFontFamily: "exportSubFontFamily",
  exportSubBgTransparent: "exportSubBgTransparent",
} as const;

/** MP4 export audio mixing: dub only, dub + background bed, or dub + original video track. */
export type ExportAudioMode = "dub_only" | "dub_with_bg" | "dub_with_original";

export function exportAudioQueryParams(mode: ExportAudioMode, langCode: string): {
  preserve_bg: string;
  include_tracks: string;
  mix_original?: string;
} {
  switch (mode) {
    case "dub_only":
      return { preserve_bg: "false", include_tracks: langCode };
    case "dub_with_original":
      return { preserve_bg: "false", include_tracks: langCode, mix_original: "true" };
    case "dub_with_bg":
    default:
      return { preserve_bg: "true", include_tracks: langCode };
  }
}

export function exportAudioModeLabel(mode: ExportAudioMode): string {
  switch (mode) {
    case "dub_only":
      return "Chỉ giọng lồng tiếng";
    case "dub_with_original":
      return "Trộn lồng tiếng + âm thanh video gốc (1 track)";
    case "dub_with_bg":
    default:
      return "Lồng tiếng + nhạc nền gốc";
  }
}

export function readPref(key: string, fallback: string): string {
  try {
    const value = localStorage.getItem(key);
    return value !== null && value !== "" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota / private mode — ignore */
  }
}

export function readBoolPref(key: string, fallback: boolean): boolean {
  const value = readPref(key, fallback ? "1" : "0");
  return value === "1" || value === "true" || value === "yes";
}

export function writeBoolPref(key: string, value: boolean): void {
  writePref(key, value ? "1" : "0");
}
