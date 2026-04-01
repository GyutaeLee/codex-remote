const express = require('express');
const path = require('path');
const { config, validateConfig } = require('./config');
const {
  clearSessionCookie,
  createAuthMiddleware,
  createSessionStore,
  getBearerToken,
  isLoopbackRequest,
  isSecureRequest,
  isValidBearerToken,
  readSessionId,
  setSessionCookie,
} = require('./auth');
const { createRateLimiter } = require('./rate-limit');
const { SerialQueue } = require('./queue');
const { TmuxBridge } = require('./tmux');
const { sanitizePrompt } = require('./parser');
const { CodexAppServerClient } = require('./codex-app-server');
const { NativeCodexStore } = require('./codex-native');
const { LiveRuntime } = require('./live-runtime');

const app = express();
const queue = new SerialQueue();
const tmux = new TmuxBridge(config);
const appServer = new CodexAppServerClient(config);
const nativeStore = new NativeCodexStore(config, appServer);
const liveRuntime = new LiveRuntime(appServer);
const sessionStore = createSessionStore(config.auth.sessionTtlMs);
const authMiddleware = createAuthMiddleware({
  expectedToken: config.auth.token,
  sessionStore,
  sessionCookieName: config.auth.sessionCookieName,
});
const authRateLimit = createRateLimiter({
  windowMs: config.security.authRateLimitWindowMs,
  max: config.security.authRateLimitMax,
  message: 'Too many login attempts. Try again later.',
});
const apiRateLimit = createRateLimiter({
  windowMs: config.security.apiRateLimitWindowMs,
  max: config.security.apiRateLimitMax,
  message: 'Too many API requests. Slow down and try again shortly.',
});
const runtime = {
  liveThreadId: null,
  pendingThreads: new Map(),
  activity: {
    status: 'idle',
    phase: 'idle',
    threadId: null,
    messagePreview: '',
    updatedAt: null,
  },
  activityResetTimer: null,
};
const DEFAULT_HISTORY_PAGE_SIZE = 5;

function buildEmptyApprovalState() {
  return {
    pending: false,
    kind: null,
    prompt: '',
    options: [],
    canApprove: false,
    canDeny: false,
    updatedAt: null,
  };
}

function buildApprovalStateFromPendingAction(pendingAction) {
  if (!pendingAction || pendingAction.kind !== 'approval') {
    return buildEmptyApprovalState();
  }

  return {
    pending: true,
    kind: pendingAction.requestMethod === 'item/permissions/requestApproval' ? 'permissions' : 'approval',
    prompt: pendingAction.prompt,
    options: [
      { key: '1', label: 'Approve' },
      { key: '2', label: 'Deny' },
    ],
    canApprove: true,
    canDeny: true,
    updatedAt: isoNow(),
  };
}

function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function respondSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    ok: true,
    data,
  });
}

function normalizeStringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBooleanValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }
  }

  return false;
}

function isoNow() {
  return new Date().toISOString();
}

function buildMessagePreview(message) {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function writeSseEvent(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function scheduleActivityReset() {
  if (runtime.activityResetTimer) {
    clearTimeout(runtime.activityResetTimer);
  }

  runtime.activityResetTimer = setTimeout(() => {
    runtime.activity = {
      status: 'idle',
      phase: 'idle',
      threadId: null,
      messagePreview: '',
      updatedAt: isoNow(),
    };
    runtime.activityResetTimer = null;
  }, 4000);
}

function setActivity(status, phase, details = {}) {
  if (runtime.activityResetTimer) {
    clearTimeout(runtime.activityResetTimer);
    runtime.activityResetTimer = null;
  }

  runtime.activity = {
    status,
    phase,
    threadId: details.threadId ?? runtime.activity.threadId ?? null,
    messagePreview: details.messagePreview ?? runtime.activity.messagePreview ?? '',
    updatedAt: isoNow(),
  };

  if (status === 'completed' || status === 'error') {
    scheduleActivityReset();
  }
}

function optionMatchesAction(option, action) {
  const label = String(option?.label || '').toLowerCase();

  if (!label) {
    return false;
  }

  if (action === 'approve') {
    return /\b(yes|approve|allow|accept|continue|run once)\b/.test(label);
  }

  return /\b(no|deny|reject|decline|abort|cancel|quit)\b/.test(label);
}

async function getApprovalState() {
  const prompt = await tmux.getInteractivePrompt().catch(() => null);

  if (!prompt) {
    return buildEmptyApprovalState();
  }

  return {
    pending: true,
    kind: prompt.kind,
    prompt: prompt.prompt,
    options: prompt.options,
    canApprove: prompt.options.some((option) => optionMatchesAction(option, 'approve')),
    canDeny: prompt.options.some((option) => optionMatchesAction(option, 'deny')),
    updatedAt: isoNow(),
  };
}

function getLiveSnapshot(threadId) {
  if (!threadId) {
    return null;
  }

  try {
    return liveRuntime.getSnapshot(threadId);
  } catch (error) {
    return null;
  }
}

function getThreadIdFromRequest(req) {
  return normalizeStringValue(req.body?.threadId ?? req.query?.threadId);
}

function getProjectPathFromRequest(req) {
  return normalizeStringValue(req.body?.projectPath ?? req.query?.projectPath);
}

function parseHistoryLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HISTORY_PAGE_SIZE;
  }

  return Math.min(parsed, 100);
}

function adjustPageStart(messages, start) {
  if (start <= 0 || start >= messages.length) {
    return Math.max(start, 0);
  }

  if (messages[start]?.role === 'user') {
    return start;
  }

  for (let index = start - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }

  return 0;
}

function paginateMessages(messages, limit, beforeMessageId) {
  if (!beforeMessageId) {
    const start = adjustPageStart(messages, Math.max(messages.length - limit, 0));

    return {
      messages: messages.slice(start),
      hasMore: start > 0,
      nextBeforeMessageId: start > 0 ? messages[start - 1].id : null,
    };
  }

  const endIndex = messages.findIndex((message) => message.id === beforeMessageId);

  if (endIndex <= 0) {
    return {
      messages: [],
      hasMore: false,
      nextBeforeMessageId: null,
    };
  }

  const start = adjustPageStart(messages, Math.max(endIndex - limit, 0));

  return {
    messages: messages.slice(start, endIndex),
    hasMore: start > 0,
    nextBeforeMessageId: start > 0 ? messages[start - 1].id : null,
  };
}

async function buildWorkspacePayload(projectPath) {
  const workspace = await nativeStore.getWorkspaceSnapshot(projectPath);
  const visibleThreadIds = new Set(workspace.threads.map((thread) => thread.id));
  const pendingThreads = Array.from(runtime.pendingThreads.values());

  for (const thread of pendingThreads) {
    if (visibleThreadIds.has(thread.id)) {
      runtime.pendingThreads.delete(thread.id);
    }
  }

  const pendingCountByProject = new Map();

  for (const thread of runtime.pendingThreads.values()) {
    pendingCountByProject.set(thread.cwd, (pendingCountByProject.get(thread.cwd) || 0) + 1);
  }

  const selectedPendingThreads = workspace.selectedProject
    ? Array.from(runtime.pendingThreads.values()).filter(
        (thread) => thread.cwd === workspace.selectedProject.path && !visibleThreadIds.has(thread.id)
      )
    : [];

  return {
    ...workspace,
    projects: workspace.projects.map((project) => ({
      ...project,
      threadCount: project.threadCount + (pendingCountByProject.get(project.path) || 0),
    })),
    selectedProject: workspace.selectedProject
      ? {
          ...workspace.selectedProject,
          threadCount:
            workspace.selectedProject.threadCount +
            (pendingCountByProject.get(workspace.selectedProject.path) || 0),
        }
      : null,
    pinnedThreads: workspace.pinnedThreads || [],
    threads: [...selectedPendingThreads, ...workspace.threads].sort((left, right) => {
      if (Boolean(left.isPinned) !== Boolean(right.isPinned)) {
        return left.isPinned ? -1 : 1;
      }

      if (left.updatedAtUnix === right.updatedAtUnix) {
        return String(left.id).localeCompare(String(right.id)) * -1;
      }

      return (right.updatedAtUnix || 0) - (left.updatedAtUnix || 0);
    }),
    liveThreadId: liveRuntime.getActiveThreadId() || runtime.liveThreadId,
  };
}

async function getResolvedProjectPath(requestedProjectPath) {
  const workspace = await nativeStore.getWorkspaceSnapshot(requestedProjectPath);
  return workspace.selectedProject?.path || null;
}

async function getThreadOrThrow(threadId, includeTurns = true) {
  if (!threadId) {
    const error = new Error('threadId is required.');
    error.statusCode = 400;
    throw error;
  }

  const pendingThread = runtime.pendingThreads.get(threadId);

  if (pendingThread) {
    return {
      ...pendingThread,
      turns: [],
      messages: [],
      path: null,
      modelProvider: null,
      cliVersion: null,
    };
  }

  try {
    return await nativeStore.getThread(threadId, includeTurns);
  } catch (error) {
    error.statusCode = error.statusCode || 404;
    throw error;
  }
}

async function ensureThreadLoaded(thread) {
  const sessionState = await tmux.getSessionState();

  if (runtime.liveThreadId === thread.id && sessionState.ready) {
    return;
  }

  await tmux.restartIntoThread(thread.id, thread.cwd);
  runtime.liveThreadId = thread.id;
}

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: config.limits.jsonBodyLimit }));
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; ')
  );

  if (req.path === '/' || req.path === '/index.html' || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  return next();
});
app.use(express.static(path.join(config.rootDir, 'public')));

app.post(
  '/api/auth/session',
  authRateLimit,
  asyncRoute(async (req, res) => {
    const providedToken =
      typeof req.body?.token === 'string' ? req.body.token.trim() : getBearerToken(req);

    if (!isValidBearerToken(config.auth.token, providedToken)) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid bearer token.',
      });
    }

    const existingSessionId = readSessionId(req, config.auth.sessionCookieName);

    if (existingSessionId) {
      sessionStore.delete(existingSessionId);
    }

    const session = sessionStore.create({
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });

    setSessionCookie(res, config.auth.sessionCookieName, session.id, req, config.auth.sessionTtlMs);

    return respondSuccess(res, {
      authenticated: true,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  })
);

app.post('/api/auth/logout', (req, res) => {
  const sessionId = readSessionId(req, config.auth.sessionCookieName);

  if (sessionId) {
    sessionStore.delete(sessionId);
  }

  clearSessionCookie(res, config.auth.sessionCookieName, req);

  return respondSuccess(res, {
    authenticated: false,
  });
});

app.use('/api', (req, res, next) => {
  if (isSecureRequest(req) || isLoopbackRequest(req)) {
    return next();
  }

  return res.status(403).json({
    ok: false,
    error: 'HTTPS is required for remote API access.',
  });
});

app.use('/api', apiRateLimit, authMiddleware);

app.get(
  '/api/health',
  asyncRoute(async (req, res) => {
    const projectPath = getProjectPathFromRequest(req);
    const threadId = getThreadIdFromRequest(req);
    const liveSnapshot = getLiveSnapshot(threadId);
    const liveApproval = buildApprovalStateFromPendingAction(liveSnapshot?.pendingAction);
    const [sessionState, workspace, tmuxApproval] = await Promise.all([
      tmux.getSessionState(),
      nativeStore.getWorkspaceSnapshot(projectPath).catch(() => ({
        projects: [],
        selectedProject: null,
        threads: [],
      })),
      getApprovalState(),
    ]);

    return respondSuccess(res, {
      server: {
        status: 'ok',
      },
      codex: sessionState,
      queue: queue.getState(),
      workspace: {
        projectCount: workspace.projects.length,
        selectedProjectPath: workspace.selectedProject?.path || null,
      },
      liveThreadId: liveRuntime.getActiveThreadId() || runtime.liveThreadId,
      activity: liveSnapshot?.activity || liveRuntime.getGlobalActivity(),
      approval: liveApproval.pending ? liveApproval : tmuxApproval,
      live: liveSnapshot,
    });
  })
);

app.get(
  '/api/threads',
  asyncRoute(async (req, res) => {
    return respondSuccess(res, await buildWorkspacePayload(getProjectPathFromRequest(req)));
  })
);

app.post(
  '/api/threads',
  asyncRoute(async (req, res) => {
    const projectPath = getProjectPathFromRequest(req) || (await getResolvedProjectPath(null));

    if (!projectPath) {
      return res.status(400).json({
        ok: false,
        error: 'projectPath is required.',
      });
    }

    const thread = await nativeStore.createThread(projectPath);
    runtime.pendingThreads.set(thread.id, {
      ...thread,
      isPending: true,
    });
    liveRuntime.markThreadLoaded(thread.id);

    return respondSuccess(
      res,
      {
        thread,
        ...(await buildWorkspacePayload(projectPath)),
      },
      201
    );
  })
);

app.post(
  '/api/threads/rename',
  asyncRoute(async (req, res) => {
    const threadId = getThreadIdFromRequest(req);
    const name = normalizeStringValue(req.body?.name);

    if (!threadId) {
      return res.status(400).json({
        ok: false,
        error: 'threadId is required.',
      });
    }

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: 'name is required.',
      });
    }

    await getThreadOrThrow(threadId, false);
    await nativeStore.renameThread(threadId, name);

    return respondSuccess(res, {
      threadId,
      name,
      workspace: await buildWorkspacePayload(getProjectPathFromRequest(req)),
    });
  })
);

app.post(
  '/api/threads/archive',
  asyncRoute(async (req, res) => {
    const threadId = getThreadIdFromRequest(req);

    if (!threadId) {
      return res.status(400).json({
        ok: false,
        error: 'threadId is required.',
      });
    }

    const liveSnapshot = getLiveSnapshot(threadId);

    if (liveSnapshot?.activeTurnId) {
      return res.status(409).json({
        ok: false,
        error: 'Interrupt the active turn before archiving this thread.',
      });
    }

    const thread = await getThreadOrThrow(threadId, false);
    await nativeStore.archiveThread(threadId);
    runtime.pendingThreads.delete(threadId);

    if (runtime.liveThreadId === threadId) {
      runtime.liveThreadId = null;
    }

    return respondSuccess(res, {
      threadId,
      archived: true,
      workspace: await buildWorkspacePayload(thread.cwd),
    });
  })
);

app.get(
  '/api/history',
  asyncRoute(async (req, res) => {
    const threadId = getThreadIdFromRequest(req);
    const thread = await getThreadOrThrow(threadId, true);
    const beforeMessageId = normalizeStringValue(req.query?.beforeMessageId);
    const limit = parseHistoryLimit(req.query?.limit);
    const page = paginateMessages(thread.messages, limit, beforeMessageId);

    return respondSuccess(res, {
      threadId,
      thread,
      messages: page.messages,
      pageInfo: {
        hasMore: page.hasMore,
        nextBeforeMessageId: page.nextBeforeMessageId,
        limit,
      },
    });
  })
);

app.get(
  '/api/live/events',
  asyncRoute(async (req, res) => {
    const threadId = normalizeStringValue(req.query?.threadId);

    if (!threadId) {
      return res.status(400).json({
        ok: false,
        error: 'threadId is required.',
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, no-transform');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const unsubscribe = liveRuntime.subscribe(threadId, (snapshot) => {
      writeSseEvent(res, 'snapshot', snapshot);
    });

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    writeSseEvent(res, 'snapshot', liveRuntime.getSnapshot(threadId));

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  })
);

app.post(
  '/api/chat',
  asyncRoute(async (req, res) => {
    const rawMessage = typeof req.body?.message === 'string' ? req.body.message : '';
    const message = sanitizePrompt(rawMessage, config.limits.maxPromptChars);
    const threadId = getThreadIdFromRequest(req);

    if (!message) {
      return res.status(400).json({
        ok: false,
        error: 'message is required.',
      });
    }

    const baselineThread = await getThreadOrThrow(threadId, false);
    const liveSnapshot = getLiveSnapshot(threadId);
    const messagePreview = buildMessagePreview(message);

    if (liveSnapshot?.pendingAction) {
      return res.status(409).json({
        ok: false,
        error: 'Codex is waiting for a decision before it can continue.',
      });
    }

    if (liveSnapshot?.activeTurnId) {
      await liveRuntime.steerTurn(threadId, message);

      return respondSuccess(
        res,
        {
          accepted: true,
          mode: 'steered',
          threadId,
          live: liveRuntime.getSnapshot(threadId),
          queue: queue.getState(),
        },
        202
      );
    }

    const queueStateBefore = queue.getState();
    liveRuntime.markQueued(threadId, message);

    queue
      .enqueue(async () => {
        try {
          runtime.liveThreadId = threadId;
          await liveRuntime.startTurnAndWait({
            threadId,
            cwd: baselineThread.cwd,
            message,
          });
          runtime.pendingThreads.delete(threadId);
          runtime.liveThreadId = liveRuntime.getActiveThreadId();
        } catch (error) {
          runtime.liveThreadId = null;
          runtime.pendingThreads.delete(threadId);
          liveRuntime.markError(threadId, error, messagePreview);
          throw error;
        }
      })
      .catch(() => {
        // Errors are surfaced through the live runtime state.
      });

    return respondSuccess(
      res,
      {
        accepted: true,
        mode: queueStateBefore.processing ? 'queued' : 'started',
        threadId,
        live: liveRuntime.getSnapshot(threadId),
        queue: queue.getState(),
      },
      202
    );
  })
);

app.post(
  '/api/live/approval',
  asyncRoute(async (req, res) => {
    const threadId = getThreadIdFromRequest(req);
    const action = normalizeStringValue(req.body?.action);

    if (!threadId) {
      return res.status(400).json({
        ok: false,
        error: 'threadId is required.',
      });
    }

    if (action !== 'approve' && action !== 'deny') {
      return res.status(400).json({
        ok: false,
        error: 'action must be approve or deny.',
      });
    }

    const pendingAction = liveRuntime.getPendingAction(threadId);

    if (pendingAction && pendingAction.kind === 'approval') {
      const live = await liveRuntime.answerApproval(threadId, action);

      return respondSuccess(res, {
        threadId,
        live,
      });
    }

    const interactivePrompt = await tmux.getInteractivePrompt();

    if (!interactivePrompt) {
      return res.status(409).json({
        ok: false,
        error: 'No approval request is waiting for input.',
      });
    }

    const result = await tmux.answerInteractivePrompt(action, interactivePrompt);

    return respondSuccess(res, {
      action,
      selectedOption: result.option,
      approval: await getApprovalState(),
    });
  })
);

app.post(
  '/api/live/input',
  asyncRoute(async (req, res) => {
    const threadId = getThreadIdFromRequest(req);
    const answers = req.body?.answers;

    if (!threadId) {
      return res.status(400).json({
        ok: false,
        error: 'threadId is required.',
      });
    }

    const live = await liveRuntime.submitUserInput(threadId, answers);

    return respondSuccess(res, {
      threadId,
      live,
    });
  })
);

app.post(
  '/api/live/terminal-input',
  asyncRoute(async (req, res) => {
    const threadId = getThreadIdFromRequest(req);
    const input = typeof req.body?.input === 'string' ? req.body.input : '';
    const closeStdin = normalizeBooleanValue(req.body?.closeStdin);

    if (!threadId) {
      return res.status(400).json({
        ok: false,
        error: 'threadId is required.',
      });
    }

    const pendingAction = liveRuntime.getPendingAction(threadId);

    if (!pendingAction || pendingAction.kind !== 'terminal_input') {
      return res.status(409).json({
        ok: false,
        error: 'No terminal input is waiting for a response.',
      });
    }

    const normalizedInput = closeStdin ? input : input.endsWith('\n') ? input : `${input}\n`;
    const live = await liveRuntime.submitTerminalInput(threadId, normalizedInput, closeStdin);

    return respondSuccess(res, {
      threadId,
      live,
    });
  })
);

app.post(
  '/api/live/interrupt',
  asyncRoute(async (req, res) => {
    const threadId = getThreadIdFromRequest(req);

    if (!threadId) {
      return res.status(400).json({
        ok: false,
        error: 'threadId is required.',
      });
    }

    const live = await liveRuntime.interruptTurn(threadId);

    return respondSuccess(res, {
      threadId,
      live,
    });
  })
);

app.post(
  '/api/clear',
  asyncRoute(async (req, res) => {
    queue.cancelPending(new Error('Queue cleared by reset request.'));

    if (liveRuntime.getActiveThreadId()) {
      try {
        await liveRuntime.interruptTurn(liveRuntime.getActiveThreadId());
      } catch (error) {
        console.warn(`[clear] Failed to interrupt active turn: ${error.message}`);
      }
    }

    await tmux.resetSession();
    runtime.liveThreadId = null;
    setActivity('idle', 'idle', {
      threadId: null,
      messagePreview: '',
    });

    const sessionState = await tmux.getSessionState();

    return respondSuccess(res, {
      cleared: true,
      queue: queue.getState(),
      codex: sessionState,
      liveThreadId: runtime.liveThreadId,
    });
  })
);

app.post(
  '/api/approval',
  asyncRoute(async (req, res) => {
    const action = normalizeStringValue(req.body?.action);

    if (action !== 'approve' && action !== 'deny') {
      return res.status(400).json({
        ok: false,
        error: 'action must be approve or deny.',
      });
    }

    const interactivePrompt = await tmux.getInteractivePrompt();

    if (!interactivePrompt) {
      return res.status(409).json({
        ok: false,
        error: 'No interactive Codex prompt is waiting for approval.',
      });
    }

    const result = await tmux.answerInteractivePrompt(action, interactivePrompt);

    if (runtime.activity.status === 'running') {
      setActivity('running', 'waiting_for_codex', {
        threadId: runtime.activity.threadId,
        messagePreview: runtime.activity.messagePreview,
      });
    }

    return respondSuccess(res, {
      action,
      selectedOption: result.option,
      approval: await getApprovalState(),
      activity: runtime.activity,
    });
  })
);

app.use('/api', (req, res) => {
  return res.status(404).json({
    ok: false,
    error: 'API route not found.',
  });
});

app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) {
    return next(error);
  }

  const statusCode = error.statusCode || 500;
  const clientMessage = statusCode >= 500 ? 'Internal server error.' : error.message || 'Request failed.';

  return res.status(statusCode).json({
    ok: false,
    error: clientMessage,
  });
});

async function main() {
  const issues = validateConfig();

  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }

  try {
    await Promise.all([tmux.ensureSession(), appServer.ensureStarted()]);
  } catch (error) {
    console.warn(`[startup] Failed to prepare Codex runtime: ${error.message}`);
  }

  app.listen(config.server.port, config.server.host, () => {
    console.log(
      `codex-remote listening on http://${config.server.host}:${config.server.port} using tmux session "${config.codex.sessionName}"`
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
