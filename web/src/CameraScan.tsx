import { useEffect, useMemo, useRef, useState } from "react";
import { anchorsForCapture } from "./overlay/anchors";
import { saveFrame } from "./api";
import { AUTO_READ_KEY, createAutoRead } from "./overlay/auto-read";
import { captureFrames, type FrameState } from "./overlay/frames";
import { coverPoint } from "./overlay/geometry";
import { layoutLiveLabels, type LiveSlot } from "./overlay/live-layout";
import { createSteadyDetector } from "./overlay/steady";
import { grayFromRGBA, projectAnchor, type GrayFrame, type Mat3 } from "./overlay/track";
import type { TrackingReply } from "./overlay/tracking.worker";
import { withScores } from "./pipeline/score";
import { scanCanvas, type ScanTiming } from "./scan";
import { currentSession, useShelf } from "./store";
import type { Book } from "../../shared/types.ts";

// Labels stay where they were through a brief tracking failure, then hide; the capture is given
// up when no step has been tracked for longer.
const HIDE_AFTER_MS = 300;
const GIVE_UP_MS = 1500;
// The read frame waits this long for its lookups, so its metadata can carry every timing.
const RATINGS_WAIT_MS = 20_000;
const STEADY_WIDTH = 96;
const STEADY_EVERY_MS = 100;

const TIMING_FIELDS: Record<ScanTiming, string> = {
  "strips-encoded": "encodedMs",
  "first-label": "firstLabelMs",
  "all-labels": "labelsMs",
  "first-rating": "firstRatingMs",
  "all-ratings": "ratingsMs",
};

type ReadMeta = { captureId: string; video: { width: number; height: number }; timings: Record<string, number>; error: string | null; auto: boolean };

// Saved after the read so the upload does not compete with the strips.
async function saveReadFrame(frame: HTMLCanvasElement, settled: Promise<void>, meta: ReadMeta) {
  const blob = await new Promise<Blob | null>((resolve) => frame.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) return;
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, RATINGS_WAIT_MS))]);
  await saveFrame(blob, { kind: "read", ...meta });
}

function storedAuto() {
  try {
    return localStorage.getItem(AUTO_READ_KEY) !== "off";
  } catch {
    return true;
  }
}

function videoPixels(video: HTMLVideoElement, canvas: HTMLCanvasElement, width: number, height: number) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function grayFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, width: number) {
  const height = Math.max(1, Math.round(video.videoHeight * width / video.videoWidth));
  const pixels = videoPixels(video, canvas, width, height);
  return pixels && { gray: grayFromRGBA(pixels.data, width, height), width, height };
}

export function CameraScan({ onClose }: { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const samplingCanvas = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const activeId = useRef<string | null>(null);
  const latestRead = useRef<string | null>(null);
  const trackSize = useRef({ width: 0, height: 0 });
  const sourceSize = useRef({ width: 0, height: 0 });
  const busy = useRef(false);
  const lastTracked = useRef(0);
  const staleShown = useRef(false);
  const frameTime = useRef<number | null>(null);
  const frameState = useRef<FrameState | null>(null);
  const slots = useRef<ReadonlyMap<string, LiveSlot>>(new Map());
  const inFlight = useRef<"auto" | "tap" | null>(null);
  const lastScan = useRef<string | null>(null);
  const autoGate = useRef({ enabled: false, covered: false, sheetOpen: false });
  const latestSample = useRef<GrayFrame | null>(null);
  const readRef = useRef<(auto: boolean) => Promise<void>>(async () => undefined);
  const [autoRead] = useState(createAutoRead);
  const shelf = useShelf();
  const session = currentSession(shelf);
  const books = useMemo(() => withScores(session?.books ?? []), [session?.books]);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [projection, setProjection] = useState<{ h: Mat3; width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [notice, setNotice] = useState("");
  const [lost, setLost] = useState(false);
  const [stale, setStale] = useState(false);
  const [reading, setReading] = useState<"auto" | "tap" | null>(null);
  const [auto, setAuto] = useState(storedAuto);
  const [autoPaused, setAutoPaused] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);

  const currentBooks = session?.id === captureId ? books : [];
  const anchors = anchorsForCapture(currentBooks, captureId ?? "");
  const placedIds = new Set(anchors.map((anchor) => anchor.id));
  const review = currentBooks.flatMap((book) =>
    book.detections.filter((detection) => detection.captureId === captureId && !placedIds.has(detection.id ?? "")).map((detection) => ({
      id: detection.id ?? `${book.key}:${detection.strip}:${detection.position}`,
      title: detection.title.trim() || "Unread spine",
    })),
  );
  const selectedAnchor = anchors.find((anchor) => anchor.id === selected);
  const selectedBook = selectedAnchor?.book;
  const bottomInset = selectedBook || showReview ? 210 : 100;
  const targets = projection && !lost && !stale
    ? anchors.map((anchor) => {
        const point = projectAnchor(
          projection.h,
          anchor.box.x + anchor.box.w / 2,
          anchor.box.y + anchor.box.h / 2,
          projection.width,
          projection.height,
        );
        return { id: anchor.id, ...coverPoint(point.x, point.y, viewport.width, viewport.height, videoRef.current?.videoWidth || projection.width, videoRef.current?.videoHeight || projection.height) };
      })
    : [];
  const labels = layoutLiveLabels(targets, viewport.width, viewport.height, bottomInset, slots.current);
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const shown = labels.map((label) => {
    const anchor = byId.get(label.id)!;
    return { ...label, title: anchor.title, rating: anchor.showRating ? anchor.book.avgRating : null };
  });
  const baseStatus = notice || (lost ? "Tracking lost. Read the shelf again." : session?.id === captureId ? shelf.progress : "");
  const status = auto && autoPaused ? `${baseStatus ? `${baseStatus} ` : ""}Auto-read paused. Tap Read shelf to resume.` : baseStatus;

  useEffect(() => {
    frameState.current = { captureId, status, reading: reading !== null, lost, viewport, anchors: anchors.length, review: review.length, labels: shown };
    if (!stale) slots.current = new Map(labels.map((label) => [label.id, label]));
    autoGate.current = { enabled: auto, covered: Boolean(projection) && !lost && anchors.length > 0, sheetOpen: Boolean(selectedBook) || showReview };
    readRef.current = readShelf;
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return captureFrames(video, () => frameState.current);
  }, []);

  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./overlay/tracking.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<TrackingReply>) => {
      const reply = event.data;
      if (reply.captureId !== activeId.current) return;
      if (reply.type === "step") busy.current = false;
      if (reply.homography) {
        lastTracked.current = performance.now();
        staleShown.current = false;
        setStale(false);
        setProjection({ h: reply.homography, width: reply.width, height: reply.height });
        setLost(false);
        return;
      }
      // Labels hide on the first failed step, since a held label can sit on the wrong spine; the worker
      // keeps its state, so a later frame can still be tracked.
      if (reply.type === "step" && !staleShown.current) {
        staleShown.current = true;
        setStale(true);
      }
      if (reply.type === "step" && performance.now() - lastTracked.current <= GIVE_UP_MS) return;
      activeId.current = null;
      worker.postMessage({ type: "end", captureId: reply.captureId });
      setProjection(null);
      setLost(true);
      if (reply.type === "begin") setNotice("Not enough detail here to track labels.");
    };
    worker.onerror = () => {
      busy.current = false;
      setProjection(null);
      setLost(true);
      setNotice("Tracking is unavailable. Read the shelf again.");
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    let stream: MediaStream | null = null;
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice("Camera access needs HTTPS and a supported browser. Use a shelf photo instead.");
      return;
    }
    void navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
      .then((next) => {
        stream = next;
        if (cancelled) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        if (video) {
          video.srcObject = next;
          void video.play().catch(() => setNotice("Tap Read shelf after allowing the camera."));
        }
      })
      .catch(() => setNotice("The camera is unavailable. Use a shelf photo instead."));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let handle = 0;
    let stopped = false;
    let lastSample = 0;
    let lastSteady = 0;
    const detector = createSteadyDetector();
    const steadyCanvas = document.createElement("canvas");
    const autoReadIfSteady = (now: number) => {
      const frame = grayFrame(video, steadyCanvas, STEADY_WIDTH);
      if (!frame) return;
      latestSample.current = frame;
      const { steady } = detector.feed(frame, now);
      const gate = { ...autoGate.current, steady, reading: inFlight.current !== null, visible: document.visibilityState === "visible", now: performance.now() };
      if (autoRead.due(gate, frame)) void readRef.current(true);
    };
    const tick = (now: number, metadata?: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      const t = metadata?.captureTime ?? now;
      frameTime.current = t;
      let id = activeId.current;
      const worker = workerRef.current;
      if (id && (video.videoWidth !== sourceSize.current.width || video.videoHeight !== sourceSize.current.height)) {
        activeId.current = null;
        worker?.postMessage({ type: "reset" });
        setCaptureId(null);
        setProjection(null);
        setLost(true);
        setNotice("The camera view changed. Read the shelf again.");
        id = null;
      }
      if (id && !staleShown.current && performance.now() - lastTracked.current > HIDE_AFTER_MS) {
        staleShown.current = true;
        setStale(true);
      }
      if (id && worker && !busy.current && now - lastSample >= 80 && video.videoWidth && trackSize.current.width) {
        lastSample = now;
        const { width, height } = trackSize.current;
        const pixels = videoPixels(video, (samplingCanvas.current ??= document.createElement("canvas")), width, height);
        if (pixels) {
          busy.current = true;
          worker.postMessage({ type: "step", captureId: id, t, width, height, rgba: pixels.data.buffer }, [pixels.data.buffer]);
        }
      }
      if (autoGate.current.enabled && now - lastSteady >= STEADY_EVERY_MS && video.videoWidth) {
        lastSteady = now;
        autoReadIfSteady(now);
      }
      handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }, []);

  async function readShelf(auto: boolean) {
    const video = videoRef.current;
    const worker = workerRef.current;
    if (!auto) {
      autoRead.resume();
      setAutoPaused(false);
    }
    if (inFlight.current) {
      // A tap during an automatic read adopts it instead of starting a second one.
      if (!auto) {
        inFlight.current = "tap";
        setReading("tap");
      }
      return;
    }
    if (!video?.videoWidth || !worker) return;
    inFlight.current = auto ? "auto" : "tap";
    autoRead.started(performance.now(), auto || autoGate.current.enabled ? latestSample.current : null);
    setReading(inFlight.current);
    setNotice("");
    setSelected(null);
    setShowReview(false);
    setProjection(null);
    setLost(false);
    setStale(false);
    staleShown.current = false;
    busy.current = false;
    lastTracked.current = performance.now();
    const started = performance.now();
    const timings: Record<string, number> = {};
    let frame: HTMLCanvasElement | null = null;
    let settled: Promise<void> = Promise.resolve();
    let error = "";
    const id = crypto.randomUUID();
    latestRead.current = id;
    activeId.current = id;
    setCaptureId(id);
    worker.postMessage({ type: "reset" });
    try {
      const full = document.createElement("canvas");
      full.width = video.videoWidth;
      full.height = video.videoHeight;
      sourceSize.current = { width: full.width, height: full.height };
      const ctx = full.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("This browser cannot capture the shelf.");
      ctx.drawImage(video, 0, 0);
      frame = full;
      const trackWidth = Math.min(480, full.width);
      const trackHeight = Math.max(1, Math.round(full.height * trackWidth / full.width));
      trackSize.current = { width: trackWidth, height: trackHeight };
      // Drawn from the video like every later step, so the keyframe looks the same as they do.
      const keyframe = videoPixels(video, (samplingCanvas.current ??= document.createElement("canvas")), trackWidth, trackHeight);
      if (!keyframe) throw new Error("This browser cannot track the shelf.");
      const t = frameTime.current ?? performance.now();
      worker.postMessage({ type: "begin", captureId: id, t, width: trackWidth, height: trackHeight, rgba: keyframe.data.buffer }, [keyframe.data.buffer]);
      ({ settled } = await scanCanvas(full, {
        captureId: id,
        startedAt: started,
        onTiming: (name, ms) => { timings[TIMING_FIELDS[name]] = ms; },
      }));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The scan failed.";
      // Tracking loss may already have cleared activeId, but the failure is still this read's to report.
      if (latestRead.current === id) {
        if (activeId.current === id) {
          activeId.current = null;
          worker.postMessage({ type: "reset" });
        }
        setCaptureId(null);
        setProjection(null);
        setNotice(error);
      }
    } finally {
      const books = useShelf.getState().sessions.find((item) => item.id === id)?.books ?? [];
      const labelled = anchorsForCapture(books, id).length > 0;
      autoRead.finished(inFlight.current === "auto", labelled, performance.now());
      if (labelled) replaceRepeatScan(id, books);
      inFlight.current = null;
      setReading(null);
      setAutoPaused(autoRead.paused());
      if (frame) {
        const size = { width: sourceSize.current.width, height: sourceSize.current.height };
        void saveReadFrame(frame, settled, { captureId: id, video: size, timings, error: error || null, auto }).catch(() => undefined);
      }
    }
  }

  // Automatic re-reads of the same shelf would pile up in the scan history; a new scan whose
  // books mostly match the previous camera scan replaces it.
  function replaceRepeatScan(id: string, books: Book[]) {
    const previous = lastScan.current;
    lastScan.current = id;
    if (!previous || previous === id) return;
    const before = useShelf.getState().sessions.find((item) => item.id === previous)?.books ?? [];
    const keys = new Set(before.map((book) => book.key));
    const shared = books.filter((book) => keys.has(book.key)).length;
    if (before.length && shared / Math.min(before.length, books.length) >= 0.5) useShelf.getState().removeSession(previous);
  }

  function toggleAuto() {
    const next = !auto;
    setAuto(next);
    autoRead.resume();
    setAutoPaused(false);
    try {
      localStorage.setItem(AUTO_READ_KEY, next ? "on" : "off");
    } catch {
      // Without storage the choice lasts until the page reloads.
    }
  }

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-black text-[#f3ecdf]">
      <video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline />
      {projection && !lost && (
        <>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${viewport.width} ${viewport.height}`}>
            {labels.map((label) => (
              <g key={label.id} stroke="#f3ecdf" strokeWidth="1.5" fill="#f3ecdf">
                <path d={`M ${label.x} ${label.y} L ${label.leaderX} ${label.labelY + 22}`} fill="none" />
                <circle cx={label.x} cy={label.y} r="3" />
              </g>
            ))}
          </svg>
          {shown.map((label) => (
            <button
              key={label.id}
              type="button"
              data-spine-id={label.id}
              className="absolute flex h-[43px] w-[min(164px,42vw)] items-center gap-2 rounded-lg border border-[#f3ecdf] bg-[#1c1915]/90 px-2 text-left text-xs shadow-lg"
              style={{ left: label.labelX, top: label.labelY }}
              onClick={() => { setSelected(label.id); setShowReview(false); }}
              aria-label={`Details for ${label.title}`}
            >
              <span className="min-w-0 flex-1 truncate">{label.title}</span>
              {label.rating != null && <span className="shrink-0">{label.rating.toFixed(1)}★</span>}
            </button>
          ))}
        </>
      )}
      <div className="absolute left-4 top-4 flex gap-2">
        <button className="rounded-full bg-[#f3ecdf] px-3 py-1 text-[#1c1915]" type="button" onClick={() => void readShelf(false)} disabled={reading === "tap"} aria-busy={reading !== null}>
          {reading ? "Reading…" : captureId ? "Read again" : "Read shelf"}
        </button>
        <button
          className={`rounded-full border border-[#f3ecdf] px-3 py-1 ${auto ? "bg-[#f3ecdf] text-[#1c1915]" : "bg-black/50"}`}
          type="button"
          aria-pressed={auto}
          aria-label={auto ? "Auto-read on" : "Auto-read off"}
          onClick={toggleAuto}
        >
          Auto
        </button>
      </div>
      {status && (
        <p className="absolute left-1/2 top-16 w-max max-w-[85vw] -translate-x-1/2 rounded-xl bg-black/75 px-3 py-2 text-center text-sm">
          {status}
        </p>
      )}
      {notice.includes("camera") || notice.includes("Camera") ? (
        <button className="absolute left-4 top-28 rounded-full bg-[#f3ecdf] px-3 py-1 text-[#1c1915]" type="button" onClick={onClose}>Use a shelf photo</button>
      ) : null}
      <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-[#f3ecdf] p-3 text-[#1c1915]">
        {selectedBook ? (
          <div className="max-h-44 overflow-auto">
            <button className="float-right text-sm underline" type="button" onClick={() => setSelected(null)}>Close</button>
            <h2 className="serif pr-12 text-lg">{selectedAnchor?.title ?? selectedBook.canonicalTitle ?? selectedBook.detections[0]?.title}</h2>
            {/* When the lookup found a different book, its author, rating and summary are not this spine's. */}
            {selectedAnchor?.showRating ? (
              <>
                <p className="text-sm">{selectedBook.authors.join(", ")}{selectedBook.avgRating != null ? ` · ${selectedBook.avgRating.toFixed(2)}★` : ""}</p>
                {selectedBook.summary && <p className="mt-1 text-sm">{selectedBook.summary}</p>}
              </>
            ) : null}
          </div>
        ) : showReview ? (
          <div className="max-h-44 overflow-auto">
            <button className="float-right text-sm underline" type="button" onClick={() => setShowReview(false)}>Close</button>
            <h2 className="serif text-lg">Needs review</h2>
            <ul className="text-sm">{review.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{anchors.length ? `${labels.length} label${labels.length === 1 ? "" : "s"} visible${anchors.length > labels.length ? ` · ${anchors.length - labels.length} more in scan` : ""}` : auto && !autoPaused ? "Hold the camera still on the shelf to read it." : "Frame the shelf and tap Read shelf."}</span>
            {review.length > 0 && <button className="shrink-0 underline" type="button" onClick={() => setShowReview(true)}>{review.length} to review</button>}
          </div>
        )}
      </div>
    </div>
  );
}
