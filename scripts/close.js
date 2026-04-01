const fs = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const RUN_DIR = path.join(ROOT_DIR, 'run');
const MANAGED_DIR = path.join(RUN_DIR, 'cloudflared');
const SERVER_PID_FILE = path.join(RUN_DIR, 'server.pid');
const TUNNEL_PID_FILE = path.join(RUN_DIR, 'tunnel.pid');
const TUNNEL_INFO_FILE = path.join(RUN_DIR, 'tunnel.json');
const NAMED_CONFIG_PATH = path.join(MANAGED_DIR, 'config.yml');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const ENABLE_TAILSCALE_PRIVATE = String(process.env.ENABLE_TAILSCALE_PRIVATE || 'true').toLowerCase() !== 'false';
const CLOUDFLARE_TUNNEL_MODE = (process.env.CLOUDFLARE_TUNNEL_MODE || 'quick').trim().toLowerCase();
const CLOUDFLARE_TUNNEL_NAME = (process.env.CLOUDFLARE_TUNNEL_NAME || 'codex-remote').trim();

async function readPid(filePath) {
  try {
    const value = await fs.readFile(filePath, 'utf8');
    const pid = Number.parseInt(value.trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch (error) {
    return null;
  }
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

function sendSignal(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  let signaled = false;

  try {
    process.kill(-pid, signal);
    signaled = true;
  } catch (error) {
    // Ignore missing process groups and try the direct pid below.
  }

  try {
    process.kill(pid, signal);
    signaled = true;
  } catch (error) {
    // Ignore missing direct pid.
  }

  return signaled;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) {
    return '';
  }

  return result.stdout.trim();
}

function runCommandDetailed(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
}

function getProcessCommand(pid) {
  return runCommand('ps', ['-p', String(pid), '-o', 'command=']);
}

function getProcessCwd(pid) {
  const output = runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const cwdLine = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('n'));

  return cwdLine ? cwdLine.slice(1) : null;
}

function findListeningPids(port) {
  const output = runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('p'))
    .map((line) => Number.parseInt(line.slice(1), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function isManagedServerProcess(pid) {
  return getProcessCwd(pid) === ROOT_DIR;
}

function findServerPid() {
  for (const pid of findListeningPids(PORT)) {
    if (pid !== process.pid && isManagedServerProcess(pid)) {
      return pid;
    }
  }

  return null;
}

function findTunnelPid() {
  const matcher =
    CLOUDFLARE_TUNNEL_MODE === 'named'
      ? `cloudflared tunnel --config ${NAMED_CONFIG_PATH} run ${CLOUDFLARE_TUNNEL_NAME}`
      : `cloudflared tunnel --url http://127.0.0.1:${PORT}`;

  const output = runCommand('ps', ['-axo', 'pid=,command=']);
  const lines = output ? output.split('\n') : [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes(matcher)) {
      continue;
    }

    const [pidValue] = trimmed.split(/\s+/, 1);
    const pid = Number.parseInt(pidValue, 10);

    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }

    if (getProcessCwd(pid) === ROOT_DIR) {
      return pid;
    }
  }

  return null;
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return !isRunning(pid);
}

async function terminateProcess(pid) {
  if (!isRunning(pid)) {
    return false;
  }

  sendSignal(pid, 'SIGTERM');
  if (await waitForExit(pid, 3000)) {
    return true;
  }

  sendSignal(pid, 'SIGKILL');
  return waitForExit(pid, 1500);
}

async function cleanupFile(filePath) {
  await fs.rm(filePath, { force: true });
}

function stopTailscaleServe() {
  if (!ENABLE_TAILSCALE_PRIVATE) {
    console.log('Private URL: disabled (ENABLE_TAILSCALE_PRIVATE=false)');
    return;
  }

  const tailscalePath = runCommand('sh', ['-lc', 'command -v tailscale']);
  if (!tailscalePath) {
    console.log('Private URL: not configured (tailscale not installed)');
    return;
  }

  const result = runCommandDetailed('tailscale', ['serve', '--https=443', 'off']);
  if (result.error) {
    console.log('Private URL: failed to disable Tailscale Serve');
    return;
  }

  if (result.status === 0) {
    console.log('Private URL: disabled');
    return;
  }

  const detail = `${result.stderr || ''}${result.stdout || ''}`.toLowerCase();
  if (detail.includes('serve') && detail.includes('off')) {
    console.log('Private URL: disabled');
    return;
  }

  console.log('Private URL: not configured');
}

async function stopProcess(name, pidFile, findFallbackPid) {
  const recordedPid = await readPid(pidFile);
  const pid = isRunning(recordedPid) ? recordedPid : findFallbackPid();

  if (!pid) {
    await cleanupFile(pidFile);
    console.log(`${name}: not running`);
    return;
  }

  const stopped = await terminateProcess(pid);
  await cleanupFile(pidFile);

  if (stopped) {
    const label = pid === recordedPid ? `${pid}` : `${pid}, discovered`;
    console.log(`${name}: stopped (${label})`);
  } else {
    const label = pid === recordedPid ? `${pid}` : `${pid}, discovered`;
    console.log(`${name}: failed to stop (${label})`);
  }
}

async function main() {
  await stopProcess('Tunnel', TUNNEL_PID_FILE, findTunnelPid);
  await cleanupFile(TUNNEL_INFO_FILE);
  stopTailscaleServe();
  await stopProcess('Server', SERVER_PID_FILE, findServerPid);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
