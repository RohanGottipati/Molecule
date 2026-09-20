"use client";

import { useEffect, useRef } from "react";

/** A decorative character field; the native pointer and controls stay untouched. */
export function AsciiCursorTrail() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const motion = window.matchMedia(
      "(prefers-reduced-motion: no-preference) and (hover: hover) and (pointer: fine)",
    );
    const points: { x: number; y: number; born: number }[] = [];
    let frame = 0;
    let width = 0;
    let height = 0;
    let lastPoint = 0;
    const lifetime = 1100;
    const spacingX = 18;
    const spacingY = 24;

    function clear() {
      cancelAnimationFrame(frame);
      frame = 0;
      points.length = 0;
      context!.clearRect(0, 0, width, height);
    }

    function resize() {
      const bounds = canvas!.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(width * ratio);
      canvas!.height = Math.round(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      context!.font = '16px "SFMono-Regular", Consolas, monospace';
      context!.textAlign = "center";
      context!.textBaseline = "middle";
    }

    function draw(now: number) {
      context!.clearRect(0, 0, width, height);
      while (points.length && now - points[0]!.born > lifetime) points.shift();
      if (!points.length) {
        frame = 0;
        return;
      }

      // Limit drawing to the wake, rather than traversing the whole screen.
      const radius = 65;
      const left = Math.max(0, Math.min(...points.map((p) => p.x)) - radius);
      const right = Math.min(
        width,
        Math.max(...points.map((p) => p.x)) + radius,
      );
      const top = Math.max(0, Math.min(...points.map((p) => p.y)) - radius);
      const bottom = Math.min(
        height,
        Math.max(...points.map((p) => p.y)) + radius,
      );

      for (
        let y = Math.floor(top / spacingY) * spacingY;
        y < bottom;
        y += spacingY
      ) {
        for (
          let x = Math.floor(left / spacingX) * spacingX;
          x < right;
          x += spacingX
        ) {
          let strength = 0;
          for (const point of points) {
            const age = (now - point.born) / lifetime;
            const dx = x - point.x;
            const dy = y - point.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const ripple = Math.sin(distance / 38 - age * 5) * 12;
            const falloff = Math.max(0, 1 - (distance + ripple) / radius);
            strength = Math.max(strength, falloff * (1 - age));
          }
          if (strength < 0.07) continue;
          context!.fillStyle = `rgba(255,255,255,${Math.min(0.95, strength * 2)})`;
          context!.fillText(
            strength > 0.6 ? "o" : strength > 0.25 ? ">" : "_",
            x,
            y,
          );
        }
      }
      frame = requestAnimationFrame(draw);
    }

    function move(event: PointerEvent) {
      if (!motion.matches || event.pointerType !== "mouse" || document.hidden)
        return;
      const now = performance.now();
      if (now - lastPoint < 28) return;
      lastPoint = now;
      const bounds = canvas!.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      if (x < 0 || x > width || y < 0 || y > height) return;
      points.push({ x, y, born: now });
      if (points.length > 32) points.shift();
      if (!frame) frame = requestAnimationFrame(draw);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    motion.addEventListener("change", clear);
    return () => {
      clear();
      observer.disconnect();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
      motion.removeEventListener("change", clear);
    };
  }, []);

  return (
    <canvas ref={canvasRef} className="home-ascii-trail" aria-hidden="true" />
  );
}
