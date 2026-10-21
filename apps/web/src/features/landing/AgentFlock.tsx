"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "./use-reduced-motion";

/**
 * Ambient agents adapted from RidwanG206/localfirst-web/components/landing/AgentFlock.tsx.
 *
 * Agent orbit dots with wander, separation, and cursor repulsion, each
 * trailing a short fading line. The one change that makes it ours: the dots
 * are visibly contained — they bounce off the viewport boundary with a brief
 * lime flash at the contact point. Nothing leaves the machine, stated as a
 * background animation rather than a headline.
 */

const BASE_SPEED = 58;
const WANDER_RATE = 1.15;
const SEP_RADIUS = 66;
const SEP_STRENGTH = 1300;
const CURSOR_RADIUS = 380;
const CURSOR_STRENGTH = 1600;
const HOME_PULL = 0.18;
const HOME_PULL_OOB = 1.08;
const EDGE_MARGIN = 110;
const EDGE_PUSH = 900;
const EDGE_TURN = 3.2;
const DAMPING = 0.97;
const FLY_IN_MS = 1050;
const TRAIL_LEN = 9;

/** Plastic number (1.3247…) low-discrepancy sequence — even scatter with no
 *  visible grid and no clumping, which Math.random() won't give you. */
const PLASTIC = 1.32471795724474602596;
const A1 = 1 / PLASTIC;
const A2 = 1 / (PLASTIC * PLASTIC);
const frac = (n: number) => n - Math.floor(n);

type Dot = {
  /** Render position — the sim position, blended from `sx/sy` during fly-in. */
  x: number;
  y: number;
  /** Home. */
  hx: number;
  hy: number;
  /** Simulated position. */
  fx: number;
  fy: number;
  /** Off-screen fly-in origin. */
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  h: number;
  s1: number;
  s2: number;
  s3: number;
  r: number;
  accent: boolean;
  trail: number[];
};

type Flash = { x: number; y: number; t: number };

export type FlockTone = "ink" | "lime";

const TONES: Record<FlockTone, { base: string; accent: string; flash: string }> = {
  // On the lime field, ink reads; lime would not.
  ink: { base: "23, 21, 24", accent: "244, 241, 231", flash: "23, 21, 24" },
  // On graphite, lime and mist.
  lime: { base: "184, 242, 74", accent: "232, 236, 228", flash: "184, 242, 74" },
};

export function AgentFlock({
  count,
  tone = "ink",
  className,
}: {
  count: number;
  tone?: FlockTone;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const palette = TONES[tone];
    let w = 0;
    let h = 0;
    let dots: Dot[] = [];
    let flashes: Flash[] = [];
    let raf = 0;
    let last = performance.now();
    const start = performance.now();
    const cursor = { x: -9999, y: -9999 };

    const seed = () => {
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const n = window.innerWidth <= 640 ? Math.ceil(count / 2) : count;
      dots = Array.from({ length: n }, (_, i) => {
        const hx = frac(0.5 + A1 * (i + 1)) * w;
        const hy = frac(0.5 + A2 * (i + 1)) * h;
        const angle = frac(A1 * (i + 7)) * Math.PI * 2;
        // Fly in from off-screen, along the vector out from the centre.
        const ox = hx + Math.cos(angle) * (w + h);
        const oy = hy + Math.sin(angle) * (w + h);
        return {
          x: ox,
          y: oy,
          hx,
          hy,
          fx: hx,
          fy: hy,
          sx: ox,
          sy: oy,
          vx: 0,
          vy: 0,
          h: angle + Math.PI,
          s1: frac(A1 * (i + 3)) * Math.PI * 2,
          s2: frac(A2 * (i + 11)) * Math.PI * 2,
          s3: frac(A1 * (i + 19)) * Math.PI * 2,
          r: 1.6 + frac(A2 * (i + 5)) * 1.5,
          accent: i % 4 === 0,
          trail: [],
        };
      });
      flashes = [];
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);

      for (const d of dots) {
        // Trail — a short fading line behind each dot.
        if (d.trail.length >= 4) {
          for (let i = 2; i < d.trail.length; i += 2) {
            const a = (i / d.trail.length) * 0.28;
            ctx.strokeStyle = `rgba(${d.accent ? palette.accent : palette.base}, ${a})`;
            ctx.lineWidth = d.r * 0.5;
            ctx.beginPath();
            ctx.moveTo(d.trail[i - 2]!, d.trail[i - 1]!);
            ctx.lineTo(d.trail[i]!, (d.trail[i + 1] ?? d.trail[i - 1])!);
            ctx.stroke();
          }
        }
        ctx.fillStyle = `rgba(${d.accent ? palette.accent : palette.base}, ${d.accent ? 0.75 : 0.5})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Contact flashes on the boundary.
      for (const f of flashes) {
        const p = f.t / 480;
        ctx.strokeStyle = `rgba(${palette.flash}, ${(1 - p) * 0.55})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 3 + p * 20, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    const step = (now: number) => {
      const dt = Math.min(50, now - last) / 1000;
      last = now;
      const t = now / 1000;

      const elapsed = now - start;
      // Fly-in: cubic ease-out from off-screen over 1050ms.
      const flyT = Math.min(1, elapsed / FLY_IN_MS);
      const flyE = 1 - Math.pow(1 - flyT, 3);

      for (const d of dots) {

        // Heading drift — two summed sines seeded per dot.
        d.h +=
          (Math.sin(t * 0.9 + d.s1) + Math.sin(t * 0.47 + d.s2)) *
          0.5 *
          WANDER_RATE *
          dt;

        const speed = BASE_SPEED * (1 + 0.32 * Math.sin(t * 0.6 + d.s3));

        // First-order lag toward the heading velocity.
        let ax = (Math.cos(d.h) * speed - d.vx) * 2.2;
        let ay = (Math.sin(d.h) * speed - d.vy) * 2.2;

        // Separation.
        for (const o of dots) {
          if (o === d) continue;
          const dx = d.x - o.x;
          const dy = d.y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > SEP_RADIUS * SEP_RADIUS || d2 < 0.001) continue;
          const dist = Math.sqrt(d2);
          const f = (SEP_STRENGTH * (1 - dist / SEP_RADIUS)) / dist;
          ax += dx * f;
          ay += dy * f;
        }

        // Cursor repel.
        const cdx = d.x - cursor.x;
        const cdy = d.y - cursor.y;
        const cd2 = cdx * cdx + cdy * cdy;
        if (cd2 < CURSOR_RADIUS * CURSOR_RADIUS && cd2 > 0.001) {
          const dist = Math.sqrt(cd2);
          const f = (CURSOR_STRENGTH * (1 - dist / CURSOR_RADIUS)) / dist;
          ax += cdx * f;
          ay += cdy * f;
        }

        // Home pull — stronger once the dot is out of bounds.
        const oob = d.fx < 0 || d.fx > w || d.fy < 0 || d.fy > h;
        const k = oob ? HOME_PULL_OOB : HOME_PULL;
        ax += (d.hx - d.fx) * k;
        ay += (d.hy - d.fy) * k;

        // Edge push.
        if (d.fx < EDGE_MARGIN) {
          ax += EDGE_PUSH * (1 - d.fx / EDGE_MARGIN);
        } else if (d.fx > w - EDGE_MARGIN) {
          ax -= EDGE_PUSH * (1 - (w - d.fx) / EDGE_MARGIN);
        }
        if (d.fy < EDGE_MARGIN) {
          ay += EDGE_PUSH * (1 - d.fy / EDGE_MARGIN);
        } else if (d.fy > h - EDGE_MARGIN) {
          ay -= EDGE_PUSH * (1 - (h - d.fy) / EDGE_MARGIN);
        }

        // Turn the heading toward the inside of the box near any wall.
        const inwardX = d.fx < EDGE_MARGIN ? 1 : d.fx > w - EDGE_MARGIN ? -1 : 0;
        const inwardY = d.fy < EDGE_MARGIN ? 1 : d.fy > h - EDGE_MARGIN ? -1 : 0;
        if (inwardX || inwardY) {
          const target = Math.atan2(inwardY, inwardX);
          let diff = target - d.h;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          d.h += Math.sign(diff) * Math.min(Math.abs(diff), EDGE_TURN * dt);
        }

        d.vx = (d.vx + ax * dt) * DAMPING;
        d.vy = (d.vy + ay * dt) * DAMPING;

        d.fx += d.vx * dt;
        d.fy += d.vy * dt;

        // Containment: bounce, and flash where contact was made.
        if (d.fx < 0) {
          d.fx = 0;
          d.vx = Math.abs(d.vx);
          d.h = Math.PI - d.h;
          flashes.push({ x: 0, y: d.fy, t: 0 });
        } else if (d.fx > w) {
          d.fx = w;
          d.vx = -Math.abs(d.vx);
          d.h = Math.PI - d.h;
          flashes.push({ x: w, y: d.fy, t: 0 });
        }
        if (d.fy < 0) {
          d.fy = 0;
          d.vy = Math.abs(d.vy);
          d.h = -d.h;
          flashes.push({ x: d.fx, y: 0, t: 0 });
        } else if (d.fy > h) {
          d.fy = h;
          d.vy = -Math.abs(d.vy);
          d.h = -d.h;
          flashes.push({ x: d.fx, y: h, t: 0 });
        }

        // Blend from the off-screen origin over the fly-in.
        if (flyE >= 1) {
          d.x = d.fx;
          d.y = d.fy;
        } else {
          d.x = d.sx + (d.fx - d.sx) * flyE;
          d.y = d.sy + (d.fy - d.sy) * flyE;
        }

        d.trail.push(d.x, d.y);
        if (d.trail.length > TRAIL_LEN * 2) d.trail.splice(0, 2);
      }

      for (let i = flashes.length - 1; i >= 0; i--) {
        flashes[i]!.t += dt * 1000;
        if (flashes[i]!.t > 480) flashes.splice(i, 1);
      }

      draw();
      raf = requestAnimationFrame(step);
    };

    const onPointer = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      cursor.x = e.clientX - rect.left;
      cursor.y = e.clientY - rect.top;
    };
    const onLeave = () => {
      cursor.x = -9999;
      cursor.y = -9999;
    };

    seed();

    if (reduced) {
      // One static frame, no loop.
      for (const d of dots) {
        d.x = d.hx;
        d.y = d.hy;
        d.fx = d.hx;
        d.fy = d.hy;
      }
      draw();
      const onResize = () => {
        seed();
        for (const d of dots) {
          d.x = d.hx;
          d.y = d.hy;
        }
        draw();
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    raf = requestAnimationFrame(step);
    window.addEventListener("resize", seed);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", seed);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [count, tone, reduced]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
    />
  );
}
