const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const RUN_DIR = path.join(ROOT_DIR, 'run');
const MANAGED_DIR = path.join(RUN_DIR, 'cloudflared');
const NAMED_CONFIG_PATH = path.join(MANAGED_DIR, 'config.yml');
const SERVER_PID_FILE = path.join(RUN_DIR, 'server.pid');
const TUNNEL_PID_FILE = path.join(RUN_DIR, 'tunnel.pid');
const TUNNEL_INFO_FILE = path.join(RUN_DIR, 'tunnel.json');
const SERVER_LOG_FILE = path.join(RUN_DIR, 'server.log');
const TUNNEL_LOG_FILE = path.join(RUN_DIR, 'tunnel.log');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim();
const CODEX_COMMAND = (process.env.CODEX_COMMAND || 'codex').trim();
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(process.env.HOME || ROOT_DIR, '.codex'));
const ENABLE_CLOUDFLARE_TUNNEL = String(process.env.ENABLE_CLOUDFLARE_TUNNEL || 'true').toLowerCase() !== 'false';
const ENABLE_TAILSCALE_PRIVATE = String(process.env.ENABLE_TAILSCALE_PRIVATE || 'true').toLowerCase() !== 'false';
const CLOUDFLARE_TUNNEL_MODE = (process.env.CLOUDFLARE_TUNNEL_MODE || 'quick').trim().toLowerCase();
const CLOUDFLARE_TUNNEL_NAME = (process.env.CLOUDFLARE_TUNNEL_NAME || 'codex-remote').trim();
const CLOUDFLARE_TUNNEL_HOSTNAME = (process.env.CLOUDFLARE_TUNNEL_HOSTNAME || '').trim();

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureRunDir() {
  await fsp.mkdir(RUN_DIR, { recursive: true });
  await fsp.mkdir(MANAGED_DIR, { recursive: true });
}

async function readPid(filePath) {
  try {
    const value = await fsp.readFile(filePath, 'utf8');
    const pid = Number.parseInt(value.trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch (error) {
    return null;
  }
}

async function writePid(filePath, pid) {
  await fsp.writeFile(filePath, `${pid}\n`, 'utf8');
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function commandExists(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
    stdio: 'ignore',
  });

  return result.status === 0;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });

  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function getProcessCwd(pid) {
  const result = runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const cwdLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('n'));

  return cwdLine ? cwdLine.slice(1) : null;
}

function findListeningPids(port) {
  const result = runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('p'))
    .map((line) => Number.parseInt(line.slice(1), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function isListeningOnPort(pid, port) {
  const result = runCommand('lsof', ['-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn']);
  return result.ok && result.stdout.includes(`p${pid}`);
}

function isManagedServerProcess(pid) {
  return getProcessCwd(pid) === ROOT_DIR && isListeningOnPort(pid, PORT);
}

function findManagedServerPid() {
  for (const pid of findListeningPids(PORT)) {
    if (pid !== process.pid && isManagedServerProcess(pid)) {
      return pid;
    }
  }

  return null;
}

function normalizeDnsName(value) {
  return String(value || '').trim().replace(/\.$/, '');
}

function readTailscaleStatus() {
  const result = runCommand('tailscale', ['status', '--json']);

  if (!result.ok) {
    const detail = `${result.stderr}${result.stdout}`.trim();
    return {
      ok: false,
      warning: detail || 'Tailscale is not running or not signed in on this Mac.',
    };
  }

  try {
    return {
      ok: true,
      data: JSON.parse(result.stdout),
    };
  } catch (error) {
    return {
      ok: false,
      warning: 'Tailscale status could not be parsed.',
    };
  }
}

function buildPrivateUrlFromStatus(status) {
  const dnsName = normalizeDnsName(status?.Self?.DNSName);
  if (!dnsName) {
    return null;
  }

  return `https://${dnsName}`;
}

function startDetachedProcess(command, args, logFile, extraEnv = {}) {
  const outputFd = fs.openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    detached: true,
    stdio: ['ignore', outputFd, outputFd],
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  child.unref();
  fs.closeSync(outputFd);
  return child.pid;
}

async function waitForServerReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `http://127.0.0.1:${PORT}/api/health`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        return true;
      }
    } catch (error) {
      // Server is still booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function waitForTunnelUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

  while (Date.now() < deadline) {
    try {
      const contents = await fsp.readFile(TUNNEL_LOG_FILE, 'utf8');
      const match = contents.match(pattern);

      if (match) {
        return match[0];
      }
    } catch (error) {
      // Tunnel log may not exist yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  return null;
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureCodexHomeWritable() {
  const targets = [CODEX_HOME, path.join(CODEX_HOME, 'sessions')];

  for (const target of targets) {
    if (!(await fileExists(target))) {
      continue;
    }

    try {
      await fsp.access(target, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      const details = [
        `Codex home is not writable: ${target}`,
        'This is usually not a file ownership issue.',
        'Most often, npm run open was started inside the Codex app sandbox, which blocks writes to ~/.codex.',
        'Run npm run open from Terminal.app or iTerm instead of the Codex app terminal.',
        `If you intentionally used sudo in the past, then fix ownership with: sudo chown -R $(whoami) ${CODEX_HOME}`,
      ];

      exitWithError(details.join('\n'));
    }
  }
}

async function ensureServerStarted() {
  const recordedPid = await readPid(SERVER_PID_FILE);
  const existingPid =
    recordedPid && isRunning(recordedPid) && isManagedServerProcess(recordedPid)
      ? recordedPid
      : findManagedServerPid();

  if (existingPid && isRunning(existingPid)) {
    await writePid(SERVER_PID_FILE, existingPid);
    const ready = await waitForServerReady(10000);
    if (!ready) {
      exitWithError(`Server process ${existingPid} exists but health check failed. Run npm run close, then npm run open.`);
    }

    return {
      pid: existingPid,
      alreadyRunning: true,
    };
  }

  const healthyExistingServer = await waitForServerReady(1500);
  if (healthyExistingServer) {
    const discoveredPid = findManagedServerPid();
    if (discoveredPid) {
      await writePid(SERVER_PID_FILE, discoveredPid);
    }

    return {
      pid: discoveredPid,
      alreadyRunning: true,
    };
  }

  const pid = startDetachedProcess(process.execPath, ['src/server.js'], SERVER_LOG_FILE);
  await writePid(SERVER_PID_FILE, pid);

  const ready = await waitForServerReady(30000);
  if (!ready) {
    exitWithError(`Server did not become ready. Check ${SERVER_LOG_FILE}`);
  }

  return {
    pid,
    alreadyRunning: false,
  };
}

async function ensureTunnelStarted() {
  if (!ENABLE_CLOUDFLARE_TUNNEL) {
    return {
      enabled: false,
      publicUrl: null,
      alreadyRunning: false,
    };
  }

  if (!commandExists('cloudflared')) {
    return {
      enabled: true,
      publicUrl: null,
      alreadyRunning: false,
      warning: 'cloudflared is not installed. Run: brew install cloudflared',
    };
  }

  const existingPid = await readPid(TUNNEL_PID_FILE);
  if (existingPid && isRunning(existingPid)) {
    const existingUrl =
      CLOUDFLARE_TUNNEL_MODE === 'named'
        ? CLOUDFLARE_TUNNEL_HOSTNAME
          ? `https://${CLOUDFLARE_TUNNEL_HOSTNAME}`
          : null
        : await waitForTunnelUrl(2000);

    return {
      enabled: true,
      publicUrl: existingUrl,
      alreadyRunning: true,
    };
  }

  await fsp.rm(TUNNEL_LOG_FILE, { force: true });

  if (CLOUDFLARE_TUNNEL_MODE === 'named') {
    if (!CLOUDFLARE_TUNNEL_HOSTNAME) {
      return {
        enabled: true,
        publicUrl: null,
        alreadyRunning: false,
        warning: 'CLOUDFLARE_TUNNEL_HOSTNAME is empty. Set it in .env and run npm run setup:fixed-url',
      };
    }

    if (!(await fileExists(NAMED_CONFIG_PATH))) {
      return {
        enabled: true,
        publicUrl: null,
        alreadyRunning: false,
        warning: `Named tunnel config is missing. Run npm run setup:fixed-url. Expected: ${NAMED_CONFIG_PATH}`,
      };
    }

    const pid = startDetachedProcess(
      'cloudflared',
      ['tunnel', '--config', NAMED_CONFIG_PATH, 'run', CLOUDFLARE_TUNNEL_NAME],
      TUNNEL_LOG_FILE
    );

    await writePid(TUNNEL_PID_FILE, pid);

    const publicUrl = `https://${CLOUDFLARE_TUNNEL_HOSTNAME}`;

    await writeJson(TUNNEL_INFO_FILE, {
      publicUrl,
      mode: 'named',
      hostname: CLOUDFLARE_TUNNEL_HOSTNAME,
      tunnelName: CLOUDFLARE_TUNNEL_NAME,
      configPath: NAMED_CONFIG_PATH,
      createdAt: new Date().toISOString(),
      pid,
    });

    return {
      enabled: true,
      publicUrl,
      alreadyRunning: false,
      pid,
      mode: 'named',
    };
  }

  const pid = startDetachedProcess('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`], TUNNEL_LOG_FILE);
  await writePid(TUNNEL_PID_FILE, pid);

  const publicUrl = await waitForTunnelUrl(20000);

  if (publicUrl) {
    await writeJson(TUNNEL_INFO_FILE, {
      publicUrl,
      mode: 'quick',
      createdAt: new Date().toISOString(),
      pid,
    });
  }

  return {
    enabled: true,
    publicUrl,
    alreadyRunning: false,
    pid,
    mode: 'quick',
  };
}

async function ensurePrivateAccess() {
  if (!ENABLE_TAILSCALE_PRIVATE) {
    return {
      enabled: false,
      privateUrl: null,
      warning: null,
    };
  }

  if (!commandExists('tailscale')) {
    return {
      enabled: true,
      privateUrl: null,
      warning: 'Tailscale is not installed. Install the Tailscale macOS app, sign in on your devices, then run npm run open again.',
    };
  }

  const statusResult = readTailscaleStatus();
  if (!statusResult.ok) {
    return {
      enabled: true,
      privateUrl: null,
      warning: statusResult.warning,
    };
  }

  const status = statusResult.data;
  if (String(status?.BackendState || '').toLowerCase() !== 'running') {
    return {
      enabled: true,
      privateUrl: buildPrivateUrlFromStatus(status),
      warning: 'Tailscale is installed but not connected. Open the Tailscale app and sign in on this Mac.',
    };
  }

  const serveResult = runCommand('tailscale', ['serve', '--bg', '--yes', String(PORT)]);
  if (!serveResult.ok) {
    const detail = `${serveResult.stderr}${serveResult.stdout}`.trim();
    return {
      enabled: true,
      privateUrl: buildPrivateUrlFromStatus(status),
      warning: detail || 'Failed to enable Tailscale Serve for this app.',
    };
  }

  const refreshedStatus = readTailscaleStatus();
  const privateUrl = buildPrivateUrlFromStatus(refreshedStatus.ok ? refreshedStatus.data : status);

  return {
    enabled: true,
    privateUrl,
    warning: null,
  };
}

async function main() {
  if (!AUTH_TOKEN) {
    exitWithError('AUTH_TOKEN is required. Set it in .env before running npm run open.');
  }

  if (!commandExists('tmux')) {
    exitWithError('tmux is not installed. Run: brew install tmux');
  }

  const codexBinary = CODEX_COMMAND.split(/\s+/)[0];
  if (!commandExists(codexBinary)) {
    exitWithError(`Codex CLI command "${codexBinary}" was not found in PATH.`);
  }

  await ensureCodexHomeWritable();
  await ensureRunDir();

  const server = await ensureServerStarted();
  const tunnel = await ensureTunnelStarted();
  const privateAccess = await ensurePrivateAccess();

  console.log(`Local URL:  http://127.0.0.1:${PORT}`);
  console.log(`Server PID: ${server.pid || 'unknown'}${server.alreadyRunning ? ' (already running)' : ''}`);

  if (privateAccess.enabled) {
    if (privateAccess.privateUrl) {
      console.log(`Private URL: ${privateAccess.privateUrl}`);
    } else {
      console.log('Private URL: not available');
    }

    if (privateAccess.warning) {
      console.log(`Warning: ${privateAccess.warning}`);
    }
  } else {
    console.log('Private URL: disabled (ENABLE_TAILSCALE_PRIVATE=false)');
  }

  if (tunnel.enabled) {
    if (tunnel.publicUrl) {
      console.log(`Public URL: ${tunnel.publicUrl}${tunnel.alreadyRunning ? ' (already running)' : ''}`);
    } else if (tunnel.warning) {
      console.log(`Public URL: not available`);
      console.log(`Warning: ${tunnel.warning}`);
    } else {
      console.log(`Public URL: not ready yet. Check ${TUNNEL_LOG_FILE}`);
    }
  } else {
    console.log('Public URL: disabled (ENABLE_CLOUDFLARE_TUNNEL=false)');
  }

  console.log(`Mobile login token: use the AUTH_TOKEN value from ${path.join(ROOT_DIR, '.env')}`);
  console.log(`Logs: ${SERVER_LOG_FILE}`);
}

main().catch((error) => {
  exitWithError(error.message);
});
