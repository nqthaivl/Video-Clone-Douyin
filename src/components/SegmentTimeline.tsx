import { useRef, useState } from "react";

type Props = {
  start: number;
  end: number;
  onSplit: (splitTime: number) => void;
  disabled?: boolean;
};

/** Mini timeline for one dub segment ΓÇö hover to preview, click minus to split. */
export function SegmentTimeline({ start, end, onSplit, disabled }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverPct, setHoverPct] = useState<number | null>(null);

  const duration = end - start;
  const canSplit = duration >= MIN_PART_S * 2;

  const updateHover = (clientX: number) => {
    const el = trackRef.current;
    if (!el || disabled || !canSplit) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(0.08, Math.min(0.92, (clientX - rect.left) / rect.width));
    setHoverPct(pct);
  };

  const handleSplit = () => {
    if (hoverPct == null || disabled || !canSplit) return;
    onSplit(start + duration * hoverPct);
    setHoverPct(null);
  };

  return (
    <div className="segment-timeline">
      <span className="segment-timeline-edge">{formatClock(start)}</span>
      <div
        ref={trackRef}
        className={`segment-timeline-track${canSplit && !disabled ? " splittable" : ""}`}
        onMouseMove={(e) => updateHover(e.clientX)}
        onMouseLeave={() => setHoverPct(null)}
        onClick={handleSplit}
        title={
          canSplit
            ? "Di chuột đến vị trí cần cắt, click dấu trừ để chia đoạn"
            : "Đoạn quá ngắn — không thể chia thêm"
        }
      >
        {hoverPct != null && (
          <>
            <div className="segment-timeline-split-line" style={{ left: `${hoverPct * 100}%` }} />
            <span className="segment-timeline-split-btn" style={{ left: `${hoverPct * 100}%` }} aria-hidden>
              −
            </span>
          </>
        )}
      </div>
      <span className="segment-timeline-edge">{formatClock(end)}</span>
    </div>
  );
}

const MIN_PART_S = 0.3;

function formatClock(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
