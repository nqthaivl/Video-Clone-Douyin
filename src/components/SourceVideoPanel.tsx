import { useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, X } from "lucide-react";

function fitVideoStageStyle(ratio: number) {
  const maxH = 464;
  return {
    aspectRatio: String(ratio),
    width: `min(100%, ${Math.round(maxH * ratio)}px)`,
    maxHeight: `${maxH}px`,
    margin: "0 auto",
  };
}

function formatClock(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Props = {
  previewUrl: string;
  onClose: () => void;
  onVideoMetadata?: (width: number, height: number) => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
};

export function SourceVideoPanel({
  previewUrl,
  onClose,
  onVideoMetadata,
  videoRef: externalVideoRef,
}: Props) {
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const videoRef = externalVideoRef || internalVideoRef;
  const [videoRatio, setVideoRatio] = useState(16 / 9);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
  }, [volume, videoRef, previewUrl]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  };

  const seekTo = (value: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(duration) || duration <= 0) return;
    video.currentTime = value;
    setTime(value);
  };

  return (
    <div className="source-card">
      <div className="source-video-shell">
        <div className="source-video-stage" style={fitVideoStageStyle(videoRatio)}>
          <video
            ref={videoRef}
            key={previewUrl}
            src={previewUrl}
            playsInline
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth && video.videoHeight) {
                setVideoRatio(video.videoWidth / video.videoHeight);
                onVideoMetadata?.(video.videoWidth, video.videoHeight);
              }
              setDuration(video.duration || 0);
              setTime(video.currentTime || 0);
            }}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        </div>
      </div>
      <div className="source-video-controls">
        <button type="button" className="source-video-btn" onClick={togglePlay} aria-label={playing ? "Tạm dừng" : "Phát"}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <input
          type="range"
          className="source-video-seek"
          min={0}
          max={duration > 0 ? duration : 1}
          step={0.05}
          value={Math.min(time, duration || 0)}
          onChange={(event) => seekTo(Number(event.target.value))}
        />
        <span className="source-video-time">{formatClock(time)} / {formatClock(duration)}</span>
        <Volume2 size={14} className="source-video-volume-icon" />
        <input
          type="range"
          className="source-video-volume"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(event) => setVolume(Number(event.target.value))}
        />
        <button type="button" className="source-video-close" onClick={onClose} aria-label="Xóa video">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
