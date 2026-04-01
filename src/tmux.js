const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const {
  buildBridgePrompt,
  captureHasPrompt,
  diffCapture,
  extractInteractivePrompt,
  extractFallbackResponse,
  extractMarkedResponse,
  resolveInteractiveActionOption,
  sanitizePrompt,
} = require('./parser');

const SHELL_COMMANDS = new Set(['bash', 'fish', 'sh', 'zsh']);

function createCommandError(command, args, code, stderr) {
  const joinedArgs = args.join(' ');
  const message = stderr || `${command} ${joinedArgs} exited with code ${code}`;
  const error = new Error(message);
  error.code = code;
  error.command = command;
  error.args = args;
  return error;
}

class TmuxBridge {
  constructor(config) {
    this.config = config;
    this.sessionPrimed = false;
  }

  async ensureSession() {
    if (!(await this.isTmuxInstalled())) {
      return {
        status: 'not_ready',
        ready: false,
        tmuxInstalled: false,
        sessionExists: false,
        paneCommand: null,
        sessionName: this.config.codex.sessionName,
      };
    }

    if (!(await this.hasSession())) {
      await this.createSession();
    }

    let state = await this.getSessionState();

    if (state.ready) {
      return state;
    }

    if (state.sessionExists && this.canStartCodex(state.paneCommand, state.paneDead)) {
      await this.startCodex();

      for (let attempt = 0; attempt < this.config.tmux.startupAttempts; attempt += 1) {
        await delay(this.config.tmux.startupPollMs);
        state = await this.getSessionState();

        if (state.ready) {
          return state;
        }
      }
    }

    return state;
  }

  async resetSession() {
    if (await this.isTmuxInstalled()) {
      await this.runTmux(['kill-session', '-t', this.config.codex.sessionName], { allowNonZero: true });
    }

    this.sessionPrimed = false;
    return this.ensureSession();
  }

  async restartIntoThread(threadId, cwd) {
    if (await this.isTmuxInstalled()) {
      await this.runTmux(['kill-session', '-t', this.config.codex.sessionName], { allowNonZero: true });
    }

    this.sessionPrimed = false;
    await this.createSession();

    const command = this.buildCodexCommand(['resume', threadId, '-C', cwd, '--no-alt-screen']);
    await this.sendLiteral(command);
    await this.runTmux(['send-keys', '-t', this.config.codex.targetPane, 'Enter']);
    await this.waitUntilReady();
  }

  async restartIntoFreshThread(cwd) {
    if (await this.isTmuxInstalled()) {
      await this.runTmux(['kill-session', '-t', this.config.codex.sessionName], { allowNonZero: true });
    }

    this.sessionPrimed = false;
    await this.createSession();

    const command = this.buildCodexCommand(['-C', cwd, '--no-alt-screen']);
    await this.sendLiteral(command);
    await this.runTmux(['send-keys', '-t', this.config.codex.targetPane, 'Enter']);
    await this.waitUntilReady();
  }

  async getSessionState() {
    const tmuxInstalled = await this.isTmuxInstalled();

    if (!tmuxInstalled) {
      return {
        status: 'not_ready',
        ready: false,
        tmuxInstalled: false,
        sessionExists: false,
        paneCommand: null,
        paneDead: false,
        sessionName: this.config.codex.sessionName,
      };
    }

    const sessionExists = await this.hasSession();

    if (!sessionExists) {
      return {
        status: 'not_ready',
        ready: false,
        tmuxInstalled: true,
        sessionExists: false,
        paneCommand: null,
        paneDead: false,
        sessionName: this.config.codex.sessionName,
      };
    }

    const info = await this.getPaneInfo();
    const paneCommand = (info.paneCommand || '').trim();
    const paneDead = info.paneDead === '1';
    const ready = !paneDead && this.looksLikeCodexProcess(paneCommand);

    return {
      status: ready ? 'ok' : 'not_ready',
      ready,
      tmuxInstalled: true,
      sessionExists: true,
      paneCommand,
      paneDead,
      sessionName: this.config.codex.sessionName,
    };
  }

  async request(promptText) {
    const sanitizedPrompt = sanitizePrompt(promptText, this.config.limits.maxPromptChars);

    if (!sanitizedPrompt) {
      throw new Error('Prompt is empty after sanitization.');
    }

    const state = await this.ensureSession();

    if (!state.ready) {
      throw new Error('Codex tmux session is not ready.');
    }

    if (!this.sessionPrimed) {
      await delay(1200);
      await this.dismissInterstitals();
      await delay(300);
      this.sessionPrimed = true;
    } else {
      await this.dismissInterstitals();
    }

    const envelope = buildBridgePrompt(sanitizedPrompt);
    const beforeCapture = await this.capturePane();

    await this.sendPrompt(envelope.prompt);

    let timeoutAt = Date.now() + this.config.tmux.responseTimeoutMs;
    let sawAnyChange = false;
    let lastCapture = beforeCapture;
    let stablePolls = 0;

    while (Date.now() < timeoutAt) {
      await delay(this.config.tmux.pollIntervalMs);
      const currentCapture = await this.capturePane();
      const delta = diffCapture(beforeCapture, currentCapture);
      const normalizedCurrentCapture = currentCapture.trimEnd();
      const normalizedLastCapture = lastCapture.trimEnd();

      if (normalizedCurrentCapture !== normalizedLastCapture) {
        sawAnyChange = true;
        stablePolls = 0;
      } else if (sawAnyChange) {
        stablePolls += 1;
      }

      const parsed = extractMarkedResponse(delta, envelope);
      if (parsed.complete) {
        return {
          requestId: envelope.requestId,
          content: parsed.content,
          raw: parsed.raw,
          fallback: false,
        };
      }

      const interactivePrompt = extractInteractivePrompt(currentCapture);

      if (interactivePrompt) {
        timeoutAt = Date.now() + this.config.tmux.responseTimeoutMs;
        stablePolls = 0;
        lastCapture = currentCapture;
        continue;
      }

      const fallback = extractFallbackResponse(delta, envelope);

      if (sawAnyChange && fallback && captureHasPrompt(currentCapture)) {
        return {
          requestId: envelope.requestId,
          content: fallback.content,
          raw: fallback.raw,
          fallback: true,
        };
      }

      if (sawAnyChange && stablePolls >= this.config.tmux.idlePollsBeforeFallback) {
        if (fallback) {
          return {
            requestId: envelope.requestId,
            content: fallback.content,
            raw: fallback.raw,
            fallback: true,
          };
        }
      }

      lastCapture = currentCapture;
    }

    throw new Error('Timed out waiting for Codex response.');
  }

  async getInteractivePrompt() {
    const state = await this.getSessionState();

    if (!state.sessionExists) {
      return null;
    }

    const capture = await this.capturePane();
    return extractInteractivePrompt(capture);
  }

  async answerInteractivePrompt(action, interactivePrompt = null) {
    const prompt = interactivePrompt || (await this.getInteractivePrompt());

    if (!prompt) {
      throw new Error('No interactive prompt is waiting for input.');
    }

    const option = resolveInteractiveActionOption(prompt, action);

    if (!option) {
      throw new Error(`Could not find a "${action}" option for the current interactive prompt.`);
    }

    await this.sendLiteral(option.key);
    await delay(120);
    await this.runTmux(['send-keys', '-t', this.config.codex.targetPane, 'Enter']);

    return {
      prompt,
      option,
    };
  }

  async isTmuxInstalled() {
    try {
      await this.runCommand('tmux', ['-V']);
      return true;
    } catch (error) {
      return false;
    }
  }

  async hasSession() {
    try {
      await this.runTmux(['has-session', '-t', this.config.codex.sessionName]);
      return true;
    } catch (error) {
      return false;
    }
  }

  async createSession() {
    await this.runTmux(['new-session', '-d', '-s', this.config.codex.sessionName, '-n', 'main']);
    await this.runTmux([
      'set-option',
      '-t',
      this.config.codex.sessionName,
      'history-limit',
      String(this.config.tmux.captureLines * 2),
    ]);
    this.sessionPrimed = false;
    await delay(400);
  }

  async startCodex() {
    await this.sendLiteral(this.config.codex.command);
    await this.runTmux(['send-keys', '-t', this.config.codex.targetPane, 'Enter']);
    this.sessionPrimed = false;
  }

  async waitUntilReady() {
    for (let attempt = 0; attempt < this.config.tmux.startupAttempts; attempt += 1) {
      await delay(this.config.tmux.startupPollMs);
      const state = await this.getSessionState();

      if (state.ready) {
        return state;
      }
    }

    throw new Error('Codex tmux session did not become ready in time.');
  }

  async dismissInterstitals() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const capture = await this.capturePane();

      if (!this.hasBlockingInterstitial(capture)) {
        return;
      }

      if (this.hasUpdateInterstitial(capture)) {
        await this.sendLiteral('2');
      }

      await this.runTmux(['send-keys', '-t', this.config.codex.targetPane, 'Enter']);
      await delay(700);
    }
  }

  hasBlockingInterstitial(capture) {
    const normalized = capture.toLowerCase();

    return (
      normalized.includes('update available') ||
      normalized.includes('press enter to continue') ||
      normalized.includes('1. update now')
    );
  }

  hasUpdateInterstitial(capture) {
    const normalized = capture.toLowerCase();
    return normalized.includes('update available') && normalized.includes('1. update now');
  }

  async capturePane() {
    const { stdout } = await this.runTmux([
      'capture-pane',
      '-p',
      '-t',
      this.config.codex.targetPane,
      '-S',
      `-${this.config.tmux.captureLines}`,
    ]);

    return stdout || '';
  }

  async getPaneInfo() {
    const { stdout } = await this.runTmux([
      'display-message',
      '-p',
      '-t',
      this.config.codex.targetPane,
      '#{pane_dead}\t#{pane_current_command}',
    ]);

    const [paneDead = '0', paneCommand = ''] = stdout.trim().split('\t');
    return {
      paneDead,
      paneCommand,
    };
  }

  looksLikeCodexProcess(paneCommand) {
    if (!paneCommand) {
      return false;
    }

    const lower = paneCommand.toLowerCase();

    if (lower.includes('codex')) {
      return true;
    }

    if (SHELL_COMMANDS.has(lower)) {
      return false;
    }

    return true;
  }

  canStartCodex(paneCommand, paneDead) {
    if (paneDead) {
      return false;
    }

    if (!paneCommand) {
      return true;
    }

    return SHELL_COMMANDS.has(paneCommand.toLowerCase());
  }

  async sendPrompt(prompt) {
    for (const chunk of this.chunkText(prompt, 512)) {
      await this.sendLiteral(chunk);
    }

    await delay(120);
    await this.runTmux(['send-keys', '-t', this.config.codex.targetPane, 'Enter']);
  }

  async sendBracketedPaste(text) {
    await this.sendHexBytes(['1b', '5b', '32', '30', '30', '7e']);

    for (const chunk of this.chunkText(text, 512)) {
      await this.sendLiteral(chunk);
    }

    await this.sendHexBytes(['1b', '5b', '32', '30', '31', '7e']);
  }

  async sendHexBytes(bytes) {
    for (const byte of bytes) {
      await this.runTmux(['send-keys', '-t', this.config.codex.targetPane, '-H', byte]);
    }
  }

  async sendLiteral(text) {
    await this.runTmux(['send-keys', '-t', this.config.codex.targetPane, '-l', text]);
  }

  buildCodexCommand(args) {
    return [this.shellQuote(this.config.codex.bin), ...args.map((value) => this.shellQuote(value))].join(' ');
  }

  shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  chunkText(text, chunkSize) {
    const chunks = [];

    for (let index = 0; index < text.length; index += chunkSize) {
      chunks.push(text.slice(index, index + chunkSize));
    }

    return chunks;
  }

  async runTmux(args, options = {}) {
    return this.runCommand('tmux', args, options);
  }

  runCommand(command, args, options = {}) {
    const { allowNonZero = false, timeoutMs = 15000 } = options;

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        if (code !== 0 && !allowNonZero) {
          reject(createCommandError(command, args, code, stderr.trim()));
          return;
        }

        resolve({
          code,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        });
      });
    });
  }
}

module.exports = {
  TmuxBridge,
};
