"use client";

import { useEffect, useRef } from "react";

export function CursorBg() {
  const hot = useRef<HTMLDivElement>(null);
  const mid = useRef<HTMLDivElement>(null);
  const amb = useRef<HTMLDivElement>(null);
  const deep = useRef<HTMLDivElement>(null);
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

    const onMove = (e: MouseEvent) => {
      mx = e.clientX;
      my = e.clientY;
    };
    window.addEventListener("mousemove", onMove, { passive: true });

    let raf: number;
    const tick = () => {
      // Hot — very fast, very close to real cursor
      hx += (mx - hx) * 0.26;
      hy += (my - hy) * 0.26;
      // Trail — fast but slightly behind
      tx += (mx - tx) * 0.18;
      ty += (my - ty) * 0.18;
      // Mid — medium lag
      mx2 += (mx - mx2) * 0.07;
      my2 += (my - my2) * 0.07;
      // Ambient — slower
      ax += (mx - ax) * 0.032;
      ay += (my - ay) * 0.032;
      // Deep — very slow drift
      dx += (mx - dx) * 0.012;
      dy += (my - dy) * 0.012;

      const move = (el: HTMLDivElement | null, x: number, y: number) => {
        if (!el) return;
        el.style.left = x + "px";
        el.style.top = y + "px";
      };

      move(hot.current, hx, hy);
      move(trail.current, tx, ty);
      move(mid.current, mx2, my2);
      move(amb.current, ax, ay);
      move(deep.current, dx, dy);

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
      {/* Static ambient — corner glows always present */}
      <div style={{
        position: "fixed", inset: 0,
        background: "radial-gradient(ellipse 90% 60% at 50% -10%, rgba(124,58,237,0.12) 0%, transparent 65%)",
      }} />
      <div style={{
        position: "fixed",
        top: "-20%", right: "-10%",
        width: 800, height: 800,
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(88,28,135,0.18) 0%, transparent 70%)",
        filter: "blur(80px)",
      }} />
      <div style={{
        position: "fixed",
        bottom: "-15%", left: "-5%",
        width: 600, height: 600,
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(109,40,217,0.12) 0%, transparent 70%)",
        filter: "blur(70px)",
      }} />

      {/* Deep cursor orb — biggest, slowest */}
      <div ref={deep} style={{
        ...base,
        width: 1800, height: 1800,
        background: "radial-gradient(circle, rgba(88,28,135,0.22) 0%, rgba(88,28,135,0.04) 55%, transparent 75%)",
        filter: "blur(120px)",
      }} />

      {/* Ambient cursor orb */}
      <div ref={amb} style={{
        ...base,
        width: 1100, height: 1100,
        background: "radial-gradient(circle, rgba(124,58,237,0.32) 0%, rgba(124,58,237,0.08) 55%, transparent 75%)",
        filter: "blur(80px)",
      }} />

      {/* Mid orb */}
      <div ref={mid} style={{
        ...base,
        width: 650, height: 650,
        background: "radial-gradient(circle, rgba(139,92,246,0.5) 0%, rgba(124,58,237,0.15) 55%, transparent 75%)",
        filter: "blur(50px)",
      }} />

      {/* Trail orb — creates a dragging smear */}
      <div ref={trail} style={{
        ...base,
        width: 360, height: 360,
        background: "radial-gradient(circle, rgba(167,139,250,0.45) 0%, rgba(139,92,246,0.12) 60%, transparent 80%)",
        filter: "blur(30px)",
      }} />

      {/* Hot spot — tiny, very bright, right at cursor */}
      <div ref={hot} style={{
        ...base,
        width: 180, height: 180,
        background: "radial-gradient(circle, rgba(220,200,255,0.75) 0%, rgba(196,181,253,0.35) 45%, transparent 70%)",
        filter: "blur(12px)",
      }} />
    </div>
  );
}
