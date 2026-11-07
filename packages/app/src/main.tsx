import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { loadCommentaryModel } from "@ipl-sim/engine";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

// Real-commentary model (generated, ~1 MB gzipped): fetched lazily once the app is idle. Until it arrives (or if the
// fetch fails) the engine keeps using its built-in lines, so nothing depends on it.
const preloadCommentary = () => { void loadCommentaryModel("/data/commentary-model.json"); };
if (typeof window !== "undefined") {
  if ("requestIdleCallback" in window) (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(preloadCommentary);
  else setTimeout(preloadCommentary, 2000);
}
