// Inline SVG icon set of the viewer (flat redesign): 24-unit grid drawn at 20 px, 1.75 px strokes,
// `currentColor`, no external requests. Icons are decorative (`aria-hidden`): every control keeps
// its accessible name in text. The markup has no whitespace or text nodes, so a button's
// `textContent` stays exactly its label.

const PATHS = {
  /** Điều khiển: a mouse pointer. */
  control: '<path d="M6 3.5v15.2l4.1-3.9 2.7 6 2.5-1.1-2.7-5.9h5.6z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  /** Hiển thị: sliders. */
  display: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M17.5 10h.01M7.5 14h9"/>',
  camera: '<path d="M4 8.5h3.2L9 6h6l1.8 2.5H20v10.5H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  chat: '<path d="M4 5h16v11.5H10l-6 4z"/>',
  clipboard:
    '<path d="M9 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15"/><rect x="9" y="3" width="6" height="3.5" rx="1"/>',
  speaker: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  fullscreenExit: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4.5H15"/>',
  power: '<path d="M12 3.5v8"/><path d="M7 6.8a7.5 7.5 0 1 0 10 0"/>',
  paperclip:
    '<path d="M19.5 11.5l-7.8 7.8a4.8 4.8 0 0 1-6.8-6.8l8.2-8.2a3.2 3.2 0 0 1 4.5 4.5l-8.2 8.2a1.6 1.6 0 0 1-2.3-2.3l7.4-7.4"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevronDown: '<path d="M7 10l5 5 5-5"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
  paste:
    '<path d="M9 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15"/><rect x="9" y="3" width="6" height="3.5" rx="1"/><path d="M12 10v6.5M9.3 13.8l2.7 2.7 2.7-2.7"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** The icon as an SVG markup string (for `innerHTML` templates). */
export function icon(name: IconName, className = 'icon'): string {
  return (
    `<svg class="${className}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" ` +
    `fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`
  );
}

/** The icon as an element (to swap one in place). */
export function iconElement(name: IconName, className = 'icon'): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = icon(name, className);
  return t.content.firstElementChild as SVGSVGElement;
}
