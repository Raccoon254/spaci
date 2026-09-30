'use strict';
/**
 * Tray decisions that differ per platform, kept pure so they are tested
 * without Electron:
 *   - which icon file (macOS template glyph; a coloured icon on Windows and
 *     Linux, where a black template glyph disappears on a dark taskbar);
 *   - the context menu (Linux shows only this menu: AppIndicator trays never
 *     send click events);
 *   - where the popover goes, including when Electron reports empty tray
 *     bounds (always on Linux, sometimes on Windows);
 *   - what closing the main window does when there is no usable tray.
 */

const ICON_SPECS = {
  darwin: { file: 'trayTemplate.png', template: true, size: null },
  win32: { file: 'icon.ico', template: false, size: null },
  linux: { file: 'icon.png', template: false, size: 22 },
};

/** The tray icon for a platform: { file (in assets/branding), template, size (px to resize to, or null) }. */
function trayIconSpec(platform = process.platform) {
  return { ...(ICON_SPECS[platform] || ICON_SPECS.linux) };
}

/**
 * Menu entries, top to bottom, as plain data ({ id, label } or { type:
 * 'separator' }). main.js attaches the click handlers by id.
 */
function trayMenuItems({ updateReadyVersion = null } = {}) {
  const items = [
    { id: 'open', label: 'Open Spaci' },
    { id: 'scan', label: 'Scan now' },
  ];
  if (updateReadyVersion) {
    items.push({ type: 'separator' }, { id: 'update', label: `Restart to Update (${updateReadyVersion})` });
  }
  items.push({ type: 'separator' }, { id: 'quit', label: 'Quit Spaci' });
  return items;
}

/** Does the tray set a context menu (shown on any click) instead of a click popover? */
function usesContextMenuOnly(platform = process.platform) {
  return platform === 'linux';
}

/**
 * Can a tray icon be expected to show on this Linux desktop? Stock GNOME has
 * no status area without an extension, so the icon would be invisible and a
 * hidden window unreachable. Ubuntu's GNOME ships the AppIndicator extension.
 * SPACI_TRAY=1 or 0 overrides the guess.
 */
function linuxTrayLikelyWorks(env = process.env) {
  if (env.SPACI_TRAY === '1') return true;
  if (env.SPACI_TRAY === '0') return false;
  const desk = String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase();
  if (!desk) return true;
  const parts = desk.split(':');
  if (parts.includes('gnome') && !parts.includes('ubuntu') && !parts.includes('unity') && !parts.includes('pop')) return false;
  return true;
}

/** Closing the main window: 'close' (quitting), 'hide' (keep running in the tray) or 'quit'. */
function closeAction({ platform = process.platform, hasTray = true, isQuitting = false } = {}) {
  if (isQuitting) return 'close';
  if (hasTray) return 'hide';
  // No tray to come back from. macOS still has the Dock icon.
  return platform === 'darwin' ? 'hide' : 'quit';
}

const validRect = (r) => Boolean(r) && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;

/** Which screen edge the taskbar or menu bar is on, from the gap between bounds and workArea. */
function taskbarEdge(display, platform = process.platform) {
  const b = display && display.bounds;
  const w = display && display.workArea;
  if (validRect(b) && validRect(w)) {
    const gaps = {
      top: w.y - b.y,
      bottom: (b.y + b.height) - (w.y + w.height),
      left: w.x - b.x,
      right: (b.x + b.width) - (w.x + w.width),
    };
    const [edge, gap] = Object.entries(gaps).sort((a, c) => c[1] - a[1])[0];
    if (gap > 0) return edge;
  }
  return platform === 'win32' ? 'bottom' : 'top';
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * Where to put the popover window: next to the tray icon when Electron knows
 * where it is, otherwise next to the pointer (the click that opened it), and
 * failing that in the corner of the taskbar edge. Always inside workArea.
 * @returns {{x:number, y:number, edge:string}}
 */
function popoverPosition({ platform = process.platform, trayBounds, cursor, display, width, height, margin = 6 }) {
  const area = (display && validRect(display.workArea)) ? display.workArea : { x: 0, y: 0, width: width + 2 * margin, height: height + 2 * margin };
  const edge = taskbarEdge(display, platform);
  let anchor = null;
  if (validRect(trayBounds)) anchor = { x: trayBounds.x + trayBounds.width / 2, y: trayBounds.y + trayBounds.height / 2 };
  else if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) anchor = { x: cursor.x, y: cursor.y };
  else {
    // Tray icons sit at the right end of a horizontal bar, the bottom of a vertical one.
    anchor = edge === 'left' || edge === 'right'
      ? { x: area.x, y: area.y + area.height }
      : { x: area.x + area.width, y: area.y };
  }
  const minX = area.x + margin;
  const maxX = area.x + area.width - width - margin;
  const minY = area.y + margin;
  const maxY = area.y + area.height - height - margin;
  let x;
  let y;
  if (edge === 'left' || edge === 'right') {
    x = edge === 'left' ? minX : maxX;
    y = clamp(Math.round(anchor.y - height / 2), minY, maxY);
  } else {
    x = clamp(Math.round(anchor.x - width / 2), minX, maxX);
    if (edge === 'bottom') y = maxY;
    // macOS: just under the menu bar icon when its bounds are known.
    else y = platform === 'darwin' && validRect(trayBounds) ? clamp(Math.round(trayBounds.y + trayBounds.height + 2), area.y, maxY) : minY;
  }
  return { x, y, edge };
}

module.exports = {
  trayIconSpec, trayMenuItems, usesContextMenuOnly, linuxTrayLikelyWorks, closeAction, taskbarEdge, popoverPosition,
};
