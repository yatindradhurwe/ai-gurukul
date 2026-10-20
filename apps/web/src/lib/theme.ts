import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "ag.theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme = read()) {
  const dark = theme === "dark" || (theme === "system" && media().matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Current theme preference plus a setter that persists it and updates <html>. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(read);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const m = media();
    const onChange = () => applyTheme("system");
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = (t: Theme) => {
    try {
      t === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t);
    } catch {
      /* private mode: keep it for this visit only */
    }
    setThemeState(t);
  };

  const isDark = theme === "dark" || (theme === "system" && typeof window !== "undefined" && media().matches);
  return { theme, isDark, setTheme };
}
