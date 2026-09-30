'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/tray-policy');

test('tray icon: template glyph on macOS, coloured icon on Windows and Linux', () => {
  assert.deepEqual(t.trayIconSpec('darwin'), { file: 'trayTemplate.png', template: true, size: null });
  assert.deepEqual(t.trayIconSpec('win32'), { file: 'icon.ico', template: false, size: null });
  assert.deepEqual(t.trayIconSpec('linux'), { file: 'icon.png', template: false, size: 22 });
  assert.equal(t.trayIconSpec('freebsd').file, 'icon.png');
  const fs = require('fs');
  const path = require('path');
  for (const p of ['darwin', 'win32', 'linux']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'branding', t.trayIconSpec(p).file)), p);
  }
});

test('tray menu: Open, Scan now, Quit; Restart to Update only when one is ready', () => {
  const ids = (items) => items.map((i) => i.id || i.type);
  assert.deepEqual(ids(t.trayMenuItems()), ['open', 'scan', 'separator', 'quit']);
  const withUpdate = t.trayMenuItems({ updateReadyVersion: '2.3.0' });
  assert.deepEqual(ids(withUpdate), ['open', 'scan', 'separator', 'update', 'separator', 'quit']);
  assert.equal(withUpdate.find((i) => i.id === 'update').label, 'Restart to Update (2.3.0)');
  assert.equal(t.trayMenuItems().find((i) => i.id === 'scan').label, 'Scan now');
  assert.equal(t.usesContextMenuOnly('linux'), true);
  assert.equal(t.usesContextMenuOnly('win32'), false);
  assert.equal(t.usesContextMenuOnly('darwin'), false);
});

test('linux tray guess: stock GNOME has no tray; Ubuntu, KDE and others do; SPACI_TRAY overrides', () => {
  assert.equal(t.linuxTrayLikelyWorks({ XDG_CURRENT_DESKTOP: 'GNOME' }), false);
  assert.equal(t.linuxTrayLikelyWorks({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), true);
  assert.equal(t.linuxTrayLikelyWorks({ XDG_CURRENT_DESKTOP: 'pop:GNOME' }), true);
  assert.equal(t.linuxTrayLikelyWorks({ XDG_CURRENT_DESKTOP: 'KDE' }), true);
  assert.equal(t.linuxTrayLikelyWorks({ XDG_CURRENT_DESKTOP: 'XFCE' }), true);
  assert.equal(t.linuxTrayLikelyWorks({}), true);
  assert.equal(t.linuxTrayLikelyWorks({ XDG_CURRENT_DESKTOP: 'GNOME', SPACI_TRAY: '1' }), true);
  assert.equal(t.linuxTrayLikelyWorks({ XDG_CURRENT_DESKTOP: 'KDE', SPACI_TRAY: '0' }), false);
});

test('closing the window: hide to the tray, quit when there is no tray (except macOS, which has the Dock)', () => {
  assert.equal(t.closeAction({ platform: 'linux', hasTray: true }), 'hide');
  assert.equal(t.closeAction({ platform: 'linux', hasTray: false }), 'quit');
  assert.equal(t.closeAction({ platform: 'win32', hasTray: false }), 'quit');
  assert.equal(t.closeAction({ platform: 'darwin', hasTray: false }), 'hide');
  assert.equal(t.closeAction({ platform: 'linux', hasTray: false, isQuitting: true }), 'close');
  assert.equal(t.closeAction({ platform: 'darwin', hasTray: true, isQuitting: true }), 'close');
});

const screen = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const W = 372, H = 512;

test('taskbar edge comes from the workArea gap, with a per-platform default', () => {
  assert.equal(t.taskbarEdge({ ...screen, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, 'win32'), 'bottom');
  assert.equal(t.taskbarEdge({ ...screen, workArea: { x: 0, y: 25, width: 1920, height: 1055 } }, 'darwin'), 'top');
  assert.equal(t.taskbarEdge({ ...screen, workArea: { x: 48, y: 0, width: 1872, height: 1080 } }, 'win32'), 'left');
  assert.equal(t.taskbarEdge({ ...screen, workArea: { x: 0, y: 0, width: 1872, height: 1080 } }, 'win32'), 'right');
  assert.equal(t.taskbarEdge({ ...screen, workArea: { ...screen.bounds } }, 'win32'), 'bottom');
  assert.equal(t.taskbarEdge({ ...screen, workArea: { ...screen.bounds } }, 'linux'), 'top');
  assert.equal(t.taskbarEdge(null, 'darwin'), 'top');
});

test('popover: under the macOS menu bar icon', () => {
  const display = { ...screen, workArea: { x: 0, y: 25, width: 1920, height: 1055 } };
  const p = t.popoverPosition({ platform: 'darwin', trayBounds: { x: 1500, y: 0, width: 22, height: 24 }, display, width: W, height: H });
  assert.deepEqual(p, { x: 1325, y: 26, edge: 'top' });
});

test('popover: anchored to a bottom Windows taskbar, above the icon, clamped at the right edge', () => {
  const display = { ...screen, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const p = t.popoverPosition({ platform: 'win32', trayBounds: { x: 1880, y: 1044, width: 24, height: 32 }, display, width: W, height: H });
  assert.deepEqual(p, { x: 1920 - W - 6, y: 1040 - H - 6, edge: 'bottom' });
  const left = t.popoverPosition({ platform: 'win32', trayBounds: { x: 8, y: 1000, width: 32, height: 24 }, display: { ...screen, workArea: { x: 48, y: 0, width: 1872, height: 1080 } }, width: W, height: H });
  assert.equal(left.edge, 'left');
  assert.equal(left.x, 54);
  assert.equal(left.y, 1080 - H - 6, 'clamped to the bottom');
});

test('popover: zero tray bounds fall back to the pointer, then to the taskbar corner', () => {
  const display = { ...screen, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const zero = { x: 0, y: 0, width: 0, height: 0 };
  const byCursor = t.popoverPosition({ platform: 'win32', trayBounds: zero, cursor: { x: 900, y: 1060 }, display, width: W, height: H });
  assert.deepEqual(byCursor, { x: 900 - W / 2, y: 1040 - H - 6, edge: 'bottom' });
  const corner = t.popoverPosition({ platform: 'win32', trayBounds: zero, cursor: null, display, width: W, height: H });
  assert.deepEqual(corner, { x: 1920 - W - 6, y: 1040 - H - 6, edge: 'bottom' });
  const linuxTop = t.popoverPosition({ platform: 'linux', trayBounds: zero, cursor: { x: 1800, y: 10 }, display: { ...screen, workArea: { x: 0, y: 32, width: 1920, height: 1048 } }, width: W, height: H });
  assert.deepEqual(linuxTop, { x: 1920 - W - 6, y: 38, edge: 'top' });
  // Nothing known at all still yields a finite on-screen point.
  const blind = t.popoverPosition({ platform: 'linux', trayBounds: undefined, cursor: undefined, display: undefined, width: W, height: H });
  assert.ok(Number.isFinite(blind.x) && Number.isFinite(blind.y));
});
