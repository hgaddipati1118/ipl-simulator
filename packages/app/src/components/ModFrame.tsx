import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ModClientMessage } from "@ipl-sim/mods";
import type { GameState } from "../game-state";
import { buildSnapshot, frameDocument, isSafeRoute } from "../mods/snapshot";

interface ModFrameProps {
  title: string;
  html: string;
  state: GameState | null;
  height?: number | string;
  className?: string;
}

/**
 * Renders mod-provided HTML in a sandboxed iframe: scripts run, but with an opaque
 * origin (no access to the app, its storage or cookies) and a CSP that blocks all
 * network access. The only channel is postMessage: the app sends a read-only game
 * snapshot, the mod may ask to navigate or show a toast.
 */
export function ModFrame({ title, html, state, height = "70vh", className }: ModFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const navigate = useNavigate();
  const [toast, setToast] = useState<string | null>(null);
  const snapshot = useMemo(() => buildSnapshot(state), [state]);
  const srcDoc = useMemo(() => frameDocument(html), [html]);

  const push = useCallback(() => {
    // The frame has an opaque origin, so "*" is the only possible target; the payload is read-only game data
    frame.current?.contentWindow?.postMessage({ type: "state", state: snapshot }, "*");
  }, [snapshot]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const msg = e.data as ModClientMessage | undefined;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") push();
      else if (msg.type === "navigate" && isSafeRoute(msg.to)) navigate(msg.to);
      else if (msg.type === "toast" && typeof msg.text === "string") setToast(msg.text.slice(0, 140));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate, push]);

  useEffect(push, [push]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className={`relative ${className ?? ""}`}>
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        onLoad={push}
        style={{ height, width: "100%", border: 0 }}
        className="rounded-xl bg-th-surface"
      />
      {toast && (
        <div role="status" className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-th-overlay text-th-primary text-sm rounded-lg px-4 py-2 shadow-lg border border-th">
          {toast}
        </div>
      )}
    </div>
  );
}
