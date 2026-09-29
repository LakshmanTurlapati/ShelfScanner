import { useEffect, useMemo, useRef, useState } from "react";
import type { NormBox } from "../../shared/types.ts";
import { Legend } from "./Legend";
import { coverPoint, layoutCallouts, type Callout } from "./overlay/geometry";
import { beginTrack, frameFromImageData, grayFromRGBA, projectAnchor, stepTrack, type TrackState } from "./overlay/track";
import { withScores } from "./pipeline/score";
import { scanPhotos } from "./scan";
import { currentSession, useShelf } from "./store";

type Anchor = { mark: string; box: NormBox };

function draw(ctx: CanvasRenderingContext2D, callouts: Callout[], width: number, height: number, frameW: number, frameH: number, dim: boolean) {
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = dim ? 0.35 : 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#f3ecdf";
  ctx.fillStyle = "#f3ecdf";
  ctx.font = "12px Palatino, Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const callout of callouts) {
    const target = coverPoint(callout.targetX, callout.targetY, width, height, frameW, frameH);
    const elbow = coverPoint(callout.elbowX, callout.elbowY, width, height, frameW, frameH);
    const badge = coverPoint(callout.badgeX, callout.badgeY, width, height, frameW, frameH);
    ctx.beginPath();
    ctx.moveTo(target.x, target.y);
    ctx.lineTo(elbow.x, elbow.y);
    ctx.lineTo(badge.x, badge.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(target.x, target.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(badge.x, badge.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = "#1c1915";
    ctx.fill();
    ctx.fillStyle = "#f3ecdf";
    ctx.fillText(callout.mark, badge.x, badge.y + 0.5);
  }
  ctx.globalAlpha = 1;
}

export function CameraScan() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keyframe = useRef<ImageData | null>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const tracker = useRef<TrackState | null>(null);
  const callouts = useRef<Callout[]>([]);
  const anchors = useRef<Anchor[]>([]);
  const started = useRef(false);
  const shelf = useShelf();
  const session = currentSession(shelf);
  const books = useMemo(() => withScores(session?.books ?? []), [session?.books]);
  const [notice, setNotice] = useState("");
  const [lost, setLost] = useState(false);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    let stream: MediaStream | null = null;
    let cancel = false;
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((next) => {
        stream = next;
        if (cancel) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        if (video) video.srcObject = next;
      })
      .catch(() => setNotice("The camera is unavailable."));
    return () => {
      cancel = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    let handle = 0;
    let stopped = false;
    const lostNow = { current: false };
    const tick = () => {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.videoWidth && callouts.current.length) {
        const bounds = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(bounds.width));
        const height = Math.max(1, Math.round(bounds.height));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        const ctx = canvas.getContext("2d");
        const work = (scratch.current ??= document.createElement("canvas"));
        const scratchCtx = work.getContext("2d", { willReadFrequently: true });
        if (ctx && scratchCtx && tracker.current) {
          work.width = tracker.current.width;
          work.height = tracker.current.height;
          scratchCtx.drawImage(video, 0, 0, work.width, work.height);
          const pixels = scratchCtx.getImageData(0, 0, work.width, work.height);
          const frame = { gray: grayFromRGBA(pixels.data, work.width, work.height), width: work.width, height: work.height };
          const step = stepTrack(tracker.current, frame);
          if (step.steady && step.homography) tracker.current = step.state;
          const homography = step.homography ?? tracker.current.keyToRef;
          const moved = callouts.current.map((callout) => {
            const anchor = anchors.current.find((item) => item.mark === callout.mark);
            if (!anchor || !step.steady || !homography) return callout;
            const centerX = anchor.box.x + anchor.box.w / 2;
            const centerY = anchor.box.y + anchor.box.h / 2;
            const point = projectAnchor(homography, centerX, centerY, frame.width, frame.height);
            return { ...callout, targetX: point.x, targetY: point.y };
          });
          callouts.current = moved;
          if (lostNow.current !== !step.steady) {
            lostNow.current = !step.steady;
            setLost(lostNow.current);
          }
          draw(ctx, moved, width, height, video.videoWidth, video.videoHeight, !step.steady);
        } else if (ctx) {
          draw(ctx, callouts.current, width, height, video.videoWidth, video.videoHeight, false);
        }
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(handle);
    };
  }, []);

  useEffect(() => {
    const placed = books.filter((book) => book.mark && book.box).map((book) => ({ mark: book.mark, box: book.box! }));
    if (!placed.length || started.current || !keyframe.current) return;
    started.current = true;
    anchors.current = placed;
    callouts.current = layoutCallouts(placed);
    const frame = frameFromImageData(keyframe.current);
    tracker.current = beginTrack(frame);
    if (!tracker.current) setLost(true);
  }, [books]);

  async function readShelf() {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    setReading(true);
    setNotice("");
    started.current = false;
    tracker.current = null;
    const full = document.createElement("canvas");
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    const ctx = full.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    keyframe.current = ctx.getImageData(0, 0, full.width, full.height);
    const blob = await new Promise<Blob | null>((resolve) => full.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) {
      setReading(false);
      setNotice("This frame could not be read.");
      return;
    }
    try {
      await scanPhotos([new File([blob], "shelf.jpg", { type: "image/jpeg" })]);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The scan failed.");
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black">
      <video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <div className="absolute left-4 top-4">
        <button className="rounded-full bg-[#f3ecdf] px-3 py-1 text-[#1c1915]" type="button" onClick={() => void readShelf()} disabled={reading}>
          {reading ? "Reading" : "Read shelf"}
        </button>
      </div>
      {(lost || notice || shelf.progress) && (
        <p className="absolute left-1/2 top-16 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-sm text-[#f3ecdf]">
          {notice || (lost ? "Hold the shelf steady." : shelf.progress)}
        </p>
      )}
      <div className="absolute inset-x-0 bottom-0 max-h-[46%] overflow-auto rounded-t-3xl bg-[#f3ecdf] text-[#1c1915]">
        {books.length ? <div className="p-4"><Legend books={books} /></div> : <p className="p-4 text-sm text-[#6d6458]">Frame the shelf, then read it once. The letters stay on the spines as you move.</p>}
      </div>
    </div>
  );
}
