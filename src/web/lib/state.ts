type Listener = () => void;

let privat = false;
const listeners = new Set<Listener>();

export function isPrivat(): boolean {
  return privat;
}

export function togglePrivat(): void {
  privat = !privat;
  listeners.forEach((l) => l());
}

export function onPrivatChange(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function isDesktop(): boolean {
  return window.matchMedia('(min-width: 900px)').matches;
}
