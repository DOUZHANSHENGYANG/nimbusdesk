import { useEffect, useRef } from "react";

/** Adapted from paintVideo in luoluo-121/neural-creator-dashboard,
 * commit 769d690fa1c06d985926d8f16772d15514b718e1 (PolyForm Noncommercial).
 * See docs/third-party/neural-creator-dashboard for the full license and notices.
 * Canvas composition avoids decoded-but-invisible video in embedded WebView2. */
export function NeuralMedia({ kind, paused, offset = 0 }: { kind: "orb" | "jellyfish"; paused: boolean; offset?: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = `${import.meta.env.BASE_URL}neural/${kind}`;

  useEffect(() => {
    const source = video.current;
    const target = canvas.current;
    if (!source || !target) return;
    const context = target.getContext("2d");
    if (!context) return;
    const poster = new Image();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let stamp = -Infinity;
    let lastPaint = 0;
    let disposed = false;

    const paint = (now = 0) => {
      const moving = !paused && !motion.matches && !document.hidden;
      const ready = source.readyState >= 2 && source.videoWidth > 0;
      const image = ready ? source : poster;
      const width = ready ? source.videoWidth : poster.naturalWidth;
      const height = ready ? source.videoHeight : poster.naturalHeight;
      if (!width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(target.clientWidth * dpr);
      const h = Math.round(target.clientHeight * dpr);
      if (!w || !h) return;
      const resized = target.width !== w || target.height !== h;
      if (!resized && stamp === (ready ? source.currentTime : -1)) return;
      if (moving && !resized && now - lastPaint < 32) return;
      if (resized) { target.width = w; target.height = h; }
      const scale = Math.max(w / width, h / height);
      const sw = w / scale;
      const sh = h / scale;
      context.clearRect(0, 0, w, h);
      context.drawImage(image, (width - sw) / 2, (height - sh) / 2, sw, sh, 0, 0, w, h);
      stamp = ready ? source.currentTime : -1;
      lastPaint = now;
    };
    const loop = (now: number) => { if (disposed) return; paint(now); frame = requestAnimationFrame(loop); };
    const sync = () => {
      cancelAnimationFrame(frame);
      if (paused || motion.matches || document.hidden) { source.pause(); paint(); }
      else { void source.play().catch(() => { /* The visible poster remains if playback is unavailable. */ }); frame = requestAnimationFrame(loop); }
    };
    const loaded = () => { paint(); sync(); };
    const metadata = () => { if (offset && source.duration > 0) source.currentTime = offset % source.duration; };
    poster.onload = () => paint();
    poster.src = `${base}.jpg`;
    source.addEventListener("loadeddata", loaded);
    source.addEventListener("seeked", loaded);
    source.addEventListener("loadedmetadata", metadata);
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    const observer = new ResizeObserver(() => { stamp = -Infinity; paint(); });
    observer.observe(target);
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      source.pause();
      poster.onload = null;
      observer.disconnect();
      source.removeEventListener("loadeddata", loaded);
      source.removeEventListener("seeked", loaded);
      source.removeEventListener("loadedmetadata", metadata);
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
    };
  }, [base, offset, paused]);

  return <span className="neural-media"><img src={`${base}.jpg`} alt="" draggable={false} /><video ref={video} src={`${base}.mp4`} poster={`${base}.jpg`} muted loop playsInline preload="auto" tabIndex={-1} aria-hidden="true" /><canvas ref={canvas} aria-hidden="true" /></span>;
}
