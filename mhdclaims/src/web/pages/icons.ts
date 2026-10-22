import { raw, type Html } from '../html.js';

// Decorative inline icons (24px grid, stroke follows the text colour). Always
// paired with visible text, so they are hidden from assistive technology.
const PATHS = {
  camera:
    '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  chat: '<path d="M4 4.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8.5L7 20.5v-4H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><path d="M8 9h8M8 12.5h5"/>',
  payment: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.2"/><path d="M10.5 18.5h3"/>',
  document: '<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M9 13h6M9 16.5h6"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  sign: '<path d="M4 20h16"/><path d="M14.5 4.5 18 8l-9 9H5.5v-3.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

export const icon = (name: IconName, cls = 'icon'): Html =>
  raw(
    `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`,
  );

// Hero illustration: a home, a dented parcel and a check mark.
export const heroArt = raw(`<svg viewBox="0 0 340 260" width="340" height="260" aria-hidden="true" focusable="false">
  <circle cx="186" cy="130" r="112" fill="#ffffff" opacity="0.75"/>
  <path d="M22 226h286" stroke="#b9c8d6" stroke-width="4" stroke-linecap="round"/>
  <path d="M124 118v108h138V118" fill="#ffffff" stroke="#02244d" stroke-width="6" stroke-linejoin="round"/>
  <path d="M106 128 193 60l87 68" fill="none" stroke="#02244d" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="140" y="140" width="28" height="26" rx="3" fill="#d6e6f5"/>
  <rect x="214" y="140" width="28" height="26" rx="3" fill="#d6e6f5"/>
  <rect x="176" y="166" width="34" height="60" rx="3" fill="#02244d"/>
  <g>
    <path d="M34 168h80l4 58H30z" fill="#d9a066"/>
    <path d="M34 168h80l-4 16H38z" fill="#c78d52"/>
    <rect x="65" y="168" width="18" height="58" fill="#f1d3ad"/>
    <path d="M97 192l7 9-6 9 6 9" fill="none" stroke="#7a4f22" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <circle cx="276" cy="72" r="32" fill="#0f71b9" stroke="#fdbf1a" stroke-width="5"/>
  <path d="m261 73 10 10 20-21" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);
