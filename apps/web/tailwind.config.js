/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Tenants override --brand via white-label settings.
        brand: { DEFAULT: v("brand"), soft: "rgb(var(--brand) / 0.1)", strong: v("brand-strong") },
        accent: v("accent"),
        surface: { DEFAULT: v("surface"), raised: v("surface-raised") },
        // Neutral scale is themeable so every page follows light/dark mode.
        slate: Object.fromEntries(shades.map((s) => [s, v(`slate-${s}`)])),
      },
      fontFamily: {
        sans: ["'Plus Jakarta Sans'", "Inter", "system-ui", "sans-serif"],
        display: ["'Fraunces'", "Georgia", "serif"],
      },
      boxShadow: {
        soft: "0 1px 2px rgb(15 23 42 / 0.04), 0 4px 16px -4px rgb(15 23 42 / 0.08)",
        lift: "0 2px 4px rgb(15 23 42 / 0.05), 0 12px 32px -8px rgb(15 23 42 / 0.18)",
      },
      keyframes: { "fade-up": { from: { opacity: 0, transform: "translateY(6px)" }, to: { opacity: 1, transform: "none" } } },
      animation: { "fade-up": "fade-up .35s ease-out both" },
    },
  },
  plugins: [],
};
