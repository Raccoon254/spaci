'use strict';
// Vendored brand logos (src/renderer/icons/brand/<id>.svg, plus <id>-dark.svg
// where SVGL ships a dark-background variant). See icons/brand/README.md.

const BRAND_IDS = [
  // AI tools
  'claude', 'codex', 'opencode', 'cursor', 'windsurf', 'gemini', 'grok', 'zed', 'github-copilot', 'openai',
  // Local AI model stores
  'ollama', 'hugging-face',
  // Containers
  'docker',
  // Browsers
  'chrome', 'firefox', 'safari', 'brave', 'arc', 'edge',
  // Dev environments
  'vscode', 'intellij', 'android',
];

// Ids that have a `<id>-dark.svg` for dark backgrounds.
const hasDark = new Set(['codex', 'opencode', 'cursor', 'windsurf', 'grok', 'zed', 'github-copilot', 'openai', 'ollama']);

// Spaci AI tool id -> brand id (null when there is no vendored logo).
const BRAND_FOR_TOOL = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  windsurf: 'windsurf',
  gemini: 'gemini',
  grok: 'grok',
  zed: 'zed',
  copilot: 'github-copilot',
  continue: null,
  t3: null,
};

// Browser target id (src/browsers.js) -> brand id (null when there is none).
const BRAND_FOR_BROWSER = {
  'browser-chrome': 'chrome',
  'browser-safari': 'safari',
  'browser-firefox': 'firefox',
  'browser-microsoft-edge': 'edge',
  'browser-edge': 'edge', // Windows target id
  'browser-brave': 'brave',
  'browser-arc': 'arc',
  'browser-opera': null,
  'browser-vivaldi': null,
  'browser-chromium': null,
};

const ID_SET = new Set(BRAND_IDS);

function sanitizeBrandId(id) {
  return typeof id === 'string' && ID_SET.has(id) ? id : null;
}

function sanitizeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

module.exports = { BRAND_IDS, hasDark, BRAND_FOR_TOOL, BRAND_FOR_BROWSER, sanitizeBrandId, sanitizeTheme };
