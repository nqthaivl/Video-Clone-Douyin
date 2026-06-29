/** Export polish helpers — parity with backend subtitle_burn_layout + dub_export. */

export const SUBTITLE_FONT_OPTIONS = [
  "Arial",
  "Arial Black",
  "Tahoma",
  "Verdana",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Trebuchet MS",
  "Impact",
] as const;

export type SubtitleFontFamily = (typeof SUBTITLE_FONT_OPTIONS)[number];

export const SUB_TEXT_PAD_PX = 3;
export const SUB_ASS_FONT_SCALE = 1.22;
export const EXPORT_REF_HEIGHT = 1080;

export function previewSubtitleFontPx(nativePx: number, nativeHeight: number, displayHeight: number): number {
  const assPx = Math.max(14, Math.round(nativePx * SUB_ASS_FONT_SCALE));
  if (!nativeHeight || !displayHeight) {
    return Math.max(10, Math.min(72, Math.round(assPx / 2)));
  }
  const scaled = assPx * (displayHeight / nativeHeight);
  return Math.max(8, Math.min(96, Math.round(scaled)));
}

export function previewSubtitlePadPx(nativeHeight: number, displayHeight: number): number {
  if (!nativeHeight || !displayHeight) return SUB_TEXT_PAD_PX;
  const ref = Math.max(nativeHeight, 1);
  return Math.max(1, Math.round(SUB_TEXT_PAD_PX * (displayHeight / ref) * (EXPORT_REF_HEIGHT / 1080)));
}

export function subtitleBoxHeightNorm(fontSize: number, videoHeight: number): number {
  const assPx = Math.max(14, Math.round(fontSize * SUB_ASS_FONT_SCALE));
  const vh = Math.max(240, videoHeight || 1080);
  const pad = Math.max(2, Math.round(SUB_TEXT_PAD_PX * vh / 1080));
  const lineH = assPx * 1.35;
  const lines = 2;
  const boxPx = pad * 2 + lineH * lines;
  return Math.max(0.04, Math.min(0.45, boxPx / vh));
}

export function exportMixQueryParams(bgVolume: number, dubVolume: number): Record<string, string> {
  return {
    bg_volume: String(bgVolume),
    dub_volume: String(dubVolume),
  };
}

export function videoExportPolishParams(options: {
  burnVideoSubs: boolean;
  subtitleBox: { x: number; y: number; w: number; h: number };
  subtitleFontSize: number;
  subtitleColor: string;
  subtitleBgColor: string;
  subtitleBgTransparent: boolean;
  subtitleFontFamily: string;
  blurExistingSubs: boolean;
  blurRegions: Array<{ x: number; y: number; w: number; h: number; start?: number; end?: number }>;
  logoOverlayEnabled: boolean;
  logoBox: { x: number; y: number; w: number; h: number };
  bgVolume: number;
  dubVolume: number;
}): Record<string, string> {
  const params: Record<string, string> = {
    ...exportMixQueryParams(options.bgVolume, options.dubVolume),
  };
  if (options.burnVideoSubs) {
    params.burn_subs = "true";
    params.sub_x = (options.subtitleBox.x + options.subtitleBox.w / 2).toFixed(4);
    params.sub_y = (options.subtitleBox.y + options.subtitleBox.h).toFixed(4);
    params.sub_w = options.subtitleBox.w.toFixed(4);
    params.sub_h = options.subtitleBox.h.toFixed(4);
    params.sub_font_size = String(options.subtitleFontSize);
    params.sub_color = options.subtitleColor;
    params.sub_bg_color = options.subtitleBgTransparent ? "transparent" : options.subtitleBgColor;
    params.sub_font_family = options.subtitleFontFamily;
  }
  if (options.blurExistingSubs && options.blurRegions.length) {
    params.blur_subs = "true";
    params.blur_regions = JSON.stringify(
      options.blurRegions.map(({ x, y, w, h, start, end }) => {
        const region: Record<string, number> = { x, y, w, h };
        if (start != null && end != null) {
          region.start = start;
          region.end = end;
        }
        return region;
      }),
    );
  }
  if (options.logoOverlayEnabled) {
    params.logo_overlay = "true";
    params.logo_x = options.logoBox.x.toFixed(4);
    params.logo_y = options.logoBox.y.toFixed(4);
    params.logo_w = options.logoBox.w.toFixed(4);
    params.logo_h = options.logoBox.h.toFixed(4);
  }
  return params;
}
