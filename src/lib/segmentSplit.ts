import type { Segment } from "./api";

const MIN_PART_S = 0.3;

export function splitTextByRatio(text: string, ratio: number): [string, string] {
  const t = (text || "").trim();
  if (!t) return ["", ""];
  const r = Math.max(0.05, Math.min(0.95, ratio));
  if (/\s/.test(t)) {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const cut = Math.max(1, Math.min(words.length - 1, Math.round(words.length * r)));
      return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
    }
  }
  const cut = Math.max(1, Math.min(t.length - 1, Math.round(t.length * r)));
  return [t.slice(0, cut).trim(), t.slice(cut).trim()];
}

function roundTime(t: number) {
  return Math.round(t * 1000) / 1000;
}

export function splitSegmentByTime(
  segment: Segment,
  splitTime: number,
  newId: () => string = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
): [Segment, Segment] | null {
  const { start, end } = segment;
  if (splitTime <= start + MIN_PART_S || splitTime >= end - MIN_PART_S) {
    return null;
  }
  const ratio = (splitTime - start) / (end - start);
  const [textL, textR] = splitTextByRatio(segment.text, ratio);
  const [origL, origR] = splitTextByRatio(segment.text_original || segment.text, ratio);
  if (!textL.trim() || !textR.trim()) {
    return null;
  }
  const t = roundTime(splitTime);
  return [
    { ...segment, end: t, text: textL, text_original: origL },
    { ...segment, id: newId(), start: t, text: textR, text_original: origR },
  ];
}
