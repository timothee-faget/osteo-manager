import { useEffect } from "react";

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/**
 * Calls `onIdle` once after `minutes` without user activity.
 * Compares timestamps rather than relying on a single timeout, so a laptop
 * waking from sleep locks right away.
 */
export function useIdle(minutes: number | null, onIdle: () => void) {
  useEffect(() => {
    if (minutes === null) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, touch));
    const timer = setInterval(() => {
      if (Date.now() - last >= minutes * 60_000) {
        clearInterval(timer);
        onIdle();
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, touch));
    };
  }, [minutes, onIdle]);
}
