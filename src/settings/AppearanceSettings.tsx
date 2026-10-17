import { useState } from "react";
import { saveTheme, savedTheme, THEMES, type Theme } from "../theme";

/** Applied at once, no save button: it only changes the display. */
export function AppearanceSettings() {
  const [theme, setTheme] = useState(savedTheme);

  function choose(t: Theme) {
    saveTheme(t);
    setTheme(t);
  }

  return (
    <div className="field">
      Thème
      <div className="segmented" role="group" aria-label="Thème">
        {(Object.keys(THEMES) as Theme[]).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={theme === t}
            onClick={() => choose(t)}
          >
            {THEMES[t]}
          </button>
        ))}
      </div>
      <small>Auto suit le réglage clair ou sombre de macOS.</small>
    </div>
  );
}
