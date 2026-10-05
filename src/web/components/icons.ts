/* Single-color line SVG icons (currentColor). No emoji icons. */
const wrap = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const icons = {
  wallet: wrap(
    `<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M20 7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><circle cx="17.5" cy="13.5" r="1.2" fill="currentColor" stroke="none"/>`,
  ),
  chart: wrap(`<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-8"/><path d="M22 20H2"/>`),
  receipt: wrap(
    `<path d="M5 3h14v18l-2.3-1.4L14.4 21l-2.4-1.4L9.6 21l-2.3-1.4L5 21z"/><path d="M9 8h6M9 12h6"/>`,
  ),
  bank: wrap(
    `<path d="M3 9.5 12 4l9 5.5"/><path d="M4 9.5V18M8.5 9.5V18M12 9.5V18M15.5 9.5V18M20 9.5V18"/><path d="M2.5 20.5h19"/>`,
  ),
  minus: wrap(`<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>`),
  plus: wrap(`<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>`),
  swap: wrap(`<path d="M7 4 3.5 7.5 7 11"/><path d="M3.5 7.5H17"/><path d="m17 13 3.5 3.5L17 20"/><path d="M20.5 16.5H7"/>`),
  invest: wrap(`<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5.5"/>`),
  eye: wrap(`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>`),
  eyeOff: wrap(
    `<path d="M4 4l16 16"/><path d="M10.6 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 3.9M6.6 6.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.1 0 2.2-.2 3.1-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>`,
  ),
  search: wrap(`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>`),
  trend: `<svg viewBox="0 0 32 16" width="30" height="15" fill="none" stroke="#0e9f6e" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M1 13 9 8l5 3 7-6 6-3"/></svg>`,
  close: wrap(`<path d="M6 6l12 12M18 6 6 18"/>`),
  moon: wrap(`<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z"/>`),
  sun: wrap(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>`),
};
