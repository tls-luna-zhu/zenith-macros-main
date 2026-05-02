"use client";

import { useEffect, useRef } from "react";

/**
 * Premium payment-page background.
 * Combines cursor-reactive glow orbs (from CursorBg) with:
 *   • Dot-grid overlay (Antigravity-style)
 *   • Floating ambient glyphs that drift slowly
 *   • Subtle diagonal line grid
 *   • Noise / grain film overlay for depth
 *   • Stronger static corner glow sources
 */

const GLYPHS = [
  { char: "</>",  mono: true  },
  { char: "{ }",  mono: true  },
  { char: "→",    mono: false },
  { char: "⌘",    mono: false },
  { char: "◈",    mono: false },
  { char: "#",    mono: true  },
  { char: "⚡",   mono: false },
  { char: "▲",    mono: false },
  { char: "⬡",    mono: false },
  { char: "⌥",    mono: false },
  { char: "⊕",    mono: false },
  { char: "∞",    mono: false },
  { char: "◇",    mono: false },
  { char: "⏎",    mono: false },
  { char: "≡",    mono: true  },
  { char: "⋯",    mono: true  },
  { char: "◉",    mono: false },
  { char: "※",    mono: false },
  { char: "⬟",    mono: false },
  { char: "⌦",    mono: false },
];

// Deterministic pseudo-random positions so SSR and client match
function seededVal(seed: number, scale: number, offset: number) {
  return ((Math.sin(seed * 127.1 + 311.7) * 43758.5453) % 1) * scale + offset;
}

const GLYPH_DATA = GLYPHS.map((g, i) => ({
  ...g,
  x:        seededVal(i * 3,     80, 5),       // 5–85 vw
  y:        seededVal(i * 7 + 1, 78, 5),       // 5–83 vh
  size:     Math.round(seededVal(i * 2 + 5, 10, 11)), // 11–21 px
  opacity:  +(seededVal(i * 5 + 3, 0.055, 0.03)).toFixed(3), // 0.03–0.085
  dur:      +(seededVal(i * 4 + 9, 18, 14)).toFixed(1),       // 14–32 s
  delay:    -(seededVal(i * 6 + 2, 20, 0)).toFixed(1),        // 0 – -20 s
  variant:  i % 3,   // 3 animation variants
}));

export function PremiumBg() {
  const hot   = useRef<HTMLDivElement>(null);
  const mid   = useRef<HTMLDivElement>(null);
  const amb   = useRef<HTMLDivElement>(null);
  const deep  = useRef<HTMLDivElement>(null);
  const trail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let mx = cx, my = cy;
    let hx = cx, hy = cy;
    let mx2 = cx, my2 = cy;
    let ax = cx, ay = cy;
    let dx = cx, dy = cy;
    let tx = cx, ty = cy;

    const onMove = (e: MouseEvent) => { mx = e.clientX; my = e.clientY; };
    window.addEventListener("mousemove", onMove, { passive: true });

    let raf: number;
    const tick = () => {
      hx  += (mx - hx)  * 0.26;
      hy  += (my - hy)  * 0.26;
      tx  += (mx - tx)  * 0.18;
      ty  += (my - ty)  * 0.18;
      mx2 += (mx - mx2) * 0.07;
      my2 += (my - my2) * 0.07;
      ax  += (mx - ax)  * 0.032;
      ay  += (my - ay)  * 0.032;
      dx  += (mx - dx)  * 0.012;
      dy  += (my - dy)  * 0.012;

      const move = (el: HTMLDivElement | null, x: number, y: number) => {
        if (!el) return;
        el.style.left = x + "px";
        el.style.top  = y + "px";
      };
      move(hot.current,   hx,  hy);
      move(trail.current, tx,  ty);
      move(mid.current,   mx2, my2);
      move(amb.current,   ax,  ay);
      move(deep.current,  dx,  dy);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  const base: React.CSSProperties = {
    position: "fixed",
    borderRadius: "50%",
    pointerEvents: "none",
    willChange: "left, top",
    transform: "translate(-50%, -50%)",
  };

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", zIndex: 0, pointerEvents: "none" }}>

      {/* ── Keyframe animations injected once ── */}
      <style>{`
        @keyframes pglyph0 {
          0%,100% { transform: translateY(0px)   rotate(0deg);   opacity: var(--go); }
          30%     { transform: translateY(-16px)  rotate(3deg);   opacity: calc(var(--go) * 1.6); }
          65%     { transform: translateY(9px)    rotate(-2deg);  opacity: var(--go); }
        }
        @keyframes pglyph1 {
          0%,100% { transform: translateY(0px)   rotate(0deg);   opacity: var(--go); }
          40%     { transform: translateY(13px)   rotate(-3deg);  opacity: calc(var(--go) * 1.5); }
          72%     { transform: translateY(-10px)  rotate(2deg);   opacity: var(--go); }
        }
        @keyframes pglyph2 {
          0%,100% { transform: translate(0,0)    rotate(0deg);   opacity: var(--go); }
          25%     { transform: translate(8px,-12px) rotate(2deg); opacity: calc(var(--go) * 1.7); }
          60%     { transform: translate(-6px,9px) rotate(-1deg); opacity: var(--go); }
        }
      `}</style>

      {/* ── Base very-dark background ── */}
      <div style={{ position: "fixed", inset: 0, background: "#06050f" }} />

      {/* ── Dot grid ── */}
      <div style={{
        position: "fixed", inset: 0,
        backgroundImage: "radial-gradient(circle, rgba(168,85,247,0.28) 1px, transparent 1px)",
        backgroundSize: "28px 28px",
      }} />

      {/* ── Diagonal-line accent grid (very subtle) ── */}
      <div style={{
        position: "fixed", inset: 0, opacity: 0.025,
        backgroundImage: `repeating-linear-gradient(
          -45deg,
          rgba(168,85,247,1) 0px,
          rgba(168,85,247,1) 1px,
          transparent 1px,
          transparent 48px
        )`,
      }} />

      {/* ── Corner glow sources (static, always visible) ── */}
      <div style={{
        position: "fixed", inset: 0,
        background: "radial-gradient(ellipse 80% 55% at 50% -8%, rgba(124,58,237,0.24) 0%, transparent 65%)",
      }} />
      <div style={{
        position: "fixed", top: "-25%", right: "-15%",
        width: 900, height: 900, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(88,28,135,0.30) 0%, transparent 70%)",
        filter: "blur(90px)",
      }} />
      <div style={{
        position: "fixed", bottom: "-20%", left: "-10%",
        width: 700, height: 700, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(109,40,217,0.22) 0%, transparent 70%)",
        filter: "blur(80px)",
      }} />
      <div style={{
        position: "fixed", top: "40%", left: "-15%",
        width: 500, height: 500, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(76,29,149,0.18) 0%, transparent 70%)",
        filter: "blur(70px)",
      }} />

      {/* ── Floating ambient glyphs ── */}
      {GLYPH_DATA.map((g, i) => (
        <div
          key={i}
          style={{
            position: "fixed",
            left: `${g.x}%`,
            top: `${g.y}%`,
            fontSize: g.size,
            color: "rgba(168,85,247,1)",
            fontFamily: g.mono ? "'JetBrains Mono','Fira Code',monospace" : "inherit",
            fontWeight: g.mono ? 500 : 400,
            userSelect: "none",
            lineHeight: 1,
            // CSS custom property for opacity animation
            ["--go" as string]: g.opacity,
            opacity: g.opacity,
            animation: `pglyph${g.variant} ${g.dur}s ease-in-out ${g.delay}s infinite`,
          }}
        >
          {g.char}
        </div>
      ))}

      {/* ── Cursor orbs ── */}
      <div ref={deep} style={{
        ...base, width: 2000, height: 2000,
        background: "radial-gradient(circle, rgba(88,28,135,0.26) 0%, rgba(88,28,135,0.05) 55%, transparent 75%)",
        filter: "blur(130px)",
      }} />
      <div ref={amb} style={{
        ...base, width: 1200, height: 1200,
        background: "radial-gradient(circle, rgba(124,58,237,0.38) 0%, rgba(124,58,237,0.10) 55%, transparent 75%)",
        filter: "blur(85px)",
      }} />
      <div ref={mid} style={{
        ...base, width: 700, height: 700,
        background: "radial-gradient(circle, rgba(139,92,246,0.55) 0%, rgba(124,58,237,0.18) 55%, transparent 75%)",
        filter: "blur(55px)",
      }} />
      <div ref={trail} style={{
        ...base, width: 400, height: 400,
        background: "radial-gradient(circle, rgba(167,139,250,0.50) 0%, rgba(139,92,246,0.14) 60%, transparent 80%)",
        filter: "blur(32px)",
      }} />
      <div ref={hot} style={{
        ...base, width: 200, height: 200,
        background: "radial-gradient(circle, rgba(230,215,255,0.85) 0%, rgba(196,181,253,0.40) 45%, transparent 70%)",
        filter: "blur(14px)",
      }} />

      {/* ── Noise / grain overlay ── */}
      <div style={{
        position: "fixed", inset: 0, opacity: 0.038,
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
        backgroundSize: "300px 300px",
      }} />

      {/* ── Edge vignette so content cards stand out ── */}
      <div style={{
        position: "fixed", inset: 0,
        background: "radial-gradient(ellipse 100% 100% at 50% 50%, transparent 40%, rgba(4,3,12,0.7) 100%)",
      }} />
    </div>
  );
}
