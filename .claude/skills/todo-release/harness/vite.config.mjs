// Screenshot harness: the real <App/> on top of src/test/fakeBackend, without Tauri.
// npx vite build --config .claude/skills/todo-release/harness/vite.config.mjs
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default {
  root: here("."),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": here("shims/core.ts"),
      "@tauri-apps/plugin-dialog": here("shims/dialog.ts"),
      "@tauri-apps/plugin-updater": here("shims/updater.ts"),
      "@testing-library/react": here("shims/rtl.ts"),
    },
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: here("dist"), emptyOutDir: true },
};
