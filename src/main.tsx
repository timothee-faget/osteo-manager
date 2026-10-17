import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/dm-sans";
import App from "./App";
import { applyTheme, savedTheme } from "./theme";

applyTheme(savedTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
