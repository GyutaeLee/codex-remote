const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const ROOT_DIR = path.resolve(__dirname, '..');
const ROOT_NAME = path.basename(ROOT_DIR);
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(process.env.HOME || ROOT_DIR, '.codex'));

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveDurationMs(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  rootDir: ROOT_DIR,
  publicDir: path.join(ROOT_DIR, 'public'),
  dataDir: path.join(ROOT_DIR, 'data'),
  historyFilePath: path.join(ROOT_DIR, 'data', 'history.json'),
  server: {
    host: process.env.HOST || '127.0.0.1',
    port: parsePositiveInteger(process.env.PORT, 3000),
  },
  auth: {
    token: (process.env.AUTH_TOKEN || '').trim(),
    minTokenLength: parsePositiveInteger(process.env.AUTH_MIN_TOKEN_LENGTH, 24),
    sessionCookieName: (process.env.AUTH_SESSION_COOKIE_NAME || 'codex_remote_session').trim(),
    sessionTtlMs: parsePositiveDurationMs(process.env.AUTH_SESSION_TTL_MS, 12 * 60 * 60 * 1000),
  },
  codex: {
    homeDir: CODEX_HOME,
    globalStatePath: path.join(CODEX_HOME, '.codex-global-state.json'),
    sessionIndexPath: path.join(CODEX_HOME, 'session_index.jsonl'),
    sessionName: 'codex',
    targetPane: 'codex:0.0',
    bin: (process.env.CODEX_BIN || 'codex').trim() || 'codex',
    command: (process.env.CODEX_COMMAND || 'codex').trim() || 'codex',
    appServerTimeoutMs: parsePositiveInteger(process.env.APP_SERVER_TIMEOUT_MS, 20000),
    threadPageSize: parsePositiveInteger(process.env.THREAD_PAGE_SIZE, 100),
    threadSyncTimeoutMs: parsePositiveInteger(process.env.THREAD_SYNC_TIMEOUT_MS, 12000),
    threadSyncPollMs: parsePositiveInteger(process.env.THREAD_SYNC_POLL_MS, 600),
  },
  tmux: {
    captureLines: parsePositiveInteger(process.env.CAPTURE_LINES, 4000),
    responseTimeoutMs: parsePositiveInteger(process.env.RESPONSE_TIMEOUT_MS, 120000),
    pollIntervalMs: parsePositiveInteger(process.env.POLL_INTERVAL_MS, 1200),
    idlePollsBeforeFallback: parsePositiveInteger(process.env.IDLE_POLLS_BEFORE_FALLBACK, 3),
    startupPollMs: 1000,
    startupAttempts: 15,
  },
  limits: {
    maxPromptChars: parsePositiveInteger(process.env.MAX_PROMPT_CHARS, 12000),
    jsonBodyLimit: '1mb',
  },
  history: {
    defaultProjectId: 'default',
    defaultProjectName: ROOT_NAME,
    replayMaxMessages: parsePositiveInteger(process.env.REPLAY_MAX_MESSAGES, 24),
    replayMaxChars: parsePositiveInteger(process.env.REPLAY_MAX_CHARS, 24000),
  },
  security: {
    authRateLimitWindowMs: parsePositiveDurationMs(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    authRateLimitMax: parsePositiveInteger(process.env.AUTH_RATE_LIMIT_MAX, 10),
    apiRateLimitWindowMs: parsePositiveDurationMs(process.env.API_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
    apiRateLimitMax: parsePositiveInteger(process.env.API_RATE_LIMIT_MAX, 2400),
  },
};

function validateConfig() {
  const issues = [];

  if (!config.auth.token) {
    issues.push('AUTH_TOKEN is required in .env');
  }

  if (config.auth.token && config.auth.token.length < config.auth.minTokenLength) {
    issues.push(`AUTH_TOKEN must be at least ${config.auth.minTokenLength} characters long.`);
  }

  return issues;
}

module.exports = {
  config,
  validateConfig,
};
