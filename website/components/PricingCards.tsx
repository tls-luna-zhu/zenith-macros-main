"use client";

import { useRef } from "react";
import Link from "next/link";

const FEATURES_MONTHLY = [
  "All macro categories",
  "Dashboard access",
  "License key",
  "HWID protection",
  "Discord support",
  "Cancel anytime",
];

const FEATURES_LIFETIME = [
  "Everything in Monthly",
  "Never pay again",
  "All future updates",
  "Priority Discord support",
  "Lifetime license key",
  "HWID protection",
];

function TiltCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onEnter = () => {
    if (ref.current) ref.current.style.transition = "none";
  };
  const onLeave = () => {
    if (ref.current) {
      ref.current.style.transition = "transform 0.7s cubic-bezier(.2,.8,.2,1), box-shadow 0.7s ease";
      ref.current.style.transform = "perspective(900px) rotateY(0deg) rotateX(0deg) translateZ(0)";
    }
  };
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(900px) rotateY(${x * 14}deg) rotateX(${-y * 14}deg) translateZ(18px)`;
  };

  return (
    <div
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseMove={onMove}
      style={{ transformStyle: "preserve-3d", willChange: "transform", ...style }}
    >
      {children}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      width={15}
      height={15}
      style={{ flexShrink: 0, marginTop: 1 }}
    >
      <circle cx={8} cy={8} r={7.5} stroke="rgba(167,139,250,0.4)" />
      <path
        d="M5 8l2 2 4-4"
        stroke="#a78bfa"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PricingCards() {
  const cardBase: React.CSSProperties = {
    position: "relative",
    background: "rgba(16,14,26,0.88)",
    border: "1px solid rgba(124,58,237,0.22)",
    borderRadius: 20,
    padding: "2.25rem 2rem",
    backdropFilter: "blur(24px)",
    WebkitBackdropFilter: "blur(24px)",
    display: "flex",
    flexDirection: "column",
    gap: 0,
    flex: 1,
    minWidth: 280,
    maxWidth: 420,
    cursor: "default",
  };

  const featuresListStyle: React.CSSProperties = {
    listStyle: "none",
    margin: "1.5rem 0 2rem",
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 11,
    flex: 1,
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 24,
        justifyContent: "center",
        flexWrap: "wrap",
        alignItems: "stretch",
      }}
    >
      {/* MONTHLY */}
      <TiltCard style={{ flex: 1, minWidth: 280, maxWidth: 420 }}>
        <div style={cardBase}>
          {/* Subtle inner glow */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: 20,
            background: "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(124,58,237,0.1) 0%, transparent 70%)",
            pointerEvents: "none",
          }} />

          <div style={{ marginBottom: 6 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
              color: "rgba(167,139,250,0.7)", textTransform: "uppercase",
            }}>
              Monthly
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 52, fontWeight: 800, letterSpacing: "-2px", lineHeight: 1 }}>
              $10
            </span>
            <span style={{ fontSize: 14, color: "rgba(243,243,247,0.45)", paddingBottom: 8 }}>
              / month
            </span>
          </div>
          <p style={{ fontSize: 13.5, color: "rgba(243,243,247,0.5)", marginTop: 6, marginBottom: 0 }}>
            Full access, billed monthly. Cancel any time.
          </p>

          <ul style={featuresListStyle}>
            {FEATURES_MONTHLY.map((f) => (
              <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 14, color: "rgba(243,243,247,0.8)" }}>
                <CheckIcon />
                {f}
              </li>
            ))}
          </ul>

          <Link
            href="/selectpayment?plan=monthly"
            style={{
              display: "block", textAlign: "center",
              padding: "13px 0",
              borderRadius: 12,
              background: "rgba(124,58,237,0.15)",
              border: "1px solid rgba(124,58,237,0.4)",
              color: "#c4b5fd",
              fontWeight: 700, fontSize: 14,
              textDecoration: "none",
              transition: "background 0.2s, border-color 0.2s",
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLAnchorElement).style.background = "rgba(124,58,237,0.28)";
              (e.target as HTMLAnchorElement).style.borderColor = "rgba(167,139,250,0.7)";
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLAnchorElement).style.background = "rgba(124,58,237,0.15)";
              (e.target as HTMLAnchorElement).style.borderColor = "rgba(124,58,237,0.4)";
            }}
          >
            Get Monthly
          </Link>
        </div>
      </TiltCard>

      {/* LIFETIME */}
      <TiltCard style={{ flex: 1, minWidth: 280, maxWidth: 420 }}>
        <div style={{
          ...cardBase,
          border: "1px solid rgba(139,92,246,0.5)",
          background: "rgba(18,12,32,0.92)",
          boxShadow: "0 0 60px rgba(124,58,237,0.18), 0 0 0 1px rgba(139,92,246,0.12)",
        }}>
          {/* Stronger inner glow for featured card */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: 20,
            background: "radial-gradient(ellipse 100% 70% at 50% 0%, rgba(139,92,246,0.2) 0%, transparent 65%)",
            pointerEvents: "none",
          }} />

          {/* Badge */}
          <div style={{ position: "absolute", top: -1, right: 24 }}>
            <span style={{
              display: "inline-block",
              padding: "5px 14px",
              background: "linear-gradient(135deg, #7c3aed, #a855f7)",
              borderRadius: "0 0 10px 10px",
              fontSize: 10.5, fontWeight: 800, letterSpacing: "0.1em",
              color: "#fff", textTransform: "uppercase",
            }}>
              Best Value
            </span>
          </div>

          <div style={{ marginBottom: 6 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
              color: "rgba(167,139,250,0.85)", textTransform: "uppercase",
            }}>
              Lifetime
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, marginTop: 4 }}>
            <span style={{
              fontSize: 52, fontWeight: 800, letterSpacing: "-2px", lineHeight: 1,
              background: "linear-gradient(135deg, #f3f3f7 30%, #c4b5fd 100%)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>
              $25
            </span>
            <span style={{ fontSize: 14, color: "rgba(243,243,247,0.45)", paddingBottom: 8 }}>
              one-time
            </span>
          </div>
          <p style={{ fontSize: 13.5, color: "rgba(243,243,247,0.5)", marginTop: 6, marginBottom: 0 }}>
            Pay once. Access forever. All updates included.
          </p>

          <ul style={featuresListStyle}>
            {FEATURES_LIFETIME.map((f) => (
              <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 14, color: "rgba(243,243,247,0.85)" }}>
                <CheckIcon />
                {f}
              </li>
            ))}
          </ul>

          <Link
            href="/selectpayment?plan=lifetime"
            style={{
              display: "block", textAlign: "center",
              padding: "14px 0",
              borderRadius: 12,
              background: "linear-gradient(135deg, #7c3aed, #9333ea)",
              color: "#fff",
              fontWeight: 700, fontSize: 14,
              textDecoration: "none",
              boxShadow: "0 4px 24px rgba(124,58,237,0.4)",
              transition: "opacity 0.2s, box-shadow 0.2s",
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLAnchorElement).style.opacity = "0.9";
              (e.target as HTMLAnchorElement).style.boxShadow = "0 6px 32px rgba(124,58,237,0.6)";
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLAnchorElement).style.opacity = "1";
              (e.target as HTMLAnchorElement).style.boxShadow = "0 4px 24px rgba(124,58,237,0.4)";
            }}
          >
            Get Lifetime
          </Link>
        </div>
      </TiltCard>
    </div>
  );
}
