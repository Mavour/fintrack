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

export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  try {
    return localStorage.getItem('fintrack-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('fintrack-theme', t);
  } catch { /* private mode */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', t === 'dark' ? '#0f151c' : '#0e9f6e');
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}
