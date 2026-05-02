// ◈ Zenith Queue Sniper — Browser Console Version
// Paste this entire script into your browser console to launch the UI
// Features: Premium UI | Animated Glow | Smart Queue Detection | Turbo Mode | Draggable

(function() {
  if (document.getElementById("zn-root")) {
    console.warn("◈ Zenith is already running.");
    return;
  }

  const COLORS = [
    { name: "Red",     accent: "#ff3d3d", bright: "#ff7070", glow: "255,61,61" },
    { name: "Orange",  accent: "#ff8c00", bright: "#ffb84d", glow: "255,140,0" },
    { name: "Yellow",  accent: "#ffd700", bright: "#ffed4e", glow: "255,215,0" },
    { name: "Green",   accent: "#00c853", bright: "#4dff91", glow: "77,255,145" },
    { name: "Cyan",    accent: "#00bfff", bright: "#4dd9ff", glow: "0,191,255" },
    { name: "Blue",    accent: "#1a6fff", bright: "#5a9fff", glow: "26,111,255" },
    { name: "Purple",  accent: "#b366ff", bright: "#d699ff", glow: "179,102,255" },
    { name: "Magenta", accent: "#ff00ff", bright: "#ff66ff", glow: "255,0,255" },
    { name: "Pink",    accent: "#ff1493", bright: "#ff69b4", glow: "255,20,147" },
    { name: "Lime",    accent: "#32cd32", bright: "#66ff66", glow: "50,205,50" },
  ];

  const QUEUE_PHRASES = [
    "join queue","joinqueue","join the queue","enter queue","get in queue",
    "join waitlist","join line","get in line","queue up","join now",
    "enter now","get access","buy now","add to cart","checkout",
    "reserve","claim","get it",
  ];

  let state = {
    status: "Idle", clicks: 0, target: "—",
    delay: 50, turboMode: false, isRunning: false,
    currentColorIdx: 5, queueSniperActive: false,
    smartStop: true, customSelector: "",
  };

  let worker = null;
  let clickCountRef = 0;
  let originURL = location.href;

  // ── Fonts ────────────────────────────────────────────────────────────────────
  const fontLink = document.createElement("link");
  fontLink.rel = "stylesheet";
  fontLink.href = "https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@300;400;500;600&display=swap";
  document.head.appendChild(fontLink);

  // ── CSS ──────────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.id = "zn-style";
  style.textContent = `
    /* ── Root shell (glow backdrop + panel) ─── */
    #zn-root {
      position: fixed; z-index: 2147483647;
      left: 50%; top: 50%; transform: translate(-50%,-50%);
      width: 360px;
      font-family: 'Inter', system-ui, sans-serif;
      pointer-events: none;
    }

    /* Ambient glow blob behind the panel */
    #zn-glow-bg {
      position: absolute;
      inset: -60px;
      border-radius: 50%;
      background: radial-gradient(
        ellipse at 50% 50%,
        rgba(var(--zn-rgb,26,111,255), 0.28) 0%,
        rgba(var(--zn-rgb,26,111,255), 0.10) 40%,
        transparent 72%
      );
      filter: blur(28px);
      animation: znGlowPulse 3s ease-in-out infinite;
      pointer-events: none;
      transition: background 0.6s ease;
    }
    @keyframes znGlowPulse {
      0%,100% { opacity: .85; transform: scale(1);   }
      50%      { opacity: 1;   transform: scale(1.07); }
    }

    /* Orbiting accent ring */
    #zn-orbit {
      position: absolute;
      inset: -28px;
      border-radius: 50%;
      border: 1px solid rgba(var(--zn-rgb,26,111,255), 0.18);
      animation: znOrbit 8s linear infinite;
      pointer-events: none;
    }
    #zn-orbit::before {
      content: '';
      position: absolute;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: rgba(var(--zn-rgb,26,111,255), 0.9);
      box-shadow: 0 0 8px 3px rgba(var(--zn-rgb,26,111,255), 0.6);
      top: -3px; left: 50%;
      transform: translateX(-50%);
    }
    @keyframes znOrbit { to { transform: rotate(360deg); } }

    /* ── Main panel ─── */
    #zn-panel {
      position: relative;
      pointer-events: all;
      background: linear-gradient(145deg, rgba(12,8,26,0.97) 0%, rgba(8,5,18,0.99) 100%);
      border: 1px solid rgba(var(--zn-rgb,26,111,255), 0.3);
      border-radius: 16px;
      overflow: hidden;
      box-shadow:
        0 0 0 1px rgba(var(--zn-rgb,26,111,255), 0.08),
        0 30px 80px rgba(0,0,0,0.8),
        inset 0 1px 0 rgba(255,255,255,0.07),
        inset 0 -1px 0 rgba(var(--zn-rgb,26,111,255), 0.12);
      animation: znSlideIn 0.45s cubic-bezier(0.16,1,0.3,1) forwards;
      transition: border-color 0.5s, box-shadow 0.5s;
    }
    @keyframes znSlideIn {
      from { opacity:0; transform:translateY(16px) scale(0.97); }
      to   { opacity:1; transform:translateY(0)    scale(1); }
    }

    /* Scanline overlay */
    #zn-panel::before {
      content: '';
      position: absolute; inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(255,255,255,0.012) 2px,
        rgba(255,255,255,0.012) 4px
      );
      pointer-events: none; z-index: 1;
    }

    /* Animated top-edge glow bar */
    #zn-panel::after {
      content: '';
      position: absolute; top: 0; left: 10%; right: 10%; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(var(--zn-rgb,26,111,255),0.9), transparent);
      box-shadow: 0 0 12px 2px rgba(var(--zn-rgb,26,111,255),0.5);
      animation: znTopEdge 3s ease-in-out infinite;
      transition: background 0.5s, box-shadow 0.5s;
    }
    @keyframes znTopEdge {
      0%,100% { opacity:.6; } 50% { opacity:1; }
    }

    /* ── Title bar ─── */
    .zn-bar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 13px 16px 12px;
      background: linear-gradient(180deg, rgba(var(--zn-rgb,26,111,255),0.08) 0%, transparent 100%);
      border-bottom: 1px solid rgba(var(--zn-rgb,26,111,255), 0.18);
      cursor: move; user-select: none;
      position: relative; z-index: 2;
    }

    .zn-logo { display: flex; align-items: center; gap: 9px; }

    /* Diamond mark replacing lightning bolt */
    .zn-diamond {
      width: 26px; height: 26px; flex-shrink: 0;
      position: relative; display: flex; align-items: center; justify-content: center;
    }
    .zn-diamond svg {
      width: 100%; height: 100%;
      filter: drop-shadow(0 0 5px rgba(var(--zn-rgb,26,111,255),0.9)) drop-shadow(0 0 14px rgba(var(--zn-rgb,26,111,255),0.5));
      animation: znDiamondSpin 6s linear infinite;
      transition: filter 0.5s;
    }
    @keyframes znDiamondSpin {
      0%,100% { filter: drop-shadow(0 0 5px rgba(var(--zn-rgb,26,111,255),0.9)) drop-shadow(0 0 14px rgba(var(--zn-rgb,26,111,255),0.5)); }
      50% { filter: drop-shadow(0 0 9px rgba(var(--zn-rgb,26,111,255),1)) drop-shadow(0 0 24px rgba(var(--zn-rgb,26,111,255),0.8)); }
    }

    .zn-title-wrap { display: flex; flex-direction: column; }
    .zn-title {
      font-family: 'Rajdhani', sans-serif; font-weight: 700;
      font-size: 21px; letter-spacing: 0.18em; color: #fff; line-height: 1;
      text-shadow: 0 0 16px rgba(var(--zn-rgb,26,111,255),0.9), 0 0 35px rgba(var(--zn-rgb,26,111,255),0.45);
      transition: text-shadow 0.5s;
    }
    .zn-sub {
      font-family: 'IBM Plex Mono', monospace; font-size: 7.5px;
      letter-spacing: 0.4em; color: rgba(var(--zn-rgb,26,111,255),0.55);
      margin-top: 2px; text-transform: uppercase;
      transition: color 0.5s;
    }

    .zn-controls { display: flex; gap: 5px; }
    .zn-ctrl {
      width: 26px; height: 26px; border-radius: 7px;
      border: 1px solid rgba(var(--zn-rgb,26,111,255),0.2);
      background: rgba(var(--zn-rgb,26,111,255),0.06);
      color: rgba(var(--zn-rgb,26,111,255),0.7);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 12px; transition: all 0.2s;
    }
    .zn-ctrl:hover {
      border-color: rgba(var(--zn-rgb,26,111,255),0.5);
      background: rgba(var(--zn-rgb,26,111,255),0.15);
      color: #fff;
      box-shadow: 0 0 8px rgba(var(--zn-rgb,26,111,255),0.3);
    }
    .zn-ctrl.kill:hover {
      border-color: rgba(255,60,60,0.55); background: rgba(255,60,60,0.12);
      color: #ff6060; box-shadow: 0 0 8px rgba(255,60,60,0.3);
    }

    /* ── Body ─── */
    .zn-body {
      padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
      max-height: calc(100vh - 160px); overflow-y: auto;
      position: relative; z-index: 2;
    }
    .zn-body::-webkit-scrollbar { width: 3px; }
    .zn-body::-webkit-scrollbar-track { background: transparent; }
    .zn-body::-webkit-scrollbar-thumb { background: rgba(var(--zn-rgb,26,111,255),0.4); border-radius: 2px; }

    /* ── Stat cards ─── */
    .zn-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

    .zn-card {
      background: rgba(var(--zn-rgb,26,111,255),0.05);
      border: 1px solid rgba(var(--zn-rgb,26,111,255),0.18);
      border-radius: 10px; padding: 9px 12px;
      transition: border-color 0.5s, background 0.5s;
      position: relative; overflow: hidden;
    }
    .zn-card::before {
      content: ''; position: absolute; inset: 0; border-radius: 10px;
      background: radial-gradient(ellipse at 50% 0%, rgba(var(--zn-rgb,26,111,255),0.08) 0%, transparent 70%);
      transition: background 0.5s;
    }
    .zn-lbl {
      font-family: 'IBM Plex Mono', monospace; font-size: 8.5px;
      font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase;
      color: rgba(var(--zn-rgb,26,111,255),0.5); transition: color 0.5s;
    }
    .zn-val {
      font-family: 'Inter', sans-serif; font-size: 15px;
      font-weight: 600; color: rgba(255,255,255,0.85); margin-top: 4px;
    }

    /* Status chip */
    .zn-status-chip {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.5);
    }
    .zn-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: rgba(255,255,255,0.25);
      box-shadow: none; flex-shrink: 0;
      transition: background 0.4s, box-shadow 0.4s;
    }
    .zn-dot.idle    { background:#4a3a7a; }
    .zn-dot.running { background:#4dff91; box-shadow:0 0 8px 2px rgba(77,255,145,0.7); animation:znBlink 0.9s ease-in-out infinite; }
    .zn-dot.found   { background:var(--zn-accent,#1a6fff); box-shadow:0 0 8px 2px rgba(var(--zn-rgb,26,111,255),0.8); animation:znBlink 0.6s ease-in-out infinite; }
    .zn-dot.success { background:#4dff91; box-shadow:0 0 12px 4px rgba(77,255,145,0.9); }
    .zn-dot.error   { background:#ff4444; box-shadow:0 0 8px 2px rgba(255,68,68,0.7); }
    @keyframes znBlink { 0%,100%{opacity:1;} 50%{opacity:0.35;} }

    .zn-status-text { transition: color 0.3s; }
    .zn-status-text.idle    { color:rgba(255,255,255,0.35); }
    .zn-status-text.running { color:#4dff91; text-shadow:0 0 8px rgba(77,255,145,0.6); }
    .zn-status-text.found   { color:var(--zn-accent,#1a6fff); text-shadow:0 0 8px rgba(var(--zn-rgb,26,111,255),0.6); }
    .zn-status-text.success { color:#4dff91; text-shadow:0 0 10px rgba(77,255,145,0.8); }
    .zn-status-text.error   { color:#ff4444; }

    /* Clicks counter animate */
    .zn-clicks-num { transition: color 0.2s; font-variant-numeric: tabular-nums; }
    .zn-clicks-num.bump { color: var(--zn-accent-bright,#5a9fff); }

    /* Target line */
    .zn-target-val {
      font-size: 13px; color: rgba(255,255,255,0.6);
      font-family: 'IBM Plex Mono', monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      margin-top: 4px;
    }

    /* ── Delay slider ─── */
    .zn-slider-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .zn-slider-tag { font-family:'IBM Plex Mono',monospace; font-size:8.5px; font-weight:600; letter-spacing:0.2em; text-transform:uppercase; color:rgba(var(--zn-rgb,26,111,255),0.5); }
    .zn-slider-val { font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:600; color:var(--zn-accent-bright,#5a9fff); transition:color 0.5s; }

    .zn-slider {
      width: 100%; height: 3px; border-radius: 2px; outline: none;
      -webkit-appearance: none; appearance: none; cursor: pointer;
      background: linear-gradient(to right, var(--zn-accent,#1a6fff) var(--sp,5%), rgba(var(--zn-rgb,26,111,255),0.15) var(--sp,5%));
      transition: background 0.3s;
    }
    .zn-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: var(--zn-accent-bright,#5a9fff);
      border: 2px solid rgba(255,255,255,0.9);
      box-shadow: 0 0 12px rgba(var(--zn-rgb,26,111,255),0.8), 0 0 24px rgba(var(--zn-rgb,26,111,255),0.4);
      cursor: pointer; transition: box-shadow 0.25s;
    }
    .zn-slider::-webkit-slider-thumb:hover {
      box-shadow: 0 0 18px rgba(var(--zn-rgb,26,111,255),1), 0 0 36px rgba(var(--zn-rgb,26,111,255),0.6);
    }
    .zn-slider::-moz-range-thumb {
      width:14px; height:14px; border-radius:50%;
      background: var(--zn-accent-bright,#5a9fff); border: 2px solid rgba(255,255,255,0.9);
    }

    /* ── Toggle row ─── */
    .zn-toggle-row { display: flex; align-items: center; gap: 10px; }
    .zn-toggle {
      position: relative; width: 36px; height: 20px;
      flex-shrink: 0; cursor: pointer;
    }
    .zn-toggle input { opacity: 0; width: 0; height: 0; }
    .zn-toggle-track {
      position: absolute; inset: 0;
      background: rgba(var(--zn-rgb,26,111,255),0.12);
      border: 1px solid rgba(var(--zn-rgb,26,111,255),0.3);
      border-radius: 20px;
      transition: background 0.3s, border-color 0.3s, box-shadow 0.3s;
    }
    .zn-toggle input:checked ~ .zn-toggle-track {
      background: rgba(var(--zn-rgb,26,111,255),0.35);
      border-color: var(--zn-accent,#1a6fff);
      box-shadow: 0 0 10px rgba(var(--zn-rgb,26,111,255),0.4);
    }
    .zn-toggle-thumb {
      position: absolute; top: 3px; left: 3px;
      width: 12px; height: 12px; border-radius: 50%;
      background: rgba(255,255,255,0.35);
      transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1), background 0.3s, box-shadow 0.3s;
      pointer-events: none;
    }
    .zn-toggle input:checked ~ .zn-toggle-track .zn-toggle-thumb {
      transform: translateX(16px);
      background: var(--zn-accent-bright,#5a9fff);
      box-shadow: 0 0 8px rgba(var(--zn-rgb,26,111,255),0.8);
    }
    .zn-toggle-lbl {
      font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; font-weight: 600;
      letter-spacing: 0.12em; color: rgba(255,255,255,0.5); cursor: pointer;
      transition: color 0.3s, text-shadow 0.3s;
    }
    .zn-toggle-lbl.active { color: #ff5555; text-shadow: 0 0 10px rgba(255,85,85,0.7); }

    /* ── CTA button ─── */
    .zn-cta {
      position: relative; overflow: hidden;
      padding: 15px 20px; width: 100%;
      border-radius: 11px; border: none; cursor: pointer;
      font-family: 'IBM Plex Mono', monospace; font-size: 13px;
      font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: #fff;
      background: linear-gradient(135deg,
        rgba(var(--zn-rgb,26,111,255),0.6) 0%,
        var(--zn-accent,#1a6fff) 40%,
        var(--zn-accent-bright,#5a9fff) 100%
      );
      box-shadow:
        0 0 0 1px rgba(var(--zn-rgb,26,111,255),0.4),
        0 6px 30px rgba(var(--zn-rgb,26,111,255),0.45),
        inset 0 1px 0 rgba(255,255,255,0.18);
      transition: transform 0.2s, box-shadow 0.2s, background 0.5s;
    }
    /* Shimmer sweep */
    .zn-cta::before {
      content: '';
      position: absolute; top: 0; left: -100%; width: 60%; height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
      animation: znShimmer 2.8s ease-in-out infinite;
    }
    @keyframes znShimmer { 0%{left:-100%;} 60%,100%{left:140%;} }
    .zn-cta:hover {
      transform: translateY(-2px);
      box-shadow:
        0 0 0 1px rgba(var(--zn-rgb,26,111,255),0.6),
        0 10px 40px rgba(var(--zn-rgb,26,111,255),0.6),
        inset 0 1px 0 rgba(255,255,255,0.25);
    }
    .zn-cta:active { transform: translateY(0); }
    .zn-cta.running {
      animation: znCtaPulse 0.65s ease-in-out infinite;
      background: linear-gradient(135deg, #ff3d3d 0%, #ff6b6b 100%);
      box-shadow:
        0 0 0 1px rgba(255,61,61,0.5),
        0 6px 30px rgba(255,61,61,0.5),
        inset 0 1px 0 rgba(255,255,255,0.15);
    }
    @keyframes znCtaPulse {
      0%,100% { box-shadow: 0 0 0 1px rgba(255,61,61,0.5), 0 6px 30px rgba(255,61,61,0.5), inset 0 1px 0 rgba(255,255,255,0.15); }
      50%      { box-shadow: 0 0 0 3px rgba(255,61,61,0.3), 0 10px 50px rgba(255,61,61,0.75), inset 0 1px 0 rgba(255,255,255,0.2); }
    }

    /* ── Settings panel ─── */
    #zn-settings {
      display: none; position: fixed; z-index: 2147483647;
      width: 300px;
      background: linear-gradient(145deg, rgba(10,6,22,0.98) 0%, rgba(6,3,14,0.99) 100%);
      border: 1px solid rgba(var(--zn-rgb,26,111,255),0.28);
      border-radius: 14px;
      box-shadow:
        0 0 0 1px rgba(var(--zn-rgb,26,111,255),0.07),
        0 30px 80px rgba(0,0,0,0.85),
        inset 0 1px 0 rgba(255,255,255,0.06);
      cursor: move; overflow: hidden;
      animation: znSlideIn 0.35s cubic-bezier(0.16,1,0.3,1) both;
      transition: border-color 0.5s;
    }
    #zn-settings::after {
      content: '';
      position: absolute; top: 0; left: 10%; right: 10%; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(var(--zn-rgb,26,111,255),0.8), transparent);
      transition: background 0.5s;
    }
    #zn-settings.show { display: block; }
    .zn-s-hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px;
      background: rgba(var(--zn-rgb,26,111,255),0.07);
      border-bottom: 1px solid rgba(var(--zn-rgb,26,111,255),0.18);
      user-select: none;
      transition: background 0.5s, border-color 0.5s;
    }
    .zn-s-title { font-family:'Rajdhani',sans-serif; font-weight:700; font-size:16px; letter-spacing:0.12em; color:rgba(255,255,255,0.9); }
    .zn-s-close {
      width:22px; height:22px; border-radius:6px;
      border:1px solid rgba(var(--zn-rgb,26,111,255),0.2);
      background: rgba(var(--zn-rgb,26,111,255),0.06);
      display:flex; align-items:center; justify-content:center;
      cursor:pointer; color:rgba(255,255,255,0.4); font-size:12px; transition:all 0.2s;
    }
    .zn-s-close:hover { border-color:rgba(255,60,60,0.5); color:#ff6060; background:rgba(255,60,60,0.1); }

    .zn-s-body { padding:14px 16px; display:flex; flex-direction:column; gap:13px; }

    .zn-color-track {
      width:100%; height:6px; border-radius:3px; outline:none;
      -webkit-appearance:none; appearance:none; cursor:pointer;
      background: linear-gradient(90deg,#ff3d3d,#ff8c00,#ffd700,#00c853,#00bfff,#1a6fff,#b366ff,#ff00ff,#ff1493,#32cd32);
      box-shadow: 0 0 8px rgba(0,0,0,0.4);
    }
    .zn-color-track::-webkit-slider-thumb {
      -webkit-appearance:none; appearance:none;
      width:16px; height:16px; border-radius:50%;
      background:#fff; border:2px solid rgba(0,0,0,0.4);
      box-shadow:0 0 10px rgba(0,0,0,0.6); cursor:pointer;
    }
    .zn-color-track::-moz-range-thumb {
      width:16px; height:16px; border-radius:50%;
      background:#fff; border:2px solid rgba(0,0,0,0.4); cursor:pointer;
    }
    .zn-color-name { font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:600; color:var(--zn-accent,#1a6fff); text-align:center; margin-top:5px; transition:color 0.5s; }

    .zn-input {
      width:100%; background:rgba(var(--zn-rgb,26,111,255),0.06);
      border:1px solid rgba(var(--zn-rgb,26,111,255),0.2);
      border-radius:7px; padding:8px 11px;
      color:rgba(255,255,255,0.8); font-family:'IBM Plex Mono',monospace;
      font-size:11px; outline:none; transition:border-color 0.25s, box-shadow 0.25s;
    }
    .zn-input:focus {
      border-color:var(--zn-accent,#1a6fff);
      box-shadow:0 0 10px rgba(var(--zn-rgb,26,111,255),0.25);
    }
    .zn-input::placeholder { color:rgba(var(--zn-rgb,26,111,255),0.25); }

    .zn-hint { font-family:'IBM Plex Mono',monospace; font-size:9px; color:rgba(255,255,255,0.2); margin-top:4px; }

    .zn-divider { border:none; border-top:1px solid rgba(var(--zn-rgb,26,111,255),0.12); transition:border-color 0.5s; }

    .zn-outline-btn {
      width:100%; padding:10px; border-radius:8px;
      border:1px solid rgba(var(--zn-rgb,26,111,255),0.35);
      background:rgba(var(--zn-rgb,26,111,255),0.08);
      color:var(--zn-accent-bright,#5a9fff);
      font-family:'IBM Plex Mono',monospace; font-size:11.5px; font-weight:700;
      letter-spacing:0.12em; text-transform:uppercase; cursor:pointer; transition:all 0.25s;
    }
    .zn-outline-btn:hover {
      background:rgba(var(--zn-rgb,26,111,255),0.18);
      box-shadow:0 0 14px rgba(var(--zn-rgb,26,111,255),0.3);
      border-color:var(--zn-accent,#1a6fff);
    }
    .zn-outline-btn.active {
      background:var(--zn-accent,#1a6fff);
      color:#fff; box-shadow:0 0 18px rgba(var(--zn-rgb,26,111,255),0.55);
    }

    .zn-kill-btn {
      width:100%; padding:10px; border-radius:8px;
      border:1px solid rgba(255,55,55,0.35);
      background:linear-gradient(135deg,rgba(100,0,0,0.8) 0%,rgba(200,0,0,0.8) 100%);
      color:#fff; font-family:'IBM Plex Mono',monospace; font-size:11.5px;
      font-weight:700; letter-spacing:0.12em; text-transform:uppercase;
      cursor:pointer; transition:all 0.25s;
      box-shadow:0 4px 18px rgba(200,0,0,0.25);
    }
    .zn-kill-btn:hover { box-shadow:0 4px 28px rgba(220,0,0,0.55); transform:translateY(-1px); }
    .zn-kill-btn:active { transform:translateY(0); }
  `;
  document.head.appendChild(style);

  // ── DOM ──────────────────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.id = "zn-root";
  root.innerHTML = `
    <div id="zn-glow-bg"></div>
    <div id="zn-orbit"></div>
    <div id="zn-panel">
      <div class="zn-bar" id="zn-bar">
        <div class="zn-logo">
          <div class="zn-diamond">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <polygon points="12,2 22,9 18,22 6,22 2,9" fill="none" stroke="rgba(var(--zn-rgb,26,111,255),0.9)" stroke-width="1.4"/>
              <polygon points="12,5 19,10.5 16,20 8,20 5,10.5" fill="rgba(var(--zn-rgb,26,111,255),0.12)" stroke="rgba(var(--zn-rgb,26,111,255),0.5)" stroke-width="0.8"/>
              <circle cx="12" cy="12" r="2.5" fill="rgba(var(--zn-rgb,26,111,255),0.9)"/>
            </svg>
          </div>
          <div class="zn-title-wrap">
            <div class="zn-title">ZENITH</div>
            <div class="zn-sub">Queue Sniper</div>
          </div>
        </div>
        <div class="zn-controls">
          <button class="zn-ctrl" id="zn-settings-btn" title="Settings">⚙</button>
          <button class="zn-ctrl" id="zn-min-btn" title="Minimize">−</button>
          <button class="zn-ctrl kill" id="zn-close-btn" title="Close">✕</button>
        </div>
      </div>

      <div class="zn-body" id="zn-body">
        <div class="zn-grid2">
          <div class="zn-card">
            <div class="zn-lbl">Status</div>
            <div class="zn-val" style="margin-top:5px">
              <div class="zn-status-chip">
                <span class="zn-dot idle" id="zn-dot"></span>
                <span class="zn-status-text idle" id="zn-status">Idle</span>
              </div>
            </div>
          </div>
          <div class="zn-card">
            <div class="zn-lbl">Clicks</div>
            <div class="zn-val zn-clicks-num" id="zn-clicks" style="margin-top:5px">0</div>
          </div>
        </div>

        <div class="zn-card">
          <div class="zn-lbl">Target</div>
          <div class="zn-target-val" id="zn-target">—</div>
        </div>

        <div style="padding:0 1px">
          <div class="zn-slider-hdr">
            <span class="zn-slider-tag">Click Delay</span>
            <span class="zn-slider-val" id="zn-dv">50ms</span>
          </div>
          <input type="range" class="zn-slider" id="zn-ds" min="1" max="2000" step="1" value="50">
        </div>

        <label class="zn-toggle-row" for="zn-turbo-inp">
          <div class="zn-toggle">
            <input type="checkbox" id="zn-turbo-inp">
            <div class="zn-toggle-track"><div class="zn-toggle-thumb"></div></div>
          </div>
          <span class="zn-toggle-lbl" id="zn-turbo-lbl">TURBO MODE</span>
        </label>

        <button class="zn-cta" id="zn-cta">SNIPE QUEUE</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  // ── Settings panel ────────────────────────────────────────────────────────────
  const settingsEl = document.createElement("div");
  settingsEl.id = "zn-settings";
  settingsEl.style.cssText = "left:calc(50% + 200px);top:50%;transform:translateY(-50%)";
  settingsEl.innerHTML = `
    <div class="zn-s-hdr" id="zn-s-hdr">
      <span class="zn-s-title">Settings</span>
      <button class="zn-s-close" id="zn-s-close">✕</button>
    </div>
    <div class="zn-s-body">
      <div>
        <div class="zn-lbl" style="margin-bottom:8px;color:rgba(var(--zn-rgb,26,111,255),0.55)">Theme Color</div>
        <input type="range" class="zn-color-track" id="zn-ct" min="0" max="9" step="1" value="5">
        <div class="zn-color-name" id="zn-cn">Blue</div>
      </div>
      <hr class="zn-divider">
      <div>
        <div class="zn-lbl" style="margin-bottom:6px;color:rgba(var(--zn-rgb,26,111,255),0.55)">Custom Selector <span style="opacity:.4;font-weight:400">(optional)</span></div>
        <input type="text" class="zn-input" id="zn-sel" placeholder="e.g.  button.buy-now">
        <div class="zn-hint">Leave blank for auto-detection</div>
      </div>
      <label class="zn-toggle-row" for="zn-smart-inp">
        <div class="zn-toggle">
          <input type="checkbox" id="zn-smart-inp" checked>
          <div class="zn-toggle-track"><div class="zn-toggle-thumb"></div></div>
        </div>
        <span class="zn-toggle-lbl" style="color:rgba(255,255,255,0.55);font-size:10.5px">Smart Stop on nav</span>
      </label>
      <hr class="zn-divider">
      <button class="zn-outline-btn" id="zn-sniper-btn">◈ QUEUE SNIPER</button>
      <button class="zn-kill-btn" id="zn-destruct-btn">☠ SELF DESTRUCT</button>
    </div>
  `;
  document.body.appendChild(settingsEl);

  // ── Draggable ─────────────────────────────────────────────────────────────────
  function draggable(el, handle) {
    let on = false, ox = 0, oy = 0;
    handle.addEventListener("mousedown", e => {
      on = true;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
    });
    document.addEventListener("mousemove", e => {
      if (!on) return;
      el.style.left = (e.clientX - ox) + "px";
      el.style.top  = (e.clientY - oy) + "px";
      el.style.transform = "none";
    });
    document.addEventListener("mouseup", () => { on = false; });
  }
  draggable(root, document.getElementById("zn-bar"));
  draggable(settingsEl, document.getElementById("zn-s-hdr"));

  // ── Color apply ───────────────────────────────────────────────────────────────
  function applyColor(idx) {
    state.currentColorIdx = idx;
    const c = COLORS[idx];
    [document.documentElement, root, settingsEl].forEach(el => {
      if (!el) return;
      el.style.setProperty("--zn-rgb",          c.glow);
      el.style.setProperty("--zn-accent",        c.accent);
      el.style.setProperty("--zn-accent-bright",  c.bright);
    });
    const cn = document.getElementById("zn-cn");
    if (cn) cn.textContent = c.name;
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) applyColor(state.currentColorIdx); });
  window.addEventListener("focus", () => applyColor(state.currentColorIdx));
  document.getElementById("zn-ct").addEventListener("input", e => applyColor(Number(e.target.value)));

  // ── Delay slider ──────────────────────────────────────────────────────────────
  function refreshSlider() {
    const pct = Math.round(((state.delay - 1) / 1999) * 100);
    document.getElementById("zn-ds").style.setProperty("--sp", pct + "%");
    document.getElementById("zn-dv").textContent = state.delay + "ms";
  }
  document.getElementById("zn-ds").addEventListener("input", e => {
    state.delay = Number(e.target.value);
    refreshSlider();
    if (worker && state.isRunning) worker.postMessage({ cmd: "update", ms: state.turboMode ? 1 : Math.max(1, state.delay) });
  });

  // ── Turbo toggle ──────────────────────────────────────────────────────────────
  document.getElementById("zn-turbo-inp").addEventListener("change", e => {
    state.turboMode = e.target.checked;
    document.getElementById("zn-turbo-lbl").classList.toggle("active", state.turboMode);
    if (worker && state.isRunning) worker.postMessage({ cmd: "update", ms: state.turboMode ? 1 : Math.max(1, state.delay) });
  });

  // ── Smart stop ────────────────────────────────────────────────────────────────
  document.getElementById("zn-smart-inp").addEventListener("change", e => { state.smartStop = e.target.checked; });
  document.getElementById("zn-sel").addEventListener("input", e => { state.customSelector = e.target.value.trim(); });

  // ── Status update ─────────────────────────────────────────────────────────────
  function setStatus(s) {
    state.status = s;
    const dot  = document.getElementById("zn-dot");
    const text = document.getElementById("zn-status");
    if (!dot || !text) return;
    const cls = { Running:"running", Clicking:"running", Found:"found", Success:"success", Error:"error" }[s] || "idle";
    dot.className  = "zn-dot "  + cls;
    text.className = "zn-status-text " + cls;
    text.textContent = s;
  }

  function updateUI() {
    const cl = document.getElementById("zn-clicks");
    if (cl) cl.textContent = state.clicks.toLocaleString();
    const tg = document.getElementById("zn-target");
    if (tg) tg.textContent = state.target;
  }

  // ── Button detection ──────────────────────────────────────────────────────────
  function scoreEl(el) {
    if (!el || el.offsetParent === null) return 0;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return 0;
    const text = (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (!text) return 0;
    let score = 0;
    for (const p of QUEUE_PHRASES) {
      if (text.includes(p)) { score = text === p ? 100 : text.startsWith(p) ? 80 : 60; break; }
    }
    if (!score) return 0;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") score += 20;
    else if (tag === "a") score += 10;
    else if (el.getAttribute("role") === "button") score += 15;
    return score;
  }

  function findTarget() {
    if (state.customSelector) {
      try { const e = document.querySelector(state.customSelector); if (e) return e; } catch (_) {}
    }
    let best = null, bs = 0;
    for (const el of document.querySelectorAll("button,a,input[type='submit'],[role='button'],[role='link']")) {
      const s = scoreEl(el);
      if (s > bs) { bs = s; best = el; }
    }
    return bs > 0 ? best : null;
  }

  // ── Engine ────────────────────────────────────────────────────────────────────
  function stopQueue(reason) {
    if (worker) { worker.terminate(); worker = null; }
    state.isRunning = false; state.queueSniperActive = false;
    setStatus(reason || "Idle");
    state.target = "—"; updateUI();
    const cta = document.getElementById("zn-cta");
    if (cta) { cta.classList.remove("running"); cta.textContent = "SNIPE QUEUE"; }
    const sb = document.getElementById("zn-sniper-btn");
    if (sb) sb.classList.remove("active");
  }

  function startQueue() {
    state.isRunning = true; state.queueSniperActive = true;
    setStatus("Running"); state.target = "Searching…"; clickCountRef = state.clicks; originURL = location.href;
    const cta = document.getElementById("zn-cta");
    cta.classList.add("running"); cta.textContent = "STOP";
    document.getElementById("zn-sniper-btn").classList.add("active");

    let targetEl = null, uiTick = 0;
    const workerSrc = `let iv=null;self.onmessage=function(e){if(e.data.cmd==='start'||e.data.cmd==='update'){if(iv)clearInterval(iv);iv=setInterval(function(){self.postMessage('tick');},e.data.ms);}if(e.data.cmd==='stop'){if(iv)clearInterval(iv);iv=null;}};`;
    worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" })));

    worker.onmessage = () => {
      if (!state.isRunning) return;
      if (state.smartStop && location.href !== originURL) { stopQueue("Success"); return; }

      const found = findTarget();
      if (found && found !== targetEl) {
        targetEl = found;
        setStatus("Found");
        const label = (found.innerText || found.textContent || found.value || "").trim().slice(0, 38);
        state.target = label || found.tagName;
        updateUI();
      }

      if (targetEl) {
        targetEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        clickCountRef++; state.clicks = clickCountRef;
        setStatus("Clicking");
        if (++uiTick >= 10) { uiTick = 0; updateUI(); }
      }
    };

    worker.postMessage({ cmd: "start", ms: state.turboMode ? 1 : Math.max(1, state.delay) });
    updateUI();
  }

  // ── Window controls ───────────────────────────────────────────────────────────
  let minimized = false;
  document.getElementById("zn-min-btn").addEventListener("click", () => {
    minimized = !minimized;
    document.getElementById("zn-body").style.display = minimized ? "none" : "flex";
  });

  function selfDestruct() {
    if (worker) { worker.terminate(); worker = null; }
    root.remove(); settingsEl.remove();
    document.getElementById("zn-style")?.remove();
    document.querySelector("link[href*='fonts.googleapis.com']")?.remove();
    console.log("◈ Zenith removed.");
  }

  document.getElementById("zn-close-btn").addEventListener("click", () => { stopQueue(); selfDestruct(); });
  document.getElementById("zn-settings-btn").addEventListener("click", () => settingsEl.classList.toggle("show"));
  document.getElementById("zn-s-close").addEventListener("click", () => settingsEl.classList.remove("show"));
  document.getElementById("zn-cta").addEventListener("click", () => state.isRunning ? stopQueue() : startQueue());
  document.getElementById("zn-sniper-btn").addEventListener("click", () => state.isRunning ? stopQueue() : startQueue());
  document.getElementById("zn-destruct-btn").addEventListener("click", selfDestruct);

  // ── Init ──────────────────────────────────────────────────────────────────────
  applyColor(5);
  refreshSlider();
  updateUI();

  console.log("◈ Zenith Queue Sniper loaded — premium edition.");
})();
