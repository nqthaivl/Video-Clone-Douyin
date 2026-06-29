"""Shared subtitle burn layout — matches export polish overlay coordinates."""
from __future__ import annotations

from dataclasses import dataclass

SUB_TEXT_PAD_PX = 3
SUB_ASS_FONT_SCALE = 1.22


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(value)))


@dataclass(frozen=True)
class SubtitleBurnLayout:
    play_w: int
    play_h: int
    box_left: int
    box_top: int
    box_right: int
    box_bottom: int
    clip_top: int
    clip_bottom: int
    clip_left: int
    clip_right: int
    pos_x: int
    pos_y: int
    margin_l: int
    margin_r: int
    margin_v: int
    ass_font_size: int
    sub_pad: int
    bg_left: int
    bg_top: int
    bg_right: int
    bg_bottom: int


def compute_burn_layout(
    *,
    center_x: float,
    bottom_y: float,
    box_w: float,
    box_h: float,
    video_w: int,
    video_h: int,
    font_size: int,
) -> SubtitleBurnLayout:
    """Layout from export anchors: center_x + bottom_y (same as /dub/download query)."""
    play_w = max(int(video_w or 1920), 320)
    play_h = max(int(video_h or 1080), 240)
    cx = _clamp(center_x, 0.0, 1.0)
    by = _clamp(bottom_y, 0.0, 1.0)
    bw = _clamp(box_w, 0.05, 1.0)
    bh = _clamp(box_h, 0.03, 0.45)

    box_left = int(_clamp(cx - bw / 2.0, 0.0, 0.98) * play_w)
    box_right = int(_clamp(cx + bw / 2.0, bw * 0.05, 1.0) * play_w)
    box_bottom = int(_clamp(by, bh, 1.0) * play_h)
    box_top = max(0, int(box_bottom - bh * play_h))
    ref = max(play_w, play_h)
    sub_pad = max(2, int(round(SUB_TEXT_PAD_PX * ref / 1080)))
    clip_left = min(box_right - 1, box_left + sub_pad)
    clip_right = max(clip_left + 1, box_right - sub_pad)
    clip_top = min(box_bottom - 1, box_top + sub_pad)
    clip_bottom = max(clip_top + 1, box_bottom - sub_pad)

    return SubtitleBurnLayout(
        play_w=play_w,
        play_h=play_h,
        box_left=box_left,
        box_top=box_top,
        box_right=box_right,
        box_bottom=box_bottom,
        clip_top=clip_top,
        clip_bottom=clip_bottom,
        clip_left=clip_left,
        clip_right=clip_right,
        pos_x=(clip_left + clip_right) // 2,
        pos_y=(clip_top + clip_bottom) // 2,
        margin_l=clip_left,
        margin_r=max(0, play_w - clip_right),
        margin_v=max(0, play_h - box_bottom),
        ass_font_size=max(14, int(round(font_size * SUB_ASS_FONT_SCALE))),
        sub_pad=sub_pad,
        bg_left=clip_left,
        bg_top=clip_top,
        bg_right=clip_right,
        bg_bottom=clip_bottom,
    )
