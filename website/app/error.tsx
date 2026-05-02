"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#080810",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
        color: "#f1f0fa",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1
        style={{
          fontSize: "clamp(3rem, 8vw, 5rem)",
          fontWeight: 800,
          lineHeight: 1,
          background: "linear-gradient(135deg, #7c3aed, #a855f7)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          marginBottom: "0.75rem",
        }}
      >
        Oops
      </h1>
      <p
        style={{
          fontSize: "1.25rem",
          color: "#9898b2",
          marginBottom: "2rem",
        }}
      >
        Something went wrong
      </p>
      <button
        onClick={() => reset()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "12px 28px",
          borderRadius: "10px",
          background: "linear-gradient(135deg, #7c3aed, #a855f7)",
          color: "#fff",
          fontWeight: 600,
          fontSize: "14px",
          border: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          boxShadow: "0 6px 22px rgba(124,58,237,.35)",
          transition: "transform 0.2s ease, box-shadow 0.2s ease",
        }}
      >
        Try again
      </button>
    </div>
  );
}
