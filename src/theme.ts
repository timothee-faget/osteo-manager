/**
 * Light / dark choice. Kept in the webview's local storage, not the database:
 * it must apply on the lock screen, before the database is unlocked.
 */
export type Theme = "auto" | "light" | "dark";

export const THEMES: Record<Theme, string> = {
  auto: "Auto",
  light: "Clair",
  dark: "Sombre",
};

const KEY = "theme";

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

/** "auto" leaves `data-theme` unset, so the CSS follows macOS. */
export function applyTheme(theme: Theme) {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable: the choice lasts until the app closes.
  }
}
