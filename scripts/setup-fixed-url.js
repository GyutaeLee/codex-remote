const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const RUN_DIR = path.join(ROOT_DIR, 'run');
const MANAGED_DIR = path.join(RUN_DIR, 'cloudflared');
const CONFIG_PATH = path.join(MANAGED_DIR, 'config.yml');
const METADATA_PATH = path.join(MANAGED_DIR, 'named-tunnel.json');
const ENV_PATH = path.join(ROOT_DIR, '.env');
const CLOUDFLARED_HOME = path.join(os.homedir(), '.cloudflared');
const CERT_PATH = path.join(CLOUDFLARED_HOME, 'cert.pem');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const TUNNEL_NAME = (process.env.CLOUDFLARE_TUNNEL_NAME || 'codex-remote').trim();
const TUNNEL_HOSTNAME = (process.env.CLOUDFLARE_TUNNEL_HOSTNAME || '').trim();

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

function commandExists(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
    stdio: 'ignore',
  });

  return result.status === 0;
}

function runCommand(command, args, options = {}) {
  const { inherit = false, allowNonZero = false } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    if (!inherit) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowNonZero) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
        return;
      }

      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function ensureDirectories() {
  await fs.mkdir(RUN_DIR, { recursive: true });
  await fs.mkdir(MANAGED_DIR, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureLogin() {
  if (await fileExists(CERT_PATH)) {
    return;
  }

  console.log('Cloudflare login is required. A browser window may open now.');
  await runCommand('cloudflared', ['tunnel', 'login'], { inherit: true });
}

function parseCreateOutput(output) {
  const idMatch = output.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const credentialsMatch = output.match(/([/~A-Za-z0-9._-]+\.json)/);

  return {
    tunnelId: idMatch ? idMatch[1] : null,
    credentialsFile: credentialsMatch ? credentialsMatch[1] : null,
  };
}

async function resolveExistingTunnelId(name) {
  const result = await runCommand('cloudflared', ['tunnel', 'list']);
  const lines = result.stdout.split('\n');

  for (const line of lines) {
    const match = line.trim().match(/^([0-9a-f-]{36})\s+([^\s]+)\s+/i);

    if (match && match[2] === name) {
      return match[1];
    }
  }

  return null;
}

async function ensureTunnel() {
  try {
    const createResult = await runCommand('cloudflared', ['tunnel', 'create', TUNNEL_NAME]);
    const parsed = parseCreateOutput(createResult.stdout);

    if (!parsed.tunnelId) {
      throw new Error('Tunnel was created but tunnel ID could not be parsed from output.');
    }

    return {
      tunnelId: parsed.tunnelId,
      credentialsFile: parsed.credentialsFile || path.join(CLOUDFLARED_HOME, `${parsed.tunnelId}.json`),
      created: true,
    };
  } catch (error) {
    const message = error.message || '';

    if (!/already exists/i.test(message)) {
      throw error;
    }

    const tunnelId = await resolveExistingTunnelId(TUNNEL_NAME);

    if (!tunnelId) {
      throw new Error(`Tunnel "${TUNNEL_NAME}" already exists but its ID could not be resolved.`);
    }

    return {
      tunnelId,
      credentialsFile: path.join(CLOUDFLARED_HOME, `${tunnelId}.json`),
      created: false,
    };
  }
}

async function ensureDnsRoute() {
  try {
    await runCommand('cloudflared', ['tunnel', 'route', 'dns', TUNNEL_NAME, TUNNEL_HOSTNAME]);
    return { created: true };
  } catch (error) {
    const message = error.message || '';

    if (/already exists/i.test(message) || /code:\s*81057/i.test(message)) {
      return { created: false };
    }

    throw error;
  }
}

async function writeConfig(credentialsFile) {
  const config = [
    `tunnel: ${TUNNEL_NAME}`,
    `credentials-file: ${credentialsFile}`,
    'ingress:',
    `  - hostname: ${TUNNEL_HOSTNAME}`,
    `    service: http://127.0.0.1:${PORT}`,
    '  - service: http_status:404',
    '',
  ].join('\n');

  await fs.writeFile(CONFIG_PATH, config, 'utf8');
}

async function writeMetadata(metadata) {
  await fs.writeFile(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function updateEnvModeToNamed() {
  let contents = '';

  try {
    contents = await fs.readFile(ENV_PATH, 'utf8');
  } catch (error) {
    return;
  }

  if (/^CLOUDFLARE_TUNNEL_MODE=/m.test(contents)) {
    contents = contents.replace(/^CLOUDFLARE_TUNNEL_MODE=.*$/m, 'CLOUDFLARE_TUNNEL_MODE=named');
  } else {
    contents = `${contents.trimEnd()}\nCLOUDFLARE_TUNNEL_MODE=named\n`;
  }

  await fs.writeFile(ENV_PATH, contents.endsWith('\n') ? contents : `${contents}\n`, 'utf8');
}

async function main() {
  if (!TUNNEL_HOSTNAME) {
    exitWithError('CLOUDFLARE_TUNNEL_HOSTNAME is required in .env. Example: codex.example.com');
  }

  if (!commandExists('cloudflared')) {
    exitWithError('cloudflared is not installed. Run: brew install cloudflared');
  }

  await ensureDirectories();
  await ensureLogin();

  const tunnel = await ensureTunnel();

  if (!(await fileExists(tunnel.credentialsFile))) {
    exitWithError(
      `Tunnel credentials file was not found at ${tunnel.credentialsFile}. If this tunnel was created elsewhere, recreate it locally or adjust the file path manually.`
    );
  }

  const dnsRoute = await ensureDnsRoute();
  await writeConfig(tunnel.credentialsFile);
  await writeMetadata({
    name: TUNNEL_NAME,
    hostname: TUNNEL_HOSTNAME,
    tunnelId: tunnel.tunnelId,
    credentialsFile: tunnel.credentialsFile,
    configPath: CONFIG_PATH,
    port: PORT,
    createdAt: new Date().toISOString(),
  });
  await updateEnvModeToNamed();

  console.log(`Tunnel name: ${TUNNEL_NAME}`);
  console.log(`Hostname: https://${TUNNEL_HOSTNAME}`);
  console.log(`Tunnel ID: ${tunnel.tunnelId}`);
  console.log(`Credentials: ${tunnel.credentialsFile}`);
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Tunnel created: ${tunnel.created ? 'yes' : 'reused existing'}`);
  console.log(`DNS route: ${dnsRoute.created ? 'created' : 'already existed'}`);
  console.log(`Updated: ${ENV_PATH} -> CLOUDFLARE_TUNNEL_MODE=named`);
  console.log('Next step: run npm run open');
}

main().catch((error) => {
  exitWithError(error.message);
});
