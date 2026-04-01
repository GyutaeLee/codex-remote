const { EventEmitter } = require('events');

function isoNow() {
  return new Date().toISOString();
}

function buildMessagePreview(message) {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEmptyActivity(threadId) {
  return {
    status: 'idle',
    phase: 'idle',
    threadId,
    turnId: null,
    messagePreview: '',
    updatedAt: isoNow(),
  };
}

function createEmptyStreamState() {
  return {
    assistant: {
      itemId: null,
      content: '',
    },
    plan: {
      itemId: null,
      text: '',
      explanation: '',
      steps: [],
    },
    command: null,
    fileChange: null,
  };
}

function createThreadState(threadId) {
  return {
    threadId,
    version: 0,
    activeTurnId: null,
    queueCount: 0,
    activity: createEmptyActivity(threadId),
    pendingAction: null,
    stream: createEmptyStreamState(),
    events: [],
    updatedAt: isoNow(),
  };
}

function summarizeItem(item) {
  if (!item || typeof item !== 'object') {
    return {
      label: 'Working',
      detail: '',
    };
  }

  switch (item.type) {
    case 'agentMessage':
      return {
        label: 'Drafting response',
        detail: '',
      };
    case 'plan':
      return {
        label: 'Updating plan',
        detail: '',
      };
    case 'commandExecution':
      return {
        label: 'Running command',
        detail: item.command || '',
      };
    case 'fileChange':
      return {
        label: 'Applying file changes',
        detail: Array.isArray(item.changes) ? `${item.changes.length} file change(s)` : '',
      };
    case 'mcpToolCall':
      return {
        label: 'Calling MCP tool',
        detail: [item.server, item.tool].filter(Boolean).join(' / '),
      };
    case 'dynamicToolCall':
      return {
        label: 'Calling tool',
        detail: item.tool || '',
      };
    case 'webSearch':
      return {
        label: 'Searching the web',
        detail: item.query || '',
      };
    case 'collabAgentToolCall':
      return {
        label: 'Delegating agent work',
        detail: item.tool || '',
      };
    default:
      return {
        label: item.type || 'Working',
        detail: '',
      };
  }
}

function createEvent(kind, label, detail = '', status = 'info') {
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    kind,
    label,
    detail: String(detail || '').trim(),
    status,
    createdAt: isoNow(),
  };
}

function normalizeApprovalPrompt(method, params) {
  if (method === 'item/commandExecution/requestApproval') {
    const reason = String(params.reason || '').trim();
    const command = String(params.command || '').trim();
    const prompt = reason || (command ? `Allow command execution?\n${command}` : 'Allow command execution?');

    return {
      title: 'Command approval required',
      prompt,
      detail: {
        command,
        cwd: String(params.cwd || '').trim(),
      },
    };
  }

  if (method === 'item/fileChange/requestApproval') {
    return {
      title: 'File change approval required',
      prompt: String(params.reason || '').trim() || 'Allow Codex to apply file changes?',
      detail: {
        grantRoot: String(params.grantRoot || '').trim(),
      },
    };
  }

  return {
    title: 'Permissions approval required',
    prompt: String(params.reason || '').trim() || 'Allow Codex to use the requested permissions?',
    detail: {
      permissions: params.permissions || {},
    },
  };
}

function normalizeServerRequest(payload) {
  const requestId = String(payload.id);

  if (payload.method === 'item/tool/requestUserInput') {
    return {
      pending: true,
      kind: 'user_input',
      requestId,
      threadId: payload.params.threadId,
      turnId: payload.params.turnId,
      itemId: payload.params.itemId,
      title: 'Input required',
      prompt: 'Codex needs more input to continue.',
      questions: Array.isArray(payload.params.questions) ? payload.params.questions : [],
    };
  }

  if (
    payload.method === 'item/commandExecution/requestApproval' ||
    payload.method === 'item/fileChange/requestApproval' ||
    payload.method === 'item/permissions/requestApproval'
  ) {
    const approval = normalizeApprovalPrompt(payload.method, payload.params);

    return {
      pending: true,
      kind: 'approval',
      requestId,
      threadId: payload.params.threadId,
      turnId: payload.params.turnId,
      itemId: payload.params.itemId,
      requestMethod: payload.method,
      title: approval.title,
      prompt: approval.prompt,
      detail: approval.detail,
      canApprove: true,
      canDeny: true,
    };
  }

  return null;
}

function normalizeTerminalPrompt(params) {
  const prompt = String(params?.stdin || '').trim();

  return prompt || 'A running command is waiting for terminal input.';
}

class LiveRuntime extends EventEmitter {
  constructor(appServer) {
    super();
    this.appServer = appServer;
    this.threadStates = new Map();
    this.loadedThreadIds = new Set();
    this.turnWaiters = new Map();
    this.activeThreadId = null;

    this.appServer.on('notification', (payload) => {
      this.handleNotification(payload);
    });

    this.appServer.on('serverRequest', (payload) => {
      this.handleServerRequest(payload);
    });

    this.appServer.on('exit', (error) => {
      this.handleExit(error);
    });
  }

  ensureThreadState(threadId) {
    const normalizedThreadId = String(threadId || '').trim();

    if (!normalizedThreadId) {
      throw new Error('threadId is required.');
    }

    if (!this.threadStates.has(normalizedThreadId)) {
      this.threadStates.set(normalizedThreadId, createThreadState(normalizedThreadId));
    }

    return this.threadStates.get(normalizedThreadId);
  }

  getSnapshot(threadId) {
    return cloneSerializable(this.ensureThreadState(threadId));
  }

  getActivity(threadId) {
    return this.ensureThreadState(threadId).activity;
  }

  getPendingAction(threadId) {
    return this.ensureThreadState(threadId).pendingAction;
  }

  getActiveThreadId() {
    return this.activeThreadId;
  }

  getGlobalActivity() {
    const states = Array.from(this.threadStates.values());
    const activeState = states.find((state) => state.activeTurnId);

    if (activeState) {
      return cloneSerializable(activeState.activity);
    }

    const queuedState = states.find((state) => state.queueCount > 0);

    if (queuedState) {
      return cloneSerializable(queuedState.activity);
    }

    return createEmptyActivity(null);
  }

  getGlobalApprovalState() {
    const states = Array.from(this.threadStates.values());
    const approvalState = states.find(
      (state) => state.pendingAction && state.pendingAction.kind === 'approval'
    );

    if (!approvalState) {
      return null;
    }

    return cloneSerializable(approvalState.pendingAction);
  }

  subscribe(threadId, listener) {
    const eventName = `thread:${threadId}`;
    this.on(eventName, listener);

    return () => {
      this.off(eventName, listener);
    };
  }

  markThreadLoaded(threadId) {
    this.loadedThreadIds.add(String(threadId));
  }

  markQueued(threadId, message) {
    const state = this.ensureThreadState(threadId);
    state.queueCount += 1;
    state.activity = {
      ...state.activity,
      status: 'queued',
      phase: 'queued',
      messagePreview: buildMessagePreview(message),
      updatedAt: isoNow(),
    };
    this.pushEvent(state, createEvent('queued', 'Message queued', state.activity.messagePreview));
    this.emitSnapshot(state.threadId);
  }

  clearQueueMarker(threadId) {
    const state = this.ensureThreadState(threadId);
    state.queueCount = Math.max(0, state.queueCount - 1);
  }

  async startTurnAndWait({ threadId, cwd, message }) {
    const state = this.ensureThreadState(threadId);
    this.clearQueueMarker(threadId);
    this.resetTurnState(state);
    state.activity = {
      status: 'running',
      phase: 'preparing_turn',
      threadId,
      turnId: null,
      messagePreview: buildMessagePreview(message),
      updatedAt: isoNow(),
    };
    this.emitSnapshot(threadId);

    if (!this.loadedThreadIds.has(threadId)) {
      state.activity.phase = 'attaching_thread';
      state.activity.updatedAt = isoNow();
      this.emitSnapshot(threadId);
      await this.appServer.resumeThread(threadId, cwd);
      this.loadedThreadIds.add(threadId);
    }

    state.activity.phase = 'starting_turn';
    state.activity.updatedAt = isoNow();
    this.activeThreadId = threadId;
    this.emitSnapshot(threadId);

    const result = await this.appServer.startTurn(threadId, message, cwd);
    state.activeTurnId = result.turn.id;
    state.activity.turnId = result.turn.id;
    state.activity.phase = 'running';
    state.activity.updatedAt = isoNow();
    this.emitSnapshot(threadId);

    return this.waitForTurnCompletion(result.turn.id);
  }

  async steerTurn(threadId, message) {
    const state = this.ensureThreadState(threadId);

    if (!state.activeTurnId) {
      throw new Error('No active turn is available to steer.');
    }

    if (state.pendingAction) {
      throw new Error('Codex is waiting for a decision before it can continue.');
    }

    state.activity = {
      ...state.activity,
      status: 'running',
      phase: 'running',
      messagePreview: buildMessagePreview(message),
      updatedAt: isoNow(),
    };
    this.pushEvent(state, createEvent('steer', 'Added guidance', state.activity.messagePreview));
    this.emitSnapshot(threadId);

    await this.appServer.steerTurn(threadId, state.activeTurnId, message);

    return this.getSnapshot(threadId);
  }

  async interruptTurn(threadId) {
    const state = this.ensureThreadState(threadId);

    if (!state.activeTurnId) {
      throw new Error('No active turn is running.');
    }

    state.activity = {
      ...state.activity,
      status: 'running',
      phase: 'interrupting',
      updatedAt: isoNow(),
    };
    this.pushEvent(state, createEvent('interrupt', 'Interrupt requested'));
    this.emitSnapshot(threadId);

    await this.appServer.interruptTurn(threadId, state.activeTurnId);

    return this.getSnapshot(threadId);
  }

  async answerApproval(threadId, action) {
    const state = this.ensureThreadState(threadId);
    const pendingAction = state.pendingAction;

    if (!pendingAction || pendingAction.kind !== 'approval') {
      throw new Error('No approval request is waiting for a response.');
    }

    let result;

    if (pendingAction.requestMethod === 'item/permissions/requestApproval') {
      result =
        action === 'approve'
          ? {
              permissions: pendingAction.detail.permissions || {},
              scope: 'turn',
            }
          : {
              permissions: {},
              scope: 'turn',
            };
    } else {
      result = {
        decision: action === 'approve' ? 'accept' : 'decline',
      };
    }

    await this.appServer.respondToServerRequest(pendingAction.requestId, result);

    state.pendingAction = null;
    state.activity = {
      ...state.activity,
      status: 'running',
      phase: 'running',
      updatedAt: isoNow(),
    };
    this.pushEvent(
      state,
      createEvent('approval', action === 'approve' ? 'Approved request' : 'Declined request')
    );
    this.emitSnapshot(threadId);

    return this.getSnapshot(threadId);
  }

  async submitUserInput(threadId, answers) {
    const state = this.ensureThreadState(threadId);
    const pendingAction = state.pendingAction;

    if (!pendingAction || pendingAction.kind !== 'user_input') {
      throw new Error('No user input request is waiting for a response.');
    }

    const responseAnswers = {};

    for (const question of pendingAction.questions) {
      const rawValue = answers?.[question.id];
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      const normalizedValues = values
        .map((value) => String(value || '').trim())
        .filter(Boolean);

      if (normalizedValues.length === 0) {
        throw new Error(`A response is required for "${question.header || question.id}".`);
      }

      responseAnswers[question.id] = {
        answers: normalizedValues,
      };
    }

    await this.appServer.respondToServerRequest(pendingAction.requestId, {
      answers: responseAnswers,
    });

    state.pendingAction = null;
    state.activity = {
      ...state.activity,
      status: 'running',
      phase: 'running',
      updatedAt: isoNow(),
    };
    this.pushEvent(state, createEvent('user-input', 'Submitted follow-up input'));
    this.emitSnapshot(threadId);

    return this.getSnapshot(threadId);
  }

  async submitTerminalInput(threadId, input, closeStdin = false) {
    const state = this.ensureThreadState(threadId);
    const pendingAction = state.pendingAction;

    if (!pendingAction || pendingAction.kind !== 'terminal_input') {
      throw new Error('No terminal input is waiting for a response.');
    }

    const normalizedInput = typeof input === 'string' ? input : '';

    await this.appServer.writeCommandInput(pendingAction.processId, normalizedInput, closeStdin);

    state.pendingAction = null;
    state.activity = {
      ...state.activity,
      status: 'running',
      phase: 'running',
      updatedAt: isoNow(),
    };
    this.pushEvent(
      state,
      createEvent(
        'terminal-input',
        closeStdin ? 'Closed command input' : 'Sent terminal input',
        closeStdin ? '' : normalizedInput.trim()
      )
    );
    this.emitSnapshot(threadId);

    return this.getSnapshot(threadId);
  }

  markError(threadId, error, messagePreview = '') {
    const state = this.ensureThreadState(threadId);
    state.pendingAction = null;
    state.activeTurnId = null;
    state.activity = {
      ...state.activity,
      status: 'error',
      phase: 'error',
      messagePreview: messagePreview || state.activity.messagePreview,
      updatedAt: isoNow(),
    };
    this.pushEvent(
      state,
      createEvent('error', 'Request failed', error?.message || String(error || 'Unknown error'), 'error')
    );

    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
    }

    this.emitSnapshot(threadId);
  }

  waitForTurnCompletion(turnId) {
    return new Promise((resolve, reject) => {
      this.turnWaiters.set(String(turnId), {
        resolve,
        reject,
      });
    });
  }

  resolveTurn(turnId, payload) {
    const waiter = this.turnWaiters.get(String(turnId));

    if (!waiter) {
      return;
    }

    this.turnWaiters.delete(String(turnId));
    waiter.resolve(payload);
  }

  rejectTurn(turnId, error) {
    const waiter = this.turnWaiters.get(String(turnId));

    if (!waiter) {
      return;
    }

    this.turnWaiters.delete(String(turnId));
    waiter.reject(error);
  }

  handleExit(error) {
    for (const state of this.threadStates.values()) {
      if (!state.activeTurnId) {
        continue;
      }

      state.activity = {
        ...state.activity,
        status: 'error',
        phase: 'error',
        updatedAt: isoNow(),
      };
      this.pushEvent(state, createEvent('error', 'App Server stopped', error.message, 'error'));
      this.emitSnapshot(state.threadId);
    }

    for (const turnId of this.turnWaiters.keys()) {
      this.rejectTurn(turnId, error);
    }
  }

  handleServerRequest(payload) {
    const normalized = normalizeServerRequest(payload);

    if (!normalized) {
      return;
    }

    const state = this.ensureThreadState(normalized.threadId);
    state.pendingAction = normalized;
    state.activity = {
      ...state.activity,
      status: 'running',
      phase: normalized.kind === 'user_input' ? 'waiting_for_user_input' : 'waiting_for_approval',
      turnId: normalized.turnId,
      updatedAt: isoNow(),
    };
    this.pushEvent(state, createEvent('blocked', normalized.title, normalized.prompt));
    this.emitSnapshot(state.threadId);
  }

  handleNotification(payload) {
    if (!payload || typeof payload !== 'object' || !payload.method || !payload.params) {
      return;
    }

    const threadId = payload.params.threadId;

    if (!threadId) {
      return;
    }

    const state = this.ensureThreadState(threadId);

    switch (payload.method) {
      case 'thread/status/changed':
        this.handleThreadStatusChanged(state, payload.params.status);
        break;
      case 'turn/started':
        state.activeTurnId = payload.params.turn.id;
        state.activity = {
          ...state.activity,
          status: 'running',
          phase: 'running',
          turnId: payload.params.turn.id,
          updatedAt: isoNow(),
        };
        this.activeThreadId = threadId;
        this.pushEvent(state, createEvent('turn', 'Turn started'));
        break;
      case 'turn/completed':
        this.handleTurnCompleted(state, payload.params.turn);
        break;
      case 'item/started':
        this.handleItemStarted(state, payload.params.item);
        break;
      case 'item/completed':
        this.handleItemCompleted(state, payload.params.item);
        break;
      case 'item/agentMessage/delta':
        this.handleAssistantDelta(state, payload.params);
        break;
      case 'item/plan/delta':
        this.handlePlanDelta(state, payload.params);
        break;
      case 'turn/plan/updated':
        this.handlePlanUpdated(state, payload.params);
        break;
      case 'item/commandExecution/outputDelta':
        this.handleCommandDelta(state, payload.params);
        break;
      case 'item/fileChange/outputDelta':
        this.handleFileChangeDelta(state, payload.params);
        break;
      case 'item/commandExecution/terminalInteraction':
        this.handleTerminalInteraction(state, payload.params);
        break;
      case 'serverRequest/resolved':
        if (state.pendingAction && state.pendingAction.requestId === String(payload.params.requestId)) {
          state.pendingAction = null;
          state.activity = {
            ...state.activity,
            status: state.activeTurnId ? 'running' : 'idle',
            phase: state.activeTurnId ? 'running' : 'idle',
            updatedAt: isoNow(),
          };
        }
        break;
      default:
        return;
    }

    this.emitSnapshot(threadId);
  }

  handleThreadStatusChanged(state, status) {
    if (!status || typeof status !== 'object') {
      return;
    }

    if (status.type === 'active') {
      if (Array.isArray(status.activeFlags) && status.activeFlags.includes('waitingOnApproval')) {
        state.activity = {
          ...state.activity,
          status: 'running',
          phase: 'waiting_for_approval',
          updatedAt: isoNow(),
        };
      } else if (Array.isArray(status.activeFlags) && status.activeFlags.includes('waitingOnUserInput')) {
        state.activity = {
          ...state.activity,
          status: 'running',
          phase: 'waiting_for_user_input',
          updatedAt: isoNow(),
        };
      } else {
        state.activity = {
          ...state.activity,
          status: 'running',
          phase: 'running',
          updatedAt: isoNow(),
        };
      }

      return;
    }

    if (status.type === 'idle' && !state.activeTurnId) {
      state.activity = {
        ...state.activity,
        status: state.queueCount > 0 ? 'queued' : 'idle',
        phase: state.queueCount > 0 ? 'queued' : 'idle',
        updatedAt: isoNow(),
      };
      return;
    }

    if (status.type === 'systemError') {
      state.activity = {
        ...state.activity,
        status: 'error',
        phase: 'error',
        updatedAt: isoNow(),
      };
      this.pushEvent(state, createEvent('error', 'Thread entered a system error state', '', 'error'));
    }
  }

  handleTurnCompleted(state, turn) {
    const nextPhase =
      turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
    const nextStatus = turn.status === 'failed' ? 'error' : turn.status === 'completed' ? 'completed' : 'idle';

    state.activity = {
      ...state.activity,
      status: nextStatus,
      phase: nextPhase,
      turnId: turn.id,
      updatedAt: isoNow(),
    };
    state.activeTurnId = null;
    state.pendingAction = null;

    if (this.activeThreadId === state.threadId) {
      this.activeThreadId = null;
    }

    this.pushEvent(
      state,
      createEvent(
        'turn',
        turn.status === 'completed'
          ? 'Turn completed'
          : turn.status === 'interrupted'
            ? 'Turn interrupted'
            : 'Turn failed',
        turn.error?.message || '',
        turn.status === 'failed' ? 'error' : 'info'
      )
    );

    this.resolveTurn(turn.id, {
      turnId: turn.id,
      status: turn.status,
    });
  }

  handleItemStarted(state, item) {
    const summary = summarizeItem(item);
    this.pushEvent(state, createEvent('item', summary.label, summary.detail));

    if (item.type === 'agentMessage') {
      state.stream.assistant = {
        itemId: item.id,
        content: item.text || '',
      };
    }

    if (item.type === 'commandExecution') {
      state.stream.command = {
        itemId: item.id,
        command: item.command || '',
        cwd: item.cwd || '',
        output: item.aggregatedOutput || '',
        status: item.status || 'inProgress',
      };
    }

    if (item.type === 'fileChange') {
      state.stream.fileChange = {
        itemId: item.id,
        output: '',
        status: item.status || 'inProgress',
      };
    }
  }

  handleItemCompleted(state, item) {
    if (item.type === 'agentMessage') {
      state.stream.assistant = {
        itemId: item.id,
        content: item.text || state.stream.assistant.content,
      };
      return;
    }

    if (item.type === 'plan') {
      state.stream.plan = {
        itemId: item.id,
        text: item.text || state.stream.plan.text,
        explanation: state.stream.plan.explanation,
        steps: state.stream.plan.steps,
      };
      return;
    }

    if (item.type === 'commandExecution') {
      state.stream.command = {
        itemId: item.id,
        command: item.command || '',
        cwd: item.cwd || '',
        output: item.aggregatedOutput || state.stream.command?.output || '',
        status: item.status || 'completed',
      };
      return;
    }

    if (item.type === 'fileChange') {
      state.stream.fileChange = {
        itemId: item.id,
        output: state.stream.fileChange?.output || '',
        status: item.status || 'completed',
      };
    }
  }

  handleAssistantDelta(state, params) {
    if (!state.stream.assistant || state.stream.assistant.itemId !== params.itemId) {
      state.stream.assistant = {
        itemId: params.itemId,
        content: '',
      };
    }

    state.stream.assistant.content += params.delta || '';
    state.activity = {
      ...state.activity,
      status: 'running',
      phase: 'running',
      updatedAt: isoNow(),
    };
  }

  handlePlanDelta(state, params) {
    if (!state.stream.plan || state.stream.plan.itemId !== params.itemId) {
      state.stream.plan = {
        itemId: params.itemId,
        text: '',
        explanation: '',
        steps: [],
      };
    }

    state.stream.plan.text += params.delta || '';
  }

  handlePlanUpdated(state, params) {
    state.stream.plan = {
      itemId: state.stream.plan.itemId,
      text: state.stream.plan.text,
      explanation: String(params.explanation || '').trim(),
      steps: Array.isArray(params.plan) ? params.plan : [],
    };
  }

  handleCommandDelta(state, params) {
    if (!state.stream.command || state.stream.command.itemId !== params.itemId) {
      state.stream.command = {
        itemId: params.itemId,
        command: '',
        cwd: '',
        output: '',
        status: 'inProgress',
      };
    }

    state.stream.command.output += params.delta || '';
  }

  handleTerminalInteraction(state, params) {
    state.pendingAction = {
      pending: true,
      kind: 'terminal_input',
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      processId: params.processId,
      title: 'Terminal input required',
      prompt: normalizeTerminalPrompt(params),
    };
    state.activity = {
      ...state.activity,
      status: 'running',
      phase: 'waiting_for_terminal_input',
      turnId: params.turnId,
      updatedAt: isoNow(),
    };
    this.pushEvent(state, createEvent('blocked', 'Terminal input required', state.pendingAction.prompt));
  }

  handleFileChangeDelta(state, params) {
    if (!state.stream.fileChange || state.stream.fileChange.itemId !== params.itemId) {
      state.stream.fileChange = {
        itemId: params.itemId,
        output: '',
        status: 'inProgress',
      };
    }

    state.stream.fileChange.output += params.delta || '';
  }

  resetTurnState(state) {
    state.pendingAction = null;
    state.stream = createEmptyStreamState();
  }

  pushEvent(state, event) {
    state.events = [event, ...state.events].slice(0, 20);
  }

  emitSnapshot(threadId) {
    const state = this.ensureThreadState(threadId);
    state.version += 1;
    state.updatedAt = isoNow();
    this.emit(`thread:${threadId}`, this.getSnapshot(threadId));
  }
}

module.exports = {
  LiveRuntime,
};
