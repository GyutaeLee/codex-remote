const fs = require('fs/promises');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');

function unixSecondsToIso(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function deriveTitleFromPreview(preview) {
  const firstLine = String(preview || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return (firstLine || 'New Thread').slice(0, 120);
}

function extractUserMessageText(content) {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part?.text === 'string') {
        return part.text;
      }

      return '';
    })
    .join('\n')
    .trim();
}

function extractDisplayUserMessage(rawText) {
  const raw = String(rawText || '').trim();
  const jsonPrefix = 'User request as a JSON string: ';

  if (raw.startsWith('Remote bridge request id ') && raw.includes(jsonPrefix)) {
    let jsonValue = raw.slice(raw.indexOf(jsonPrefix) + jsonPrefix.length).trim();

    if (jsonValue.endsWith('.')) {
      jsonValue = jsonValue.slice(0, -1);
    }

    try {
      return JSON.parse(jsonValue);
    } catch (error) {
      return raw;
    }
  }

  if (raw.startsWith('Remote bridge request id ') && raw.includes('User request:\n')) {
    return raw.slice(raw.lastIndexOf('User request:\n') + 'User request:\n'.length).trim();
  }

  return raw;
}

function extractDisplayAssistantMessage(rawText) {
  const raw = String(rawText || '').trim();
  const markerMatch = raw.match(
    /\[\[CODEX_REMOTE_START:[^\]]+\]\]\s*([\s\S]*?)\s*\[\[CODEX_REMOTE_END:[^\]]+\]\]/m
  );

  if (markerMatch) {
    return markerMatch[1].trim();
  }

  return raw;
}

function appendMergedMessage(messages, nextMessage) {
  const content = String(nextMessage?.content || '').trim();

  if (!content) {
    return;
  }

  const previousMessage = messages[messages.length - 1];

  if (previousMessage && previousMessage.role === nextMessage.role) {
    previousMessage.content = `${previousMessage.content}\n\n${content}`.trim();
    previousMessage.id = nextMessage.id;
    return;
  }

  messages.push({
    id: nextMessage.id,
    role: nextMessage.role,
    content,
  });
}

async function directoryExists(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return false;
  }

  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[codex-native] Failed to stat path ${targetPath}: ${error.message}`);
    }

    return false;
  }
}

class NativeCodexStore {
  constructor(config, appServer) {
    this.config = config;
    this.appServer = appServer;
    this.threadTitleOverrides = new Map();

    this.appServer.on('notification', (payload) => {
      this.handleNotification(payload);
    });
  }

  async getWorkspaceSnapshot(projectPath) {
    const [globalState, titleIndex, allThreads] = await Promise.all([
      this.readGlobalState(),
      this.readSessionIndex(),
      this.appServer.listThreads(),
    ]);
    const pinnedThreadIds = this.readPinnedThreadIds(globalState);

    const projects = await this.buildProjects(globalState, allThreads);
    const existingProjectPaths = new Set(projects.map((project) => project.path));
    const selectedProject = this.resolveProject(projects, projectPath);
    const threads = selectedProject
      ? this.decorateThreadsForProject(selectedProject.path, allThreads, titleIndex, pinnedThreadIds)
      : [];
    const pinnedThreads = this.decoratePinnedThreads(
      pinnedThreadIds,
      allThreads,
      titleIndex,
      existingProjectPaths
    );

    return {
      projects,
      selectedProject,
      threads,
      pinnedThreads,
    };
  }

  async getThread(threadId, includeTurns = true) {
    const titleIndex = await this.readSessionIndex();

    try {
      const thread = await this.appServer.readThread(threadId, includeTurns);
      return this.decorateThread(thread, titleIndex, includeTurns);
    } catch (error) {
      if (includeTurns && /not materialized yet/i.test(error.message)) {
        const thread = await this.appServer.readThread(threadId, false);
        return this.decorateThread(thread, titleIndex, false);
      }

      throw error;
    }
  }

  async createThread(projectPath) {
    const [titleIndex, thread] = await Promise.all([
      this.readSessionIndex(),
      this.appServer.startThread(projectPath),
    ]);

    return this.toThreadSummary(thread, titleIndex);
  }

  async renameThread(threadId, name) {
    await this.appServer.setThreadName(threadId, name);
    this.threadTitleOverrides.set(threadId, name);

    return {
      threadId,
      name,
    };
  }

  async archiveThread(threadId) {
    await this.appServer.archiveThread(threadId);
  }

  async listMaterializedThreads(projectPath) {
    const [titleIndex, allThreads] = await Promise.all([this.readSessionIndex(), this.appServer.listThreads()]);
    return this.decorateThreadsForProject(projectPath, allThreads, titleIndex);
  }

  async waitForMaterializedThread(projectPath, previousThreadIds, previousLatestUpdatedAt, previewHint) {
    const deadline = Date.now() + this.config.codex.threadSyncTimeoutMs;
    const normalizedHint = String(previewHint || '')
      .split('\n')[0]
      .trim()
      .slice(0, 80);

    while (Date.now() < deadline) {
      const threads = await this.listMaterializedThreads(projectPath);
      const newThread = threads.find((thread) => !previousThreadIds.has(thread.id));

      if (newThread) {
        return this.getThread(newThread.id, true);
      }

      const updatedThread = threads.find((thread) => {
        if ((thread.updatedAtUnix || 0) <= previousLatestUpdatedAt) {
          return false;
        }

        if (!normalizedHint) {
          return true;
        }

        return String(thread.preview || '').includes(normalizedHint);
      });

      if (updatedThread) {
        return this.getThread(updatedThread.id, true);
      }

      await delay(this.config.codex.threadSyncPollMs);
    }

    return null;
  }

  async waitForThreadUpdate(threadId, previousThread) {
    const previousUpdatedAt = previousThread?.updatedAtUnix || 0;
    const previousMessageCount = this.threadToMessages(previousThread).length;
    const deadline = Date.now() + this.config.codex.threadSyncTimeoutMs;
    let latestThread = previousThread;

    while (Date.now() < deadline) {
      latestThread = await this.getThread(threadId, true);

      if (
        (latestThread.updatedAtUnix || 0) > previousUpdatedAt ||
        this.threadToMessages(latestThread).length > previousMessageCount
      ) {
        return latestThread;
      }

      await delay(this.config.codex.threadSyncPollMs);
    }

    return latestThread || previousThread;
  }

  readPinnedThreadIds(globalState) {
    return Array.isArray(globalState['pinned-thread-ids'])
      ? globalState['pinned-thread-ids'].filter((id) => typeof id === 'string' && id.trim())
      : [];
  }

  async buildProjects(globalState, allThreads) {
    const savedRoots = Array.isArray(globalState['electron-saved-workspace-roots'])
      ? globalState['electron-saved-workspace-roots'].filter((entry) => typeof entry === 'string' && entry.trim())
      : [];
    const activeRoots = new Set(
      Array.isArray(globalState['active-workspace-roots'])
        ? globalState['active-workspace-roots'].filter((entry) => typeof entry === 'string' && entry.trim())
        : []
    );
    const threadCounts = new Map();

    for (const thread of allThreads) {
      const cwd = typeof thread?.cwd === 'string' ? thread.cwd : '';

      if (!cwd) {
        continue;
      }

      threadCounts.set(cwd, (threadCounts.get(cwd) || 0) + 1);
    }

    const projectPaths = [];
    const seen = new Set();

    for (const projectPath of savedRoots) {
      if (!seen.has(projectPath)) {
        seen.add(projectPath);
        projectPaths.push(projectPath);
      }
    }

    for (const thread of allThreads) {
      if (typeof thread?.cwd !== 'string' || !thread.cwd || seen.has(thread.cwd)) {
        continue;
      }

      seen.add(thread.cwd);
      projectPaths.push(thread.cwd);
    }

    const existingProjectPaths = (
      await Promise.all(
        projectPaths.map(async (projectPath) => ((await directoryExists(projectPath)) ? projectPath : null))
      )
    ).filter(Boolean);

    return existingProjectPaths
      .map((projectPath) => ({
        id: projectPath,
        path: projectPath,
        name: path.basename(projectPath) || projectPath,
        isRegistered: savedRoots.includes(projectPath),
        isActiveWorkspace: activeRoots.has(projectPath),
        threadCount: threadCounts.get(projectPath) || 0,
      }))
      .sort((left, right) => {
        if (left.isActiveWorkspace !== right.isActiveWorkspace) {
          return left.isActiveWorkspace ? -1 : 1;
        }

        if (left.isRegistered !== right.isRegistered) {
          return left.isRegistered ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });
  }

  resolveProject(projects, requestedPath) {
    if (requestedPath) {
      const exact = projects.find((project) => project.path === requestedPath);

      if (exact) {
        return exact;
      }
    }

    return projects.find((project) => project.isActiveWorkspace) || projects[0] || null;
  }

  decorateThreadsForProject(projectPath, allThreads, titleIndex, pinnedThreadIds = []) {
    const pinnedThreadIdSet = new Set(pinnedThreadIds);

    return allThreads
      .filter((thread) => thread.cwd === projectPath)
      .sort((left, right) => {
        const leftPinned = pinnedThreadIdSet.has(left.id);
        const rightPinned = pinnedThreadIdSet.has(right.id);

        if (leftPinned !== rightPinned) {
          return leftPinned ? -1 : 1;
        }

        if (left.updatedAt === right.updatedAt) {
          return String(left.id).localeCompare(String(right.id)) * -1;
        }

        return (right.updatedAt || 0) - (left.updatedAt || 0);
      })
      .map((thread) => this.toThreadSummary(thread, titleIndex, pinnedThreadIdSet));
  }

  decoratePinnedThreads(pinnedThreadIds, allThreads, titleIndex, existingProjectPaths) {
    const pinnedThreadIdSet = new Set(pinnedThreadIds);
    const threadById = new Map(allThreads.map((thread) => [thread.id, thread]));

    return pinnedThreadIds
      .map((threadId) => threadById.get(threadId))
      .filter((thread) => thread && existingProjectPaths.has(thread.cwd))
      .map((thread) => this.toThreadSummary(thread, titleIndex, pinnedThreadIdSet));
  }

  decorateThread(thread, titleIndex, includeTurns) {
    return {
      id: thread.id,
      title: this.resolveThreadTitle(thread, titleIndex),
      preview: thread.preview || '',
      path: thread.path || null,
      cwd: thread.cwd,
      source: thread.source,
      createdAt: unixSecondsToIso(thread.createdAt),
      updatedAt: unixSecondsToIso(thread.updatedAt),
      createdAtUnix: thread.createdAt,
      updatedAtUnix: thread.updatedAt,
      modelProvider: thread.modelProvider,
      cliVersion: thread.cliVersion,
      turns: includeTurns ? thread.turns || [] : [],
      messages: includeTurns ? this.threadToMessages(thread) : [],
    };
  }

  toThreadSummary(thread, titleIndex, pinnedThreadIdSet = new Set()) {
    return {
      id: thread.id,
      title: this.resolveThreadTitle(thread, titleIndex),
      preview: thread.preview || '',
      cwd: thread.cwd,
      source: thread.source,
      createdAt: unixSecondsToIso(thread.createdAt),
      updatedAt: unixSecondsToIso(thread.updatedAt),
      createdAtUnix: thread.createdAt,
      updatedAtUnix: thread.updatedAt,
      isPinned: pinnedThreadIdSet.has(thread.id),
    };
  }

  threadToMessages(thread) {
    if (!thread || !Array.isArray(thread.turns)) {
      return [];
    }

    const messages = [];

    for (const turn of thread.turns) {
      for (const item of turn.items || []) {
        if (item?.type === 'userMessage') {
          const content = extractDisplayUserMessage(extractUserMessageText(item.content));

          if (content) {
            appendMergedMessage(messages, {
              id: item.id,
              role: 'user',
              content,
            });
          }
        }

        if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
          const content = extractDisplayAssistantMessage(item.text);

          if (!content) {
            continue;
          }

          appendMergedMessage(messages, {
            id: item.id,
            role: 'assistant',
            content,
          });
        }
      }
    }

    return messages;
  }

  resolveThreadTitle(thread, titleIndex) {
    const override = this.threadTitleOverrides.get(thread.id);

    if (typeof override === 'string' && override.trim()) {
      return override.trim();
    }

    return titleIndex.get(thread.id) || deriveTitleFromPreview(thread.preview);
  }

  handleNotification(payload) {
    if (!payload || typeof payload !== 'object' || !payload.method || !payload.params) {
      return;
    }

    if (payload.method === 'thread/name/updated') {
      const threadId = typeof payload.params.threadId === 'string' ? payload.params.threadId : '';
      const threadName = typeof payload.params.threadName === 'string' ? payload.params.threadName.trim() : '';

      if (!threadId) {
        return;
      }

      if (threadName) {
        this.threadTitleOverrides.set(threadId, threadName);
        return;
      }

      this.threadTitleOverrides.delete(threadId);
    }
  }

  async readGlobalState() {
    try {
      const raw = await fs.readFile(this.config.codex.globalStatePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[codex-native] Failed to read global state: ${error.message}`);
      }

      return {};
    }
  }

  async readSessionIndex() {
    try {
      const raw = await fs.readFile(this.config.codex.sessionIndexPath, 'utf8');
      const titleIndex = new Map();

      for (const line of raw.split('\n')) {
        const trimmed = line.trim();

        if (!trimmed) {
          continue;
        }

        try {
          const entry = JSON.parse(trimmed);

          if (typeof entry?.id === 'string' && typeof entry?.thread_name === 'string' && entry.thread_name.trim()) {
            titleIndex.set(entry.id, entry.thread_name.trim());
          }
        } catch (error) {
          continue;
        }
      }

      return titleIndex;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[codex-native] Failed to read session index: ${error.message}`);
      }

      return new Map();
    }
  }
}

module.exports = {
  NativeCodexStore,
};
