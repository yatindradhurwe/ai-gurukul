const COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ec4899", "#0ea5e9", "#a855f7", "#f43f5e"];

/** A short confetti burst. Skipped for people who prefer reduced motion. */
export function celebrate(pieces = 90) {
  if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (let i = 0; i < pieces; i++) {
    const el = document.createElement("span");
    el.className = "confetti-piece";
    el.style.left = `${Math.random() * 100}vw`;
    el.style.background = COLORS[i % COLORS.length];
    el.style.setProperty("--drift", `${(Math.random() - 0.5) * 240}px`);
    el.style.setProperty("--spin", `${(Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 540)}deg`);
    el.style.setProperty("--fall", `${2 + Math.random() * 1.6}s`);
    el.style.animationDelay = `${Math.random() * 0.4}s`;
    if (i % 3 === 0) el.style.borderRadius = "50%";
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 4500);
  }
}
