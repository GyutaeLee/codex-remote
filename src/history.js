const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function isoNow() {
  return new Date().toISOString();
}

function trimThreadTitle(value) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function deriveThreadTitle(messages) {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.content.trim());

  if (!firstUserMessage) {
    return 'New Thread';
  }

  const firstLine = firstUserMessage.content.split('\n')[0] || firstUserMessage.content;
  return trimThreadTitle(firstLine) || 'New Thread';
}

function createThreadRecord(title = 'New Thread', createdAt = isoNow(), messages = []) {
  return {
    id: crypto.randomUUID(),
    title: trimThreadTitle(title) || deriveThreadTitle(messages),
    createdAt,
    updatedAt: createdAt,
    messages,
  };
}

function createProjectRecord(projectId, projectName, rootDir) {
  const now = isoNow();
  const initialThread = createThreadRecord('New Thread', now, []);

  return {
    id: projectId,
    name: projectName,
    rootDir,
    createdAt: now,
    updatedAt: now,
    activeThreadId: initialThread.id,
    threads: {
      [initialThread.id]: initialThread,
    },
  };
}

function createDefaultState(projectId, projectName, rootDir) {
  return {
    version: 2,
    projects: {
      [projectId]: createProjectRecord(projectId, projectName, rootDir),
    },
  };
}

class HistoryStore {
  constructor(filePath, defaultProjectId, defaultProjectName, rootDir) {
    this.filePath = filePath;
    this.defaultProjectId = defaultProjectId;
    this.defaultProjectName = defaultProjectName;
    this.rootDir = rootDir;
    this.state = createDefaultState(defaultProjectId, defaultProjectName, rootDir);
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const fileContents = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(fileContents);
      this.state = this.normalizeState(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[history] Failed to read existing history file: ${error.message}`);
      }

      this.state = createDefaultState(this.defaultProjectId, this.defaultProjectName, this.rootDir);
      await this.persist();
      return;
    }

    await this.persist();
  }

  async getProject(projectId = this.defaultProjectId) {
    await this.writeChain;
    const project = this.ensureProject(projectId);
    return structuredClone(this.toProjectSummary(project));
  }

  async listThreads(projectId = this.defaultProjectId) {
    await this.writeChain;
    const project = this.ensureProject(projectId);
    return structuredClone(this.getThreadSummaries(project));
  }

  async getThread(projectId = this.defaultProjectId, threadId) {
    await this.writeChain;
    const project = this.ensureProject(projectId);
    const thread = project.threads[threadId];
    return thread ? structuredClone(thread) : null;
  }

  async getMessages(projectId = this.defaultProjectId, threadId) {
    await this.writeChain;
    const project = this.ensureProject(projectId);
    const resolvedThreadId = threadId || project.activeThreadId;
    const thread = project.threads[resolvedThreadId];
    return thread ? structuredClone(thread.messages) : null;
  }

  async getMessageCount(projectId = this.defaultProjectId, threadId) {
    await this.writeChain;
    const project = this.ensureProject(projectId);
    const resolvedThreadId = threadId || project.activeThreadId;
    const thread = project.threads[resolvedThreadId];
    return thread ? thread.messages.length : 0;
  }

  async getActiveThreadId(projectId = this.defaultProjectId) {
    await this.writeChain;
    return this.ensureProject(projectId).activeThreadId;
  }

  async setActiveThreadId(projectId = this.defaultProjectId, threadId) {
    return this.mutate(async (state) => {
      const project = this.ensureProject(projectId, state);

      if (!project.threads[threadId]) {
        throw new Error('Thread not found.');
      }

      project.activeThreadId = threadId;
      project.updatedAt = isoNow();
      return threadId;
    });
  }

  async createThread(projectId = this.defaultProjectId, title = 'New Thread') {
    return this.mutate(async (state) => {
      const project = this.ensureProject(projectId, state);
      const now = isoNow();
      const thread = createThreadRecord(title, now, []);

      project.threads[thread.id] = thread;
      project.activeThreadId = thread.id;
      project.updatedAt = now;

      return structuredClone(thread);
    });
  }

  async clearThread(projectId = this.defaultProjectId, threadId) {
    return this.mutate(async (state) => {
      const project = this.ensureProject(projectId, state);
      const thread = project.threads[threadId];

      if (!thread) {
        throw new Error('Thread not found.');
      }

      thread.title = 'New Thread';
      thread.messages = [];
      thread.updatedAt = isoNow();
      project.activeThreadId = thread.id;
      project.updatedAt = thread.updatedAt;

      return structuredClone(thread);
    });
  }

  async addMessage(projectId = this.defaultProjectId, threadId, role, content, extra = {}) {
    return this.mutate(async (state) => {
      const { project, thread } = this.getProjectAndThread(projectId, threadId, state);
      const message = this.createMessage(role, content, extra);

      if (role === 'user' && thread.messages.length === 0) {
        thread.title = deriveThreadTitle([message]);
      }

      thread.messages.push(message);
      thread.updatedAt = message.createdAt;
      project.activeThreadId = thread.id;
      project.updatedAt = thread.updatedAt;

      return structuredClone(message);
    });
  }

  async insertMessageAfter(projectId = this.defaultProjectId, threadId, afterMessageId, role, content, extra = {}) {
    return this.mutate(async (state) => {
      const { project, thread } = this.getProjectAndThread(projectId, threadId, state);
      const message = this.createMessage(role, content, extra);
      const index = thread.messages.findIndex((entry) => entry.id === afterMessageId);

      if (index === -1) {
        thread.messages.push(message);
      } else {
        thread.messages.splice(index + 1, 0, message);
      }

      thread.updatedAt = message.createdAt;
      project.activeThreadId = thread.id;
      project.updatedAt = thread.updatedAt;

      return structuredClone(message);
    });
  }

  createMessage(role, content, extra = {}) {
    return {
      id: crypto.randomUUID(),
      role,
      content,
      createdAt: isoNow(),
      ...extra,
    };
  }

  normalizeState(candidate) {
    if (candidate?.version === 2 && candidate.projects && typeof candidate.projects === 'object') {
      return this.normalizeProjectsState(candidate.projects);
    }

    if (candidate?.sessions && typeof candidate.sessions === 'object') {
      return this.migrateLegacySessions(candidate.sessions);
    }

    return createDefaultState(this.defaultProjectId, this.defaultProjectName, this.rootDir);
  }

  normalizeProjectsState(projects) {
    const state = {
      version: 2,
      projects: {},
    };

    for (const [projectId, projectValue] of Object.entries(projects)) {
      const now = isoNow();
      const threads = {};

      if (projectValue?.threads && typeof projectValue.threads === 'object') {
        for (const [threadId, threadValue] of Object.entries(projectValue.threads)) {
          const messages = Array.isArray(threadValue?.messages)
            ? threadValue.messages.filter((entry) => this.isValidMessage(entry))
            : [];

          const createdAt = typeof threadValue?.createdAt === 'string' ? threadValue.createdAt : now;
          const updatedAt =
            typeof threadValue?.updatedAt === 'string'
              ? threadValue.updatedAt
              : messages[messages.length - 1]?.createdAt || createdAt;

          threads[threadId] = {
            id: threadId,
            title: trimThreadTitle(threadValue?.title || deriveThreadTitle(messages)) || 'New Thread',
            createdAt,
            updatedAt,
            messages,
          };
        }
      }

      const normalizedProject = {
        id: projectId,
        name: typeof projectValue?.name === 'string' ? projectValue.name : this.defaultProjectName,
        rootDir: typeof projectValue?.rootDir === 'string' ? projectValue.rootDir : this.rootDir,
        createdAt: typeof projectValue?.createdAt === 'string' ? projectValue.createdAt : now,
        updatedAt: typeof projectValue?.updatedAt === 'string' ? projectValue.updatedAt : now,
        activeThreadId: typeof projectValue?.activeThreadId === 'string' ? projectValue.activeThreadId : null,
        threads,
      };

      state.projects[projectId] = normalizedProject;
      this.ensureProjectHasThread(normalizedProject);
    }

    if (!state.projects[this.defaultProjectId]) {
      state.projects[this.defaultProjectId] = createProjectRecord(
        this.defaultProjectId,
        this.defaultProjectName,
        this.rootDir
      );
    } else {
      this.ensureProjectHasThread(state.projects[this.defaultProjectId]);
    }

    return state;
  }

  migrateLegacySessions(sessions) {
    const legacySession = sessions.default || Object.values(sessions)[0] || { messages: [] };
    const messages = Array.isArray(legacySession.messages)
      ? legacySession.messages.filter((entry) => this.isValidMessage(entry))
      : [];
    const now = isoNow();
    const thread = createThreadRecord(deriveThreadTitle(messages), messages[0]?.createdAt || now, messages);
    thread.id = 'thread-default';
    thread.updatedAt = messages[messages.length - 1]?.createdAt || thread.createdAt;

    return {
      version: 2,
      projects: {
        [this.defaultProjectId]: {
          id: this.defaultProjectId,
          name: this.defaultProjectName,
          rootDir: this.rootDir,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          activeThreadId: thread.id,
          threads: {
            [thread.id]: thread,
          },
        },
      },
    };
  }

  isValidMessage(entry) {
    return (
      entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      typeof entry.role === 'string' &&
      typeof entry.content === 'string' &&
      typeof entry.createdAt === 'string'
    );
  }

  ensureProject(projectId, state = this.state) {
    if (!state.projects[projectId]) {
      state.projects[projectId] = createProjectRecord(projectId, this.defaultProjectName, this.rootDir);
    }

    this.ensureProjectHasThread(state.projects[projectId]);
    return state.projects[projectId];
  }

  ensureProjectHasThread(project) {
    const threadIds = Object.keys(project.threads || {});

    if (threadIds.length === 0) {
      const thread = createThreadRecord('New Thread');
      project.threads = {
        [thread.id]: thread,
      };
      project.activeThreadId = thread.id;
      project.updatedAt = thread.updatedAt;
      return;
    }

    if (!project.activeThreadId || !project.threads[project.activeThreadId]) {
      const [firstThreadId] = this.getSortedThreadIds(project);
      project.activeThreadId = firstThreadId;
    }
  }

  getProjectAndThread(projectId, threadId, state = this.state) {
    const project = this.ensureProject(projectId, state);
    const resolvedThreadId = threadId || project.activeThreadId;
    const thread = project.threads[resolvedThreadId];

    if (!thread) {
      throw new Error('Thread not found.');
    }

    return {
      project,
      thread,
    };
  }

  getThreadSummaries(project) {
    return this.getSortedThreadIds(project).map((threadId) => this.toThreadSummary(project.threads[threadId], project.activeThreadId));
  }

  getSortedThreadIds(project) {
    return Object.values(project.threads)
      .sort((left, right) => {
        if (left.updatedAt === right.updatedAt) {
          return left.createdAt < right.createdAt ? 1 : -1;
        }

        return left.updatedAt < right.updatedAt ? 1 : -1;
      })
      .map((thread) => thread.id);
  }

  toProjectSummary(project) {
    return {
      id: project.id,
      name: project.name,
      rootDir: project.rootDir,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      activeThreadId: project.activeThreadId,
      threadCount: Object.keys(project.threads).length,
    };
  }

  toThreadSummary(thread, activeThreadId) {
    const lastMessage = thread.messages[thread.messages.length - 1] || null;

    return {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messageCount: thread.messages.length,
      preview: lastMessage ? lastMessage.content.slice(0, 120) : '',
      lastRole: lastMessage?.role || null,
      isActive: thread.id === activeThreadId,
    };
  }

  async mutate(mutator) {
    const task = this.writeChain.then(async () => {
      const result = await mutator(this.state);
      await this.persist();
      return result;
    });

    this.writeChain = task.catch(() => {});
    return task;
  }

  async persist() {
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }
}

module.exports = {
  HistoryStore,
};
