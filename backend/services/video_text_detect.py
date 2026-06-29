"""Detect on-screen text regions in video frames for blur overlay.

Uses ffmpeg frame sampling + local-contrast heuristics (no extra ML deps).
Returns tight boxes and time ranges — blur only while text is visible.
"""
from __future__ import annotations

import logging
import os
import shutil
import statistics
import tempfile
from collections import deque
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from services.ffmpeg_utils import find_ffmpeg, probe_duration, probe_video_dimensions, run_ffmpeg

logger = logging.getLogger("omnivoice.video_text_detect")

# Normalized limits for a single subtitle line (relative to full frame).
_MIN_TEXT_W = 0.10
_MAX_TEXT_W = 0.88
_MIN_TEXT_H = 0.012
_MAX_TEXT_H = 0.10
_MAX_TEXT_AREA = 0.08


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _iou(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1 = max(ax, bx)
    y1 = max(ay, by)
    x2 = min(ax + aw, bx + bw)
    y2 = min(ay + ah, by + bh)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if inter <= 0:
        return 0.0
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _box_center_y(box: tuple[float, float, float, float]) -> float:
    return box[1] + box[3] * 0.5


def _union_box(boxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float]:
    xs = [b[0] for b in boxes]
    ys = [b[1] for b in boxes]
    x2 = max(b[0] + b[2] for b in boxes)
    y2 = max(b[1] + b[3] for b in boxes)
    return (_clamp01(min(xs)), _clamp01(min(ys)), _clamp01(x2 - min(xs)), _clamp01(y2 - min(ys)))


def _intersect_box(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> tuple[float, float, float, float] | None:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1 = max(ax, bx)
    y1 = max(ay, by)
    x2 = min(ax + aw, bx + bw)
    y2 = min(ay + ah, by + bh)
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2 - x1, y2 - y1)


def _median_box(boxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float]:
    xs = [b[0] for b in boxes]
    ys = [b[1] for b in boxes]
    ws = [b[2] for b in boxes]
    hs = [b[3] for b in boxes]
    return (
        _clamp01(float(statistics.median(xs))),
        _clamp01(float(statistics.median(ys))),
        _clamp01(float(statistics.median(ws))),
        _clamp01(float(statistics.median(hs))),
    )


def _consensus_box(boxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float]:
    """Pick a tight box representative of many frames in one subtitle cue."""
    if not boxes:
        return (0.0, 0.0, 0.0, 0.0)
    if len(boxes) == 1:
        return boxes[0]

    result = boxes[0]
    for box in boxes[1:]:
        inter = _intersect_box(result, box)
        if inter and inter[2] >= _MIN_TEXT_W * 0.65 and inter[3] >= _MIN_TEXT_H * 0.65:
            result = inter
        else:
            return _median_box(boxes)
    return result


def _score_box(box: tuple[float, float, float, float]) -> float:
    x, y, w, h = box
    area = w * h
    aspect = w / max(h, 1e-4)
    center_y = _box_center_y(box)
    score = 0.0
    score += min(aspect / 7.0, 1.4)
    score += center_y * 1.2  # prefer lower on screen (typical subtitles)
    score -= max(0.0, area - 0.045) * 8.0
    score -= max(0.0, 0.55 - center_y) * 0.8  # penalise upper half
    if w > 0.82 and h > 0.06:
        score -= 2.0
    return score


def _pick_best_box(boxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float] | None:
    if not boxes:
        return None
    ranked = sorted(boxes, key=_score_box, reverse=True)
    best = ranked[0]
    if _score_box(best) < 0.35:
        return None
    return best


def _same_subtitle_line(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
    *,
    y_tol: float = 0.035,
) -> bool:
    return abs(_box_center_y(a) - _box_center_y(b)) <= y_tol


def _dilate_horizontal(mask: np.ndarray, radius: int = 4) -> np.ndarray:
    if radius <= 0:
        return mask
    h, w = mask.shape
    out = mask.copy()
    for y in range(h):
        row = mask[y]
        if not row.any():
            continue
        active = np.where(row)[0]
        for x in active:
            x0 = max(0, x - radius)
            x1 = min(w, x + radius + 1)
            out[y, x0:x1] = True
    return out


def _dilate_vertical(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    if radius <= 0:
        return mask
    h, w = mask.shape
    out = mask.copy()
    for x in range(w):
        col = mask[:, x]
        if not col.any():
            continue
        active = np.where(col)[0]
        for y in active:
            y0 = max(0, y - radius)
            y1 = min(h, y + radius + 1)
            out[y0:y1, x] = True
    return out


def _connected_component_boxes(mask: np.ndarray, *, min_pixels: int = 28) -> list[tuple[int, int, int, int]]:
    h, w = mask.shape
    visited = np.zeros((h, w), dtype=bool)
    boxes: list[tuple[int, int, int, int]] = []
    for y0 in range(h):
        for x0 in range(w):
            if not mask[y0, x0] or visited[y0, x0]:
                continue
            queue: deque[tuple[int, int]] = deque([(y0, x0)])
            visited[y0, x0] = True
            xmin = xmax = x0
            ymin = ymax = y0
            count = 0
            while queue:
                cy, cx = queue.popleft()
                count += 1
                xmin = min(xmin, cx)
                xmax = max(xmax, cx)
                ymin = min(ymin, cy)
                ymax = max(ymax, cy)
                for ny in range(max(0, cy - 1), min(h, cy + 2)):
                    for nx in range(max(0, cx - 1), min(w, cx + 2)):
                        if mask[ny, nx] and not visited[ny, nx]:
                            visited[ny, nx] = True
                            queue.append((ny, nx))
            if count >= min_pixels:
                boxes.append((xmin, ymin, xmax + 1, ymax + 1))
    return boxes


def _merge_line_boxes(
    boxes: list[tuple[float, float, float, float]],
    *,
    y_tol: float = 0.018,
) -> list[tuple[float, float, float, float]]:
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda b: (b[1], b[0]))
    merged: list[tuple[float, float, float, float]] = []
    for box in boxes:
        placed = False
        for idx, existing in enumerate(merged):
            same_line = abs(box[1] - existing[1]) <= y_tol and abs((box[1] + box[3]) - (existing[1] + existing[3])) <= y_tol * 1.5
            if same_line and _iou(box, existing) > 0.08:
                inter = _intersect_box(existing, box)
                merged[idx] = inter if inter else _median_box([existing, box])
                placed = True
                break
        if not placed:
            merged.append(box)
    return merged


def _text_like_box(
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    mask: np.ndarray,
    *,
    full_w: int,
    full_h: int,
    y_offset: int,
) -> tuple[float, float, float, float] | None:
    bw = x1 - x0
    bh = y1 - y0
    if bw <= 0 or bh <= 0:
        return None

    nw = bw / full_w
    nh = bh / full_h
    area = nw * nh
    if nw < _MIN_TEXT_W or nw > _MAX_TEXT_W:
        return None
    if nh < _MIN_TEXT_H or nh > _MAX_TEXT_H:
        return None
    if area > _MAX_TEXT_AREA:
        return None
    if bw / max(bh, 1) < 2.4:
        return None

    sub = mask[y0:y1, x0:x1]
    density = float(sub.mean())
    if density < 0.04 or density > 0.55:
        return None

    pad_x = max(2, int(full_w * 0.005))
    pad_y = max(2, int(full_h * 0.004))
    x0n = max(0, x0 - pad_x)
    x1n = min(full_w, x1 + pad_x)
    y0n = max(0, y_offset + y0 - pad_y)
    y1n = min(full_h, y_offset + y1 + pad_y)
    return (
        _clamp01(x0n / full_w),
        _clamp01(y0n / full_h),
        _clamp01((x1n - x0n) / full_w),
        _clamp01((y1n - y0n) / full_h),
    )


def _regions_from_gray(gray: np.ndarray) -> list[tuple[float, float, float, float]]:
    """Return normalized (x, y, w, h) boxes tightly around subtitle-like text."""
    h, w = gray.shape
    if h < 32 or w < 32:
        return []

    # Hard-sub titles on vertical video are usually in the bottom band.
    y_offset = int(h * 0.62)
    crop = gray[y_offset:, :].astype(np.float32)
    ch, cw = crop.shape
    if ch < 12 or cw < 32:
        return []

    blur = np.asarray(
        Image.fromarray(crop.astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=5)),
        dtype=np.float32,
    )
    contrast = np.abs(crop - blur)
    gx = np.abs(np.diff(crop, axis=1))
    gx = np.pad(gx, ((0, 0), (0, 1)), mode="edge")
    edge_energy = contrast * 0.7 + gx * 0.3

    thr = max(
        float(np.percentile(edge_energy, 95.5)),
        float(edge_energy.mean() + edge_energy.std() * 2.35),
        12.0,
    )
    mask = edge_energy >= thr
    mask = _dilate_horizontal(mask, radius=4)
    mask = _dilate_vertical(mask, radius=1)

    candidates: list[tuple[float, float, float, float]] = []
    for x0, y0, x1, y1 in _connected_component_boxes(mask):
        box = _text_like_box(x0, y0, x1, y1, mask, full_w=w, full_h=h, y_offset=y_offset)
        if box:
            candidates.append(box)

    if not candidates:
        row_score = edge_energy.mean(axis=1)
        row_thresh = max(float(row_score.mean() + row_score.std() * 1.65), 10.0)
        active_rows = row_score >= row_thresh
        if not active_rows.any():
            return []
        r_idx = np.where(active_rows)[0]
        peak = int(np.argmax(row_score))
        max_line_h = max(6, int(h * 0.075))
        r0 = max(0, peak - max_line_h // 2)
        r1 = min(ch, r0 + max_line_h)

        band = edge_energy[r0:r1, :]
        col_score = band.mean(axis=0)
        col_thr = max(float(col_score.mean() + col_score.std() * 1.45), 9.0)
        active_cols = col_score >= col_thr
        if not active_cols.any():
            return []
        c_idx = np.where(active_cols)[0]
        c0, c1 = int(c_idx[0]), int(c_idx[-1]) + 1
        peak_cols = col_score[c0:c1] >= (col_score[c0:c1].max() * 0.48)
        tight_idx = np.where(peak_cols)[0]
        if len(tight_idx) >= 3:
            c0 += int(tight_idx[0])
            c1 = c0 + int(tight_idx[-1]) + 1
        box = _text_like_box(c0, r0, c1, r1, mask, full_w=w, full_h=h, y_offset=y_offset)
        if box:
            candidates.append(box)

    merged = _merge_line_boxes(candidates)
    merged.sort(key=_score_box, reverse=True)
    return merged[:2]


def _estimate_subtitle_band(
    frame_samples: list[tuple[float, float, list[tuple[float, float, float, float]]]],
) -> float | None:
    centers: list[float] = []
    for _, _, boxes in frame_samples:
        box = _pick_best_box(boxes)
        if box:
            centers.append(_box_center_y(box))
    if len(centers) < 2:
        return None
    return float(statistics.median(centers))


def _filter_boxes_to_band(
    boxes: list[tuple[float, float, float, float]],
    band_y: float | None,
    *,
    tol: float = 0.05,
) -> list[tuple[float, float, float, float]]:
    if band_y is None:
        return boxes
    kept = [b for b in boxes if abs(_box_center_y(b) - band_y) <= tol]
    return kept or boxes


def _build_timed_regions(
    frame_samples: list[tuple[float, float, list[tuple[float, float, float, float]]]],
    *,
    duration: float | None,
    step: float,
    pad_start: float = 0.04,
    pad_end: float = 0.10,
) -> list[dict[str, float]]:
    """Group consecutive detected frames into non-overlapping subtitle cues."""
    band_y = _estimate_subtitle_band(frame_samples)
    max_gap = max(step * 2.2, 0.45)

    runs: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    missed = 0

    for t0, t1, raw_boxes in frame_samples:
        boxes = _filter_boxes_to_band(raw_boxes, band_y)
        box = _pick_best_box(boxes)

        if box is None:
            if current is not None:
                missed += 1
                if missed <= 1:
                    current["end"] = t1
                    continue
                runs.append(current)
                current = None
                missed = 0
            continue

        missed = 0
        if current is None:
            current = {"start": t0, "end": t1, "boxes": [box]}
            continue

        prev_box = _consensus_box(current["boxes"])
        gap = t0 - float(current["end"])
        if gap <= max_gap and (_same_subtitle_line(prev_box, box) or _iou(prev_box, box) >= 0.08):
            current["end"] = t1
            current["boxes"].append(box)
            continue

        runs.append(current)
        current = {"start": t0, "end": t1, "boxes": [box]}

    if current is not None:
        runs.append(current)

    max_end = float(duration) if duration and duration > 0 else None
    segments: list[dict[str, float]] = []
    for run in runs:
        x, y, w, h = _consensus_box(run["boxes"])
        start = max(0.0, float(run["start"]) - pad_start)
        end = float(run["end"]) + pad_end
        if max_end is not None:
            end = min(max_end, end)
        if end <= start or w <= 0 or h <= 0:
            continue
        segments.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "x": round(x, 4),
            "y": round(y, 4),
            "w": round(w, 4),
            "h": round(h, 4),
        })

    return _dedupe_overlapping_segments(segments)


def _dedupe_overlapping_segments(segments: list[dict[str, float]]) -> list[dict[str, float]]:
    if not segments:
        return []
    segments = sorted(segments, key=lambda s: (s["start"], s["end"]))
    out: list[dict[str, float]] = []
    for seg in segments:
        if not out:
            out.append(seg)
            continue
        prev = out[-1]
        prev_box = (prev["x"], prev["y"], prev["w"], prev["h"])
        cur_box = (seg["x"], seg["y"], seg["w"], seg["h"])
        overlap = seg["start"] <= prev["end"]
        same_line = _same_subtitle_line(prev_box, cur_box) or _iou(prev_box, cur_box) >= 0.12
        if overlap and same_line:
            prev["end"] = max(prev["end"], seg["end"])
            px, py, pw, ph = _consensus_box([prev_box, cur_box])
            prev.update({"x": round(px, 4), "y": round(py, 4), "w": round(pw, 4), "h": round(ph, 4)})
            continue
        out.append(seg)
    return out[:40]


async def detect_text_regions(
    video_path: str,
    *,
    max_frames: int = 16,
    sample_fps: float = 0.5,
) -> dict[str, Any]:
    """Sample video frames; return timed blur windows where text is visible."""
    if not os.path.isfile(video_path):
        return {
            "regions": [],
            "timed_regions": [],
            "video_width": 0,
            "video_height": 0,
            "error": "Video not found",
        }

    dims = await probe_video_dimensions(video_path)
    duration = await probe_duration(video_path)
    video_w, video_h = dims if dims else (0, 0)

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return {
            "regions": [],
            "timed_regions": [],
            "video_width": video_w,
            "video_height": video_h,
            "error": "ffmpeg not available",
        }

    max_frames = max(4, min(int(max_frames), 80))
    sample_fps = max(0.1, min(float(sample_fps), 3.0))

    tmp_dir = tempfile.mkdtemp(prefix="vcs_ocr_")
    pattern = os.path.join(tmp_dir, "frame_%04d.png")
    try:
        vf = f"fps={sample_fps:.3f},scale=960:-1"
        if duration and duration > 0:
            cap = max(4, int(duration * sample_fps))
            if cap > max_frames:
                vf = f"fps={max_frames / duration:.4f},scale=960:-1"
                sample_fps = max_frames / duration

        cmd = [
            ffmpeg, "-y", "-i", video_path,
            "-vf", vf,
            "-frames:v", str(max_frames),
            pattern,
        ]
        rc, _, stderr = await run_ffmpeg(cmd, timeout=300.0)
        if rc != 0:
            logger.warning("Frame extract failed: %s", (stderr or b"")[:300])
            return {
                "regions": [],
                "timed_regions": [],
                "video_width": video_w,
                "video_height": video_h,
                "error": "Không thể trích xuất khung hình từ video.",
            }

        frame_names = sorted(n for n in os.listdir(tmp_dir) if n.lower().endswith(".png"))
        frame_count = len(frame_names)
        step = (duration / frame_count) if duration and frame_count else (1.0 / sample_fps)

        frame_samples: list[tuple[float, float, list[tuple[float, float, float, float]]]] = []
        for index, name in enumerate(frame_names):
            t0 = index * step
            t1 = (index + 1) * step
            if duration and duration > 0:
                t1 = min(duration, t1)
            path = os.path.join(tmp_dir, name)
            try:
                img = Image.open(path).convert("L")
                arr = np.asarray(img)
                boxes = _regions_from_gray(arr)
            except Exception as exc:
                logger.debug("Frame analysis failed for %s: %s", name, exc)
                boxes = []
            frame_samples.append((t0, t1, boxes))

        timed_regions = _build_timed_regions(frame_samples, duration=duration, step=step)
        regions = [
            {"x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]}
            for r in timed_regions
        ]
        return {
            "regions": regions,
            "timed_regions": timed_regions,
            "video_width": video_w,
            "video_height": video_h,
            "frames_analyzed": frame_count,
            "error": None if timed_regions else "Không phát hiện vùng chữ — thử thêm vùng mờ thủ công.",
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
