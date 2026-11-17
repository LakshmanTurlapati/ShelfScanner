import { App as NativeApp } from "@capacitor/app";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Book } from "../../shared/types.ts";
import { bookMatchesProfile } from "./match";
import { onBack } from "./back-stack";
import { CAMERA_INSECURE, cameraNotice, isNativeApp, openCameraSettings, ShelfNative } from "./native";
import { anchorsForCapture, type SpineAnchor } from "./overlay/anchors";
import type { Profile } from "./profile";
import { saveFrame } from "./api";
import { AUTO_READ_KEY, createAutoRead, sharpMoment } from "./overlay/auto-read";
import { captureFrames, type FrameState } from "./overlay/frames";
import { coverPoint, visibleBounds } from "./overlay/geometry";
import { layoutLiveLabels, type LiveSlot } from "./overlay/live-layout";
import { createSteadyDetector, MIN_TEXTURE } from "./overlay/steady";
import { grayFromRGBA, projectAnchor, type GrayFrame, type Mat3 } from "./overlay/track";
import type { RelocatedReply, TrackingReply, WorkerReply } from "./overlay/tracking.worker";
import { addRoot, coverage, createWalkMap, dropShadowed, evict, linkNode, mergeRoots, nearbyNodes, offsetBetween, removeNode } from "./overlay/walk-map";
import { withScores } from "./pipeline/score";
import { scanCanvas, type ScanTiming } from "./scan";
import { useShelf } from "./store";
import {
  activeWalk,
  continueWalk,
  currentWalk,
  enterSection,
  frameOffset,
  framePlace,
  joinFrames,
  notePosition,
  onWalkEnd,
  startFrame,
  startSection,
  walkDirection,
  walkLatest,
  walkPosition,
  walkSection,
  type Place,
  type PlaceSource,
} from "./walk";

// Labels stay where they were through a brief tracking failure, then hide; the capture is given
// up when no step has been tracked for longer.
const HIDE_AFTER_MS = 300;
const GIVE_UP_MS = 1500;
// The read frame waits this long for its lookups, so its metadata can carry every timing.
const RATINGS_WAIT_MS = 20_000;
const STEADY_WIDTH = 96;
const STEADY_EVERY_MS = 100;
// While nothing is tracked, earlier reads are looked for this often; while tracking holds, reads
// from other groups near here are looked for less often, alongside the tracking steps.
const RELOCATE_EVERY_MS = 250;
const PROBE_EVERY_MS = 500;
// Failed looks before a read may start, so walking back finds the earlier read instead of reading again.
const RELOCATE_TRIES = 2;
// Reads kept for walking back. Each keyframe is about 400 KB of grey in the tracking worker.
const MAX_PLACES = 40;
// Reads from other groups within this many frame widths of the view are worth looking for.
const PROBE_RANGE = 1.5;
const MAX_CANDIDATES = 6;
// Looking alongside a tracking step delays it, so fewer reads are tried there.
const MAX_PROBES = 3;

const TIMING_FIELDS: Record<ScanTiming, string> = {
  "strips-encoded": "encodedMs",
  "first-label": "firstLabelMs",
  "all-labels": "labelsMs",
  "first-rating": "firstRatingMs",
  "all-ratings": "ratingsMs",
};

type ReadMeta = { captureId: string; video: { width: number; height: number }; timings: Record<string, number>; error: string | null; auto: boolean };
type Projection = { nodeId: string; h: Mat3; width: number; height: number };
type LiveAnchor = SpineAnchor & { h: Mat3; seq: number };

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

/** The anchor for a label id, from whichever read it came from. */
function findAnchor(books: Book[], id: string) {
  for (const book of books) {
    const detection = book.detections.find((item) => item.id === id);
    if (detection?.captureId) return anchorsForCapture(books, detection.captureId).find((anchor) => anchor.id === id);
  }
  return undefined;
}

export function CameraScan({ onClose, paused = false, hidden = false, profile = null }: { onClose: () => void; paused?: boolean; hidden?: boolean; profile?: Profile | null }) {
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
  const autoGate = useRef({ enabled: false, coverage: 0, sheetOpen: false });
  // Read at sampling time: failed looks for earlier reads change it without a render.
  const awaitingRef = useRef<() => boolean>(() => false);
  const latestSample = useRef<GrayFrame | null>(null);
  const readRef = useRef<(auto: boolean) => Promise<void>>(async () => undefined);
  // The walk's reads and how they join, kept while the app is open (this view stays mounted).
  const walkMap = useRef(createWalkMap());
  const projectionRef = useRef<Projection | null>(null);
  const relocSeq = useRef(0);
  const relocating = useRef(false);
  const relocFails = useRef(0);
  const probeSent = useRef(false);
  const probeFails = useRef(0);
  const sampleNow = useRef(false);
  const lastTexture = useRef(0);
  const recentSharpness = useRef<number[]>([]);
  // New shelf: the next read starts its own group at x = 0 instead of joining the tracked one.
  const freshShelf = useRef(false);
  const [autoRead] = useState(createAutoRead);
  const shelf = useShelf();
  const session = shelf.sessions.find((item) => item.id === activeWalk()) ?? null;
  const books = useMemo(() => withScores(session?.books ?? []), [session?.books]);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [notice, setNotice] = useState("");
  const [lost, setLost] = useState(false);
  const [stale, setStale] = useState(false);
  const [reading, setReading] = useState<"auto" | "tap" | null>(null);
  const [auto, setAuto] = useState(storedAuto);
  const [autoPaused, setAutoPaused] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [section, setSection] = useState(walkSection);
  const [, setMapVersion] = useState(0);
  projectionRef.current = projection;

  const latestAnchors = anchorsForCapture(books, captureId ?? "");
  const placedIds = new Set(latestAnchors.map((anchor) => anchor.id));
  const review = books.flatMap((book) =>
    book.detections.filter((detection) => detection.captureId === captureId && !placedIds.has(detection.id ?? "")).map((detection) => ({
      id: detection.id ?? `${book.key}:${detection.strip}:${detection.position}`,
      title: detection.title.trim() || "Unread spine",
    })),
  );

  // Labels come from every read joined to the tracked one, not only the latest, so a read's
  // labels stay on their spines after the next read and come back when the view does.
  const frameW = videoRef.current?.videoWidth || projection?.width || 1;
  const frameH = videoRef.current?.videoHeight || projection?.height || 1;
  const tracking = projection && !lost ? projection : null;
  const nearby = (tracking ? nearbyNodes(walkMap.current, tracking.nodeId, tracking.h, tracking.width, tracking.height) : [])
    .map((item) => ({ ...item, anchors: anchorsForCapture(books, item.node.captureId) }));
  const liveAnchors: LiveAnchor[] = nearby.flatMap(({ node, h, anchors }) => anchors.map((anchor) => ({ ...anchor, h, seq: node.seq })));
  const crop = visibleBounds(viewport.width, viewport.height, frameW, frameH);
  const covered = tracking ? coverage(nearby.filter((item) => item.anchors.length > 0), tracking.width, tracking.height, crop) : 0;
  const coverScale = Math.max(viewport.width / frameW, viewport.height / frameH);
  const targets = tracking && !stale
    ? dropShadowed(liveAnchors.map((anchor) => {
        const point = projectAnchor(anchor.h, anchor.box.x + anchor.box.w / 2, anchor.box.y + anchor.box.h / 2, tracking.width, tracking.height);
        const screen = coverPoint(point.x, point.y, viewport.width, viewport.height, frameW, frameH);
        return { id: anchor.id, seq: anchor.seq, x: screen.x, y: screen.y, spine: anchor.box.w * frameW * coverScale };
      })).map(({ id, x, y }) => ({ id, x, y }))
    : [];
  const selectedAnchor = selected ? liveAnchors.find((anchor) => anchor.id === selected) ?? findAnchor(books, selected) : undefined;
  const selectedBook = selectedAnchor?.book;
  const bottomInset = selectedBook || showReview ? 210 : 100;
  const labels = layoutLiveLabels(targets, viewport.width, viewport.height, bottomInset, slots.current);
  const byId = new Map(liveAnchors.map((anchor) => [anchor.id, anchor]));
  const shown = labels.map((label) => {
    const anchor = byId.get(label.id)!;
    return {
      ...label,
      title: anchor.title,
      rating: anchor.showRating ? anchor.book.avgRating : null,
      forYou: bookMatchesProfile(anchor.book, profile),
    };
  });
  const latestShown = labels.filter((label) => placedIds.has(label.id)).length;
  const baseStatus = notice || (lost ? "Tracking lost. Read the shelf again." : session ? shelf.progress : "");
  const status = auto && autoPaused ? `${baseStatus ? `${baseStatus} ` : ""}Auto-read paused. Tap Read shelf to resume.` : baseStatus;

  /** Earlier reads worth looking for: same shelf and nearest first, then the newest. */
  function candidates(options: { exceptRoot?: string; first?: string | null; range?: number; limit?: number; sameShelf?: boolean } = {}) {
    const position = walkPosition();
    const current = walkSection();
    const scored = [...walkMap.current.nodes.values()]
      .filter((node) => node.captureId !== options.first && node.root !== options.exceptRoot && (!options.sameShelf || node.section === current))
      .map((node) => {
        const place = framePlace(node.captureId);
        const near = place && position && place.section === position.section ? Math.abs(place.x + 0.5 - position.x) : Infinity;
        return { node, near, same: node.section === current };
      })
      .filter((item) => options.range === undefined || item.near <= options.range || !item.same)
      .sort((a, b) => Number(b.same) - Number(a.same) || a.near - b.near || b.node.seq - a.node.seq);
    const ids = scored.map((item) => item.node.captureId);
    return (options.first ? [options.first, ...ids] : ids).slice(0, options.limit ?? MAX_CANDIDATES);
  }

  // A tracked read near reads it is not joined to has not been ruled out as one of them yet.
  // Only while a look can actually run: a camera that changed size matches no stored keyframe.
  function awaitingRelocation() {
    const video = videoRef.current;
    if (!walkMap.current.nodes.size || !video || video.videoWidth !== sourceSize.current.width || video.videoHeight !== sourceSize.current.height) return false;
    const active = activeId.current ? walkMap.current.nodes.get(activeId.current) : null;
    if (!activeId.current || !active) return relocFails.current < RELOCATE_TRIES;
    const position = walkPosition();
    const near = position && [...walkMap.current.nodes.values()].some((node) => {
      if (node.root === active.root || node.section !== position.section) return false;
      const place = framePlace(node.captureId);
      return place !== null && Math.abs(place.x + 0.5 - position.x) <= PROBE_RANGE;
    });
    return Boolean(near) && probeFails.current < RELOCATE_TRIES;
  }

  useEffect(() => {
    frameState.current = {
      captureId,
      activeId: projection?.nodeId ?? null,
      status,
      reading: reading !== null,
      lost,
      viewport,
      anchors: latestAnchors.length,
      review: review.length,
      labels: paused ? [] : shown,
    };
    if (!stale) slots.current = new Map(labels.map((label) => [label.id, label]));
    autoGate.current = { enabled: auto && !paused, coverage: covered, sheetOpen: Boolean(selectedBook) || showReview };
    awaitingRef.current = awaitingRelocation;
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
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./overlay/tracking.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const map = walkMap.current;

    const forget = (ids: string[]) => {
      if (ids.length) worker.postMessage({ type: "forget", captureIds: ids });
    };
    const keepRecent = () => {
      const keep = new Set([activeId.current, projectionRef.current?.nodeId].filter((id): id is string => Boolean(id)));
      forget(evict(map, MAX_PLACES, keep));
    };
    const enter = (next: number) => {
      if (next === walkSection()) return;
      enterSection(next);
      setSection(next);
    };

    // The read's keyframe joins the read it was tracked from, or an earlier read it was found to show.
    const placed = (reply: TrackingReply) => {
      if (!reply.ok) return;
      let node = reply.link ? linkNode(map, reply.captureId, reply.link.from, reply.link.h, reply.width, reply.height) : null;
      if (node && reply.link) {
        joinFrames(reply.captureId, reply.link.from, frameOffset(reply.link.h, reply.width, reply.height));
        enter(node.section);
      } else node = addRoot(map, reply.captureId, reply.width, reply.height, framePlace(reply.captureId)?.section ?? walkSection());
      keepRecent();
      setMapVersion((version) => version + 1);
    };

    // Both reads are in this frame, so their groups become one.
    const probed = (reply: TrackingReply) => {
      if (!probeSent.current) return;
      probeSent.current = false;
      if (!reply.probe || !reply.homography) {
        probeFails.current += 1;
        return;
      }
      const moved = mergeRoots(map, reply.captureId, reply.homography, reply.probe.from, reply.probe.h);
      probeFails.current = 0;
      if (!moved) return;
      const offset = offsetBetween(map, reply.captureId, reply.probe.from);
      if (offset !== null) joinFrames(reply.captureId, reply.probe.from, offset);
      setMapVersion((version) => version + 1);
    };

    const relocated = (reply: RelocatedReply) => {
      relocating.current = false;
      if (reply.seq !== relocSeq.current) return;
      if (!reply.captureId || !reply.homography) {
        relocFails.current += 1;
        return;
      }
      const node = map.nodes.get(reply.captureId);
      if (!node || activeId.current || inFlight.current) return;
      // Walking back: the earlier read's track resumes and its labels return without a read.
      relocFails.current = 0;
      probeFails.current = 0;
      activeId.current = reply.captureId;
      busy.current = false;
      sampleNow.current = true;
      lastTracked.current = performance.now();
      staleShown.current = false;
      trackSize.current = { width: reply.width, height: reply.height };
      setStale(false);
      setLost(false);
      setNotice((current) => (current === "Not enough detail here to track labels." ? "" : current));
      setProjection({ nodeId: reply.captureId, h: reply.homography, width: reply.width, height: reply.height });
      enter(node.section);
    };

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === "relocated") {
        relocated(reply);
        return;
      }
      if (reply.captureId !== activeId.current) return;
      if (reply.type === "step") busy.current = false;
      if (reply.type === "begin") placed(reply);
      if (reply.homography) {
        lastTracked.current = performance.now();
        staleShown.current = false;
        setStale(false);
        setProjection({ nodeId: reply.captureId, h: reply.homography, width: reply.width, height: reply.height });
        setLost(false);
        const place = framePlace(reply.captureId);
        if (place) notePosition(place.section, place.x + frameOffset(reply.homography, reply.width, reply.height) + 0.5);
        if (reply.type === "step") probed(reply);
        return;
      }
      if (reply.type === "step") probed(reply);
      // Labels hide on the first failed step, since a held label can sit on the wrong spine; the worker
      // keeps its state, so a later frame can still be tracked.
      if (reply.type === "step" && !staleShown.current) {
        staleShown.current = true;
        setStale(true);
      }
      if (reply.type === "step" && performance.now() - lastTracked.current <= GIVE_UP_MS) return;
      // Keep the tracker through a slow read so a later good frame can still place its labels.
      if (reply.type === "step" && inFlight.current) {
        setProjection(null);
        setLost(true);
        return;
      }
      activeId.current = null;
      relocFails.current = 0;
      worker.postMessage({ type: "end", captureId: reply.captureId });
      setProjection(null);
      setLost(true);
      if (reply.type === "begin") setNotice("Not enough detail here to track labels.");
    };
    worker.onerror = () => {
      busy.current = false;
      relocating.current = false;
      setProjection(null);
      setLost(true);
      setNotice("Tracking is unavailable. Read the shelf again.");
    };
    const unsubscribe = onWalkEnd(() => {
      map.nodes.clear();
      worker.postMessage({ type: "forget" });
      activeId.current = null;
      setProjection(null);
      setCaptureId(null);
      setSection(1);
      setMapVersion((version) => version + 1);
    });
    return () => {
      unsubscribe();
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const restartCamera = useRef<() => void>(() => undefined);
  const stopCamera = useRef<() => void>(() => undefined);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const cameraNoticeShown = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    let stream: MediaStream | null = null;
    let cancelled = false;
    let starting = false;
    let backgrounded = false;
    const stop = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (video) video.srcObject = null;
    };
    const start = () => {
      if (cancelled || !video || starting || pausedRef.current) return;
      if (stream?.getVideoTracks().some((track) => track.readyState === "live")) return;
      starting = true;
      stop();
      if (!navigator.mediaDevices?.getUserMedia) {
        starting = false;
        setNotice(CAMERA_INSECURE);
        return;
      }
      void navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
        .then((next) => {
          starting = false;
          if (cancelled || backgrounded || pausedRef.current) {
            next.getTracks().forEach((track) => track.stop());
            return;
          }
          stream = next;
          next.getVideoTracks().forEach((track) => {
            track.onended = () => {
              if (!cancelled && !backgrounded && document.visibilityState === "visible") start();
            };
          });
          video.srcObject = next;
          if (cameraNoticeShown.current) {
            cameraNoticeShown.current = false;
            setNotice("");
          }
          void video.play().catch(() => setNotice("Tap Read shelf after allowing the camera."));
        })
        .catch(() => {
          starting = false;
          void cameraNotice().then((message) => {
            if (cancelled) return;
            cameraNoticeShown.current = true;
            setNotice(message);
          });
        });
    };
    // Coming back is not a request for the camera. Closing the permission dialog also resumes the
    // activity, and asking again straight after a deny turns it into a permanent block on Android 11+.
    const resume = () => {
      backgrounded = false;
      if (!isNativeApp()) {
        start();
        return;
      }
      void ShelfNative.cameraAccess()
        .then((access) => {
          if (access.state === "granted") start();
        })
        .catch(() => undefined);
    };
    const background = () => {
      backgrounded = true;
      stop();
    };
    restartCamera.current = start;
    stopCamera.current = stop;
    start();
    const onVisible = () => {
      if (document.visibilityState === "visible") resume();
      else background();
    };
    document.addEventListener("visibilitychange", onVisible);
    const subscription = isNativeApp()
      ? NativeApp.addListener("appStateChange", ({ isActive }) => {
          if (isActive) resume();
          else background();
        })
      : null;
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (subscription) void subscription.then((handle) => handle.remove());
      stop();
    };
  }, []);

  // The camera waits for the splash and the profile quiz, so the permission prompt comes with the
  // live view behind it rather than over an unrelated screen. It also stops while the Shelf is open.
  useEffect(() => {
    if (paused) stopCamera.current();
    else restartCamera.current();
  }, [paused]);

  useEffect(() => {
    if (!selectedBook && !showReview) return;
    return onBack(() => {
      setSelected(null);
      setShowReview(false);
    });
  }, [selectedBook, showReview]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let handle = 0;
    let stopped = false;
    let lastSample = 0;
    let lastSteady = 0;
    let lastRelocate = 0;
    let lastProbe = 0;
    const detector = createSteadyDetector();
    const steadyCanvas = document.createElement("canvas");
    // Sampled whenever the camera runs: auto-read uses it, and so does looking for earlier reads.
    const sample = (now: number) => {
      const frame = grayFrame(video, steadyCanvas, STEADY_WIDTH);
      if (!frame) return;
      latestSample.current = frame;
      const reading = detector.feed(frame, now);
      lastTexture.current = reading.texture;
      const sharp = reading.texture >= MIN_TEXTURE && sharpMoment(reading.sharpness, recentSharpness.current);
      recentSharpness.current = [...recentSharpness.current.slice(-2), reading.sharpness];
      if (!autoGate.current.enabled) return;
      const gate = {
        ...autoGate.current,
        awaitingRelocation: awaitingRef.current(),
        steady: reading.steady,
        sharp,
        reading: inFlight.current !== null,
        visible: document.visibilityState === "visible",
        now: performance.now(),
      };
      if (autoRead.due(gate, frame)) void readRef.current(true);
    };
    const tick = (now: number, metadata?: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      const t = metadata?.captureTime ?? now;
      frameTime.current = t;
      let id = activeId.current;
      const worker = workerRef.current;
      if (sampleNow.current) {
        sampleNow.current = false;
        lastSample = 0;
      }
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
          const active = walkMap.current.nodes.get(id);
          const probe = active && !inFlight.current && now - lastProbe >= PROBE_EVERY_MS
            // Only reads on this shelf: New shelf in front of the same books still means a new section.
            ? candidates({ exceptRoot: active.root, range: PROBE_RANGE, limit: MAX_PROBES, sameShelf: true })
            : [];
          if (probe.length) {
            lastProbe = now;
            probeSent.current = true;
          }
          worker.postMessage({ type: "step", captureId: id, t, width, height, rgba: pixels.data.buffer, probe }, [pixels.data.buffer]);
        }
      }
      if (!id && worker && !inFlight.current && !relocating.current && now - lastRelocate >= RELOCATE_EVERY_MS &&
          video.videoWidth && trackSize.current.width && lastTexture.current >= MIN_TEXTURE &&
          video.videoWidth === sourceSize.current.width && video.videoHeight === sourceSize.current.height) {
        const list = candidates();
        if (list.length) {
          lastRelocate = now;
          const { width, height } = trackSize.current;
          const pixels = videoPixels(video, (samplingCanvas.current ??= document.createElement("canvas")), width, height);
          if (pixels) {
            relocating.current = true;
            worker.postMessage({ type: "relocate", seq: relocSeq.current, t, width, height, rgba: pixels.data.buffer, candidates: list }, [pixels.data.buffer]);
          }
        }
      }
      if (now - lastSteady >= STEADY_EVERY_MS && video.videoWidth) {
        lastSteady = now;
        sample(now);
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

  /** Where the new read starts on the shelf, until a link or matched titles place it better. */
  function firstPlace(tracked: Projection | null): { place: Place; source: PlaceSource } {
    const latest = walkLatest();
    if (freshShelf.current || !latest) return { place: { x: 0, rowOffset: 0, section: walkSection() }, source: "fixed" };
    const from = tracked && framePlace(tracked.nodeId);
    if (tracked && from) {
      return { place: { x: from.x + frameOffset(tracked.h, tracked.width, tracked.height), rowOffset: from.rowOffset, section: from.section }, source: "guess" };
    }
    // Tracking was lost on the way: one frame on in the direction the walk was going.
    const last = framePlace(latest);
    const position = walkPosition();
    const x = (position ? position.x - 0.5 : last?.x ?? 0) + walkDirection();
    return { place: { x, rowOffset: last?.rowOffset ?? 0, section: walkSection() }, source: "guess" };
  }

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
    setLost(false);
    setStale(false);
    staleShown.current = false;
    busy.current = false;
    lastTracked.current = performance.now();
    // A look for an earlier read still in flight belongs to the view before this read.
    relocSeq.current += 1;
    relocFails.current = 0;
    probeFails.current = 0;
    probeSent.current = false;
    const started = performance.now();
    const timings: Record<string, number> = {};
    let frame: HTMLCanvasElement | null = null;
    let settled: Promise<void> = Promise.resolve();
    let error = "";
    const walking = currentWalk();
    const sessionId = walking && useShelf.getState().sessions.some((item) => item.id === walking) ? walking : crypto.randomUUID();
    continueWalk(sessionId);
    const tracked = projection && !lost && activeId.current === projection.nodeId ? projection : null;
    const fresh = freshShelf.current;
    const linkFrom = fresh ? null : tracked?.nodeId ?? null;
    const frameId = crypto.randomUUID();
    const { place, source } = firstPlace(tracked);
    startFrame(frameId, place, source);
    freshShelf.current = false;
    latestRead.current = frameId;
    activeId.current = frameId;
    setCaptureId(frameId);
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
      // The worker steps the tracked read onto this keyframe to join them; failing that, it looks for
      // the keyframe among earlier reads. New shelf joins nothing.
      worker.postMessage({
        type: "begin",
        captureId: frameId,
        t,
        width: trackWidth,
        height: trackHeight,
        rgba: keyframe.data.buffer,
        link: Boolean(linkFrom),
        candidates: fresh ? [] : candidates({ first: linkFrom }),
      }, [keyframe.data.buffer]);
      ({ settled } = await scanCanvas(full, {
        captureId: frameId,
        sessionId,
        startedAt: started,
        onTiming: (name, ms) => { timings[TIMING_FIELDS[name]] = ms; },
      }));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The scan failed.";
      // A read with no books is no place to come back to.
      removeNode(walkMap.current, frameId);
      worker.postMessage({ type: "forget", captureIds: [frameId] });
      // Tracking loss may already have cleared activeId, but the failure is still this read's to report.
      if (latestRead.current === frameId) {
        if (activeId.current === frameId) {
          activeId.current = null;
          worker.postMessage({ type: "reset" });
        }
        setCaptureId(null);
        setProjection(null);
        setNotice(error);
      }
    } finally {
      const seen = useShelf.getState().sessions.find((item) => item.id === sessionId)?.books ?? [];
      const labelled = anchorsForCapture(seen, frameId).length > 0;
      autoRead.finished(inFlight.current === "auto", labelled, performance.now());
      inFlight.current = null;
      setReading(null);
      setAutoPaused(autoRead.paused());
      if (frame) {
        const size = { width: sourceSize.current.width, height: sourceSize.current.height };
        void saveReadFrame(frame, settled, { captureId: frameId, video: size, timings, error: error || null, auto }).catch(() => undefined);
      }
    }
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

  function newShelf() {
    setSection(startSection());
    freshShelf.current = true;
  }

  const walkRow = Boolean(session);
  const statusTop = walkRow ? "6.25rem" : "4rem";

  return (
    <div className={`fixed inset-0 z-40 overflow-hidden bg-black text-[#fffaf6] ${hidden ? "hidden" : ""}`}>
      <video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline />
      {tracking && (
        <>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${viewport.width} ${viewport.height}`}>
            {labels.map((label) => (
              <g key={label.id} stroke="#ff6b35" strokeWidth="1.5" fill="#ff6b35">
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
              className={`absolute flex h-[43px] w-[min(164px,42vw)] items-center gap-2 rounded-lg border bg-[rgba(32,25,23,0.9)] px-2 text-left text-xs text-[#fffaf6] shadow-[0_10px_15px_rgba(0,0,0,0.3)] ${label.forYou ? "border-[#c4b5fd] ring-2 ring-[#7c3aed]" : "border-[rgba(255,140,66,0.6)]"}`}
              style={{ left: label.labelX, top: label.labelY }}
              onClick={() => { setSelected(label.id); setShowReview(false); }}
              aria-label={`Details for ${label.title}`}
            >
              <span className="min-w-0 flex-1 truncate">{label.title}</span>
              {label.forYou && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#e9d5ff]">For you</span>}
              {label.rating != null && <span className="shrink-0">{label.rating.toFixed(1)}★</span>}
            </button>
          ))}
        </>
      )}
      <div className="absolute left-4 flex gap-2" style={{ top: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}>
        <button className="rounded-full bg-[#ff6b35] px-3 py-1 font-semibold text-[#1f1a17]" type="button" onClick={() => void readShelf(false)} disabled={reading === "tap"} aria-busy={reading !== null}>
          {reading ? "Reading…" : captureId ? "Read again" : "Read shelf"}
        </button>
        <button
          className={`rounded-full border border-[#fffaf6] px-3 py-1 ${auto ? "bg-[#fffaf6] text-[#1f1a17]" : "bg-black/50 text-[#fffaf6]"}`}
          type="button"
          aria-pressed={auto}
          aria-label={auto ? "Auto-read on" : "Auto-read off"}
          onClick={toggleAuto}
        >
          Auto
        </button>
      </div>
      {walkRow && (
        <div className="absolute left-4 flex items-center gap-2 text-sm" style={{ top: "calc(env(safe-area-inset-top, 0px) + 3.5rem)" }}>
          <span className="rounded-full bg-black/60 px-3 py-1" aria-live="polite">Shelf {section}</span>
          <button className="rounded-full border border-[#fffaf6] bg-black/50 px-3 py-1" type="button" onClick={newShelf}>New shelf</button>
        </div>
      )}
      {status && (
        <p className="absolute left-1/2 w-max max-w-[85vw] -translate-x-1/2 rounded-xl bg-black/75 px-3 py-2 text-center text-sm" style={{ top: `calc(env(safe-area-inset-top, 0px) + ${statusTop})` }}>
          {status}
        </p>
      )}
      {notice.includes("camera") || notice.includes("Camera") ? (
        <div className="absolute left-4 flex gap-2" style={{ top: "calc(env(safe-area-inset-top, 0px) + 7rem)" }}>
          <button className="rounded-full bg-[#fffaf6] px-3 py-1 text-[#1f1a17]" type="button" onClick={onClose}>Use a shelf photo</button>
          <button className="rounded-full border border-[#fffaf6] bg-black/50 px-3 py-1 text-[#fffaf6]" type="button" onClick={() => restartCamera.current()}>Try again</button>
          {notice.includes("Camera access is off") && isNativeApp() ? (
            <button className="rounded-full bg-[#fffaf6] px-3 py-1 text-[#1f1a17]" type="button" onClick={() => void openCameraSettings()}>Open settings</button>
          ) : null}
        </div>
      ) : null}
      <div className="absolute inset-x-0 bottom-0 rounded-tl-[18px] rounded-tr-2xl bg-[#fffaf6] p-3 text-[#1f1a17]" style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}>
        {selectedBook ? (
          <div className="max-h-44 overflow-auto">
            <button className="float-right text-sm underline" type="button" onClick={() => setSelected(null)}>Close</button>
            <h2 className="display pr-12 text-lg">{selectedAnchor?.title ?? selectedBook.canonicalTitle ?? selectedBook.detections[0]?.title}</h2>
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
            <h2 className="display text-lg">Needs review</h2>
            <ul className="text-sm">{review.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{labels.length || latestAnchors.length ? `${labels.length} label${labels.length === 1 ? "" : "s"} visible${latestAnchors.length > latestShown ? ` · ${latestAnchors.length - latestShown} more in scan` : ""}` : auto && !autoPaused ? "Hold the camera still on the shelf to read it." : "Frame the shelf and tap Read shelf."}</span>
            {review.length > 0 && <button className="shrink-0 underline" type="button" onClick={() => setShowReview(true)}>{review.length} to review</button>}
          </div>
        )}
      </div>
    </div>
  );
}
