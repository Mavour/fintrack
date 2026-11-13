let active = false;
export const isScrollActive = (): boolean => active;

/** Keep rendering out of touch gestures and momentum scrolling. */
export function trackScrollActivity(onIdle: () => void, target: EventTarget = window): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let touching = false;
  const changed = (): void => {
    active = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (touching) return;
      active = false;
      onIdle();
    }, 200);
  };
  const start = (): void => { touching = true; changed(); };
  const end = (): void => { touching = false; changed(); };
  const events: Array<[string, () => void]> = [
    ['scroll', changed], ['wheel', changed], ['touchmove', changed],
    ['touchstart', start], ['touchend', end], ['touchcancel', end],
  ];
  for (const [event, handler] of events) target.addEventListener(event, handler, { passive: true });
  return () => {
    clearTimeout(timer);
    active = false;
    for (const [event, handler] of events) target.removeEventListener(event, handler);
  };
}
