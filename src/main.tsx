import "pixi.js/unsafe-eval";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LocalizationProvider } from "./localization";
import "./styles.css";
import "./ui/styles/customization.css";

const portableMode =
  new URLSearchParams(window.location.search).get("portable") === "1";
if (portableMode) {
  const keepalive = new EventSource("/__keepalive");
  window.addEventListener("pagehide", () => keepalive.close(), { once: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocalizationProvider><App /></LocalizationProvider>
  </StrictMode>,
);
