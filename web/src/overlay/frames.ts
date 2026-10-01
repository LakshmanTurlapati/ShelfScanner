import { saveFrame } from "../api";
import { coverPoint } from "./geometry";
import type { LiveLabel } from "./live-layout";

export type FrameLabel = LiveLabel & { title: string; rating: number | null };

export type FrameState = {
  captureId: string | null;
  status: string;
  reading: boolean;
  lost: boolean;
  viewport: { width: number; height: number };
  anchors: number;
  review: number;
  labels: FrameLabel[];
};

const INTERVAL_MS = 3000;
const MAX_SIDE = 960;
const INK = "#fffaf6";
const ACCENT = "#ff6b35";
const LABEL_H = 43;

function fit(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > width) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function drawLabeledFrame(video: HTMLVideoElement, state: FrameState) {
  const { width, height } = state.viewport;
  const scale = Math.min(window.devicePixelRatio || 1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  const start = coverPoint(0, 0, width, height, video.videoWidth, video.videoHeight);
  const end = coverPoint(1, 1, width, height, video.videoWidth, video.videoHeight);
  ctx.drawImage(video, start.x, start.y, end.x - start.x, end.y - start.y);

  const labelW = Math.min(164, width * 0.42);
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1.5;
  for (const label of state.labels) {
    ctx.strokeStyle = ACCENT;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(label.x, label.y);
    ctx.lineTo(label.labelX, label.labelY + 22);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(label.x, label.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(label.labelX, label.labelY, labelW, LABEL_H, 8);
    ctx.fillStyle = "rgba(32, 25, 23, 0.9)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 140, 66, 0.6)";
    ctx.stroke();
    ctx.fillStyle = INK;
    const rating = label.rating != null ? `${label.rating.toFixed(1)}★` : "";
    const ratingW = rating ? ctx.measureText(rating).width + 8 : 0;
    ctx.textAlign = "left";
    ctx.fillText(fit(ctx, label.title, labelW - 16 - ratingW), label.labelX + 8, label.labelY + LABEL_H / 2);
    ctx.textAlign = "right";
    if (rating) ctx.fillText(rating, label.labelX + labelW - 8, label.labelY + LABEL_H / 2);
  }

  if (state.status) {
    ctx.font = "14px system-ui, sans-serif";
    const text = fit(ctx, state.status, width * 0.85 - 24);
    const boxW = ctx.measureText(text).width + 24;
    ctx.beginPath();
    ctx.roundRect((width - boxW) / 2, 64, boxW, 36, 12);
    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.fillText(text, width / 2, 82);
  }
  return canvas;
}

export function captureFrames(video: HTMLVideoElement, read: () => FrameState | null) {
  let sending = false;
  const timer = setInterval(() => {
    const state = read();
    if (!state?.labels.length || sending || document.hidden || !video.videoWidth) return;
    const canvas = drawLabeledFrame(video, state);
    if (!canvas) return;
    sending = true;
    canvas.toBlob((blob) => {
      if (!blob) {
        sending = false;
        return;
      }
      const meta = { kind: "labels", ...state, video: { width: video.videoWidth, height: video.videoHeight } };
      void saveFrame(blob, meta).catch(() => undefined).finally(() => {
        sending = false;
      });
    }, "image/jpeg", 0.7);
  }, INTERVAL_MS);
  return () => clearInterval(timer);
}
