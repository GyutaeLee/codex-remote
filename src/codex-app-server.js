const { spawn } = require('child_process');
const { EventEmitter } = require('events');

function createTimeoutError(method, timeoutMs) {
  return new Error(`Codex App Server request timed out: ${method} (${timeoutMs}ms)`);
}

class CodexAppServerClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.child = null;
    this.stdoutBuffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.startPromise = null;
  }

  async ensureStarted() {
    if (this.ready && this.child) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.start();

    try {
      await this.startPromise;
    } finally {
      if (!this.ready) {
        this.startPromise = null;
      }
    }
  }

  async start() {
    this.child = spawn(this.config.codex.bin, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (chunk) => {
      this.handleStdoutChunk(chunk);
    });

    this.child.stderr.on('data', (chunk) => {
      const output = chunk.toString().trim();

      if (output) {
        console.warn(`[codex-app-server] ${output}`);
      }
    });

    this.child.on('error', (error) => {
      this.rejectAll(error);
      this.emit('exit', error);
      this.resetProcessState();
    });

    this.child.on('close', (code, signal) => {
      const message =
        signal ? `Codex App Server exited with signal ${signal}` : `Codex App Server exited with code ${code}`;

      const error = new Error(message);
      this.rejectAll(error);
      this.emit('exit', error);
      this.resetProcessState();
    });

    await this.dispatchRequest(
      'initialize',
      {
        clientInfo: {
          name: 'codex-remote',
          version: '1.0.0',
        },
      },
      this.config.codex.appServerTimeoutMs
    );

    this.ready = true;
    this.startPromise = null;
  }

  async listThreads(params = {}) {
    await this.ensureStarted();

    const data = [];
    let cursor = null;

    do {
      const result = await this.sendRequest(
        'thread/list',
        {
          archived: false,
          sortKey: 'updated_at',
          limit: this.config.codex.threadPageSize,
          ...params,
          cursor,
        },
        this.config.codex.appServerTimeoutMs
      );

      data.push(...(result.data || []));
      cursor = result.nextCursor || null;
    } while (cursor);

    return data;
  }

  async readThread(threadId, includeTurns = true) {
    await this.ensureStarted();
    const result = await this.sendRequest(
      'thread/read',
      {
        threadId,
        includeTurns,
      },
      this.config.codex.appServerTimeoutMs
    );

    return result.thread;
  }

  async startThread(cwd) {
    await this.ensureStarted();
    const result = await this.sendRequest(
      'thread/start',
      {
        cwd,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
      this.config.codex.appServerTimeoutMs
    );

    return result.thread;
  }

  async resumeThread(threadId, cwd) {
    await this.ensureStarted();

    const result = await this.sendRequest(
      'thread/resume',
      {
        threadId,
        cwd,
        persistExtendedHistory: false,
      },
      this.config.codex.appServerTimeoutMs
    );

    return result.thread;
  }

  async setThreadName(threadId, name) {
    await this.ensureStarted();

    return this.sendRequest(
      'thread/name/set',
      {
        threadId,
        name,
      },
      this.config.codex.appServerTimeoutMs
    );
  }

  async archiveThread(threadId) {
    await this.ensureStarted();

    return this.sendRequest(
      'thread/archive',
      {
        threadId,
      },
      this.config.codex.appServerTimeoutMs
    );
  }

  async startTurn(threadId, message, cwd = null) {
    await this.ensureStarted();

    return this.sendRequest(
      'turn/start',
      {
        threadId,
        input: [
          {
            type: 'text',
            text: message,
            text_elements: [],
          },
        ],
        cwd,
      },
      this.config.codex.appServerTimeoutMs
    );
  }

  async steerTurn(threadId, expectedTurnId, message) {
    await this.ensureStarted();

    return this.sendRequest(
      'turn/steer',
      {
        threadId,
        expectedTurnId,
        input: [
          {
            type: 'text',
            text: message,
            text_elements: [],
          },
        ],
      },
      this.config.codex.appServerTimeoutMs
    );
  }

  async interruptTurn(threadId, turnId) {
    await this.ensureStarted();

    return this.sendRequest(
      'turn/interrupt',
      {
        threadId,
        turnId,
      },
      this.config.codex.appServerTimeoutMs
    );
  }

  async writeCommandInput(processId, input, closeStdin = false) {
    await this.ensureStarted();

    const params = {
      processId,
      closeStdin: Boolean(closeStdin),
    };

    if (typeof input === 'string') {
      params.deltaBase64 = Buffer.from(input, 'utf8').toString('base64');
    }

    return this.sendRequest('command/exec/write', params, this.config.codex.appServerTimeoutMs);
  }

  async respondToServerRequest(id, result = {}) {
    await this.ensureStarted();

    const child = this.child;

    if (!child || !child.stdin.writable) {
      throw new Error('Codex App Server is not available.');
    }

    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify({ id: String(id), result })}\n`, 'utf8', (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async sendRequest(method, params = {}, timeoutMs = 15000) {
    await this.ensureStarted();
    return this.dispatchRequest(method, params, timeoutMs);
  }

  async dispatchRequest(method, params = {}, timeoutMs = 15000) {
    const child = this.child;

    if (!child || !child.stdin.writable) {
      throw new Error('Codex App Server is not available.');
    }

    const id = String(this.nextId++);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(createTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
      });

      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8', (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  handleStdoutChunk(chunk) {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');

      if (newlineIndex === -1) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      this.handleLine(line);
    }
  }

  handleLine(line) {
    let payload;

    try {
      payload = JSON.parse(line);
    } catch (error) {
      console.warn(`[codex-app-server] Failed to parse stdout line: ${line}`);
      return;
    }

    if (payload.method && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      this.emit('serverRequest', payload);
      return;
    }

    if (payload.method) {
      this.emit('notification', payload);
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'id')) {
      return;
    }

    const pending = this.pending.get(String(payload.id));

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(String(payload.id));

    if (payload.error) {
      pending.reject(new Error(payload.error.message || 'Codex App Server request failed.'));
      return;
    }

    pending.resolve(payload.result);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  resetProcessState() {
    this.ready = false;
    this.child = null;
    this.stdoutBuffer = '';
    this.startPromise = null;
  }
}

module.exports = {
  CodexAppServerClient,
};
