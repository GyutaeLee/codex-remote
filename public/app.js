const PROJECT_KEY = 'codex_remote_selected_project';
const THREAD_KEY = 'codex_remote_selected_thread';
const HISTORY_PAGE_SIZE = 5;

function createEmptyApprovalState() {
  return {
    pending: false,
    kind: null,
    prompt: '',
    options: [],
    canApprove: false,
    canDeny: false,
    updatedAt: null,
    submittingAction: '',
  };
}

function createEmptyLiveState(threadId = '') {
  return {
    threadId,
    version: 0,
    activeTurnId: null,
    queueCount: 0,
    activity: {
      status: 'idle',
      phase: 'idle',
      threadId: threadId || null,
      turnId: null,
      messagePreview: '',
      updatedAt: null,
    },
    pendingAction: null,
    stream: {
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
    },
    events: [],
    updatedAt: null,
  };
}

const state = {
  token: '',
  selectedProjectPath: localStorage.getItem(PROJECT_KEY) || '',
  selectedThreadId: localStorage.getItem(THREAD_KEY) || '',
  sending: false,
  eventSource: null,
  workspacePollId: null,
  healthPollId: null,
  projects: [],
  pinnedThreads: [],
  threads: [],
  menuProjectThreads: {},
  menuExpandedProjects: {},
  menuLoadingProjectPath: '',
  selectedProject: null,
  liveThreadId: null,
  historyMessages: [],
  historyHasMore: false,
  historyNextBeforeMessageId: '',
  historyLoading: false,
  shouldStickToBottom: true,
  activeDrawer: '',
  activity: {
    status: 'idle',
    phase: 'idle',
    threadId: null,
    messagePreview: '',
    updatedAt: null,
  },
  approval: createEmptyApprovalState(),
  live: createEmptyLiveState(),
  approvalSubmittingAction: '',
  userInputSubmitting: false,
  terminalInputSubmitting: '',
};

const elements = {
  authOverlay: document.getElementById('authOverlay'),
  authForm: document.getElementById('authForm'),
  authError: document.getElementById('authError'),
  tokenInput: document.getElementById('tokenInput'),
  openProjectsButton: document.getElementById('openProjectsButton'),
  openThreadsButton: document.getElementById('openThreadsButton'),
  openMenuButton: document.getElementById('openMenuButton'),
  menuNewThreadButton: document.getElementById('menuNewThreadButton'),
  menuSearchInput: document.getElementById('menuSearchInput'),
  menuCurrentProject: document.getElementById('menuCurrentProject'),
  menuCurrentThread: document.getElementById('menuCurrentThread'),
  menuPinnedThreadsSection: document.getElementById('menuPinnedThreadsSection'),
  menuPinnedThreadsList: document.getElementById('menuPinnedThreadsList'),
  menuProjectSections: document.getElementById('menuProjectSections'),
  mobileTitle: document.getElementById('mobileTitle'),
  mobileSubtitle: document.getElementById('mobileSubtitle'),
  closeProjectsButton: document.getElementById('closeProjectsButton'),
  closeThreadsButton: document.getElementById('closeThreadsButton'),
  closeMenuButton: document.getElementById('closeMenuButton'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  projectDrawer: document.getElementById('projectDrawer'),
  threadDrawer: document.getElementById('threadDrawer'),
  menuDrawer: document.getElementById('menuDrawer'),
  serverStatus: document.getElementById('serverStatus'),
  codexStatus: document.getElementById('codexStatus'),
  queueStatus: document.getElementById('queueStatus'),
  pinnedStrip: document.getElementById('pinnedStrip'),
  pinnedList: document.getElementById('pinnedList'),
  workspaceSummary: document.getElementById('workspaceSummary'),
  projectList: document.getElementById('projectList'),
  projectName: document.getElementById('projectName'),
  projectPath: document.getElementById('projectPath'),
  threadTitle: document.getElementById('threadTitle'),
  threadState: document.getElementById('threadState'),
  threadList: document.getElementById('threadList'),
  newThreadButton: document.getElementById('newThreadButton'),
  resetButton: document.getElementById('resetButton'),
  logoutButton: document.getElementById('logoutButton'),
  errorBanner: document.getElementById('errorBanner'),
  livePanel: document.getElementById('livePanel'),
  liveLabel: document.getElementById('liveLabel'),
  liveStatus: document.getElementById('liveStatus'),
  interruptButton: document.getElementById('interruptButton'),
  liveAssistantBlock: document.getElementById('liveAssistantBlock'),
  liveAssistantText: document.getElementById('liveAssistantText'),
  livePlanBlock: document.getElementById('livePlanBlock'),
  livePlanText: document.getElementById('livePlanText'),
  liveCommandBlock: document.getElementById('liveCommandBlock'),
  liveCommandText: document.getElementById('liveCommandText'),
  liveEventList: document.getElementById('liveEventList'),
  refreshHistoryButton: document.getElementById('refreshHistoryButton'),
  loadMoreButton: document.getElementById('loadMoreButton'),
  loadingIndicator: document.getElementById('loadingIndicator'),
  loadingLabel: document.getElementById('loadingLabel'),
  loadingMeta: document.getElementById('loadingMeta'),
  approvalBanner: document.getElementById('approvalBanner'),
  approvalLabel: document.getElementById('approvalLabel'),
  approvalPrompt: document.getElementById('approvalPrompt'),
  approvalOptions: document.getElementById('approvalOptions'),
  approveButton: document.getElementById('approveButton'),
  denyButton: document.getElementById('denyButton'),
  userInputBanner: document.getElementById('userInputBanner'),
  userInputLabel: document.getElementById('userInputLabel'),
  userInputPrompt: document.getElementById('userInputPrompt'),
  userInputForm: document.getElementById('userInputForm'),
  userInputQuestions: document.getElementById('userInputQuestions'),
  userInputSubmitButton: document.getElementById('userInputSubmitButton'),
  terminalInputBanner: document.getElementById('terminalInputBanner'),
  terminalInputLabel: document.getElementById('terminalInputLabel'),
  terminalInputPrompt: document.getElementById('terminalInputPrompt'),
  terminalInputForm: document.getElementById('terminalInputForm'),
  terminalInputField: document.getElementById('terminalInputField'),
  terminalInputSubmitButton: document.getElementById('terminalInputSubmitButton'),
  terminalInputCloseButton: document.getElementById('terminalInputCloseButton'),
  messageList: document.getElementById('messageList'),
  emptyState: document.getElementById('emptyState'),
  promptInput: document.getElementById('promptInput'),
  sendButton: document.getElementById('sendButton'),
};

function showElement(element, show) {
  element.classList.toggle('hidden', !show);
}

function setStatus(element, text, kind) {
  element.textContent = text;
  element.classList.remove('ok', 'error');

  if (kind) {
    element.classList.add(kind);
  }
}

function showError(message) {
  elements.errorBanner.textContent = message;
  showElement(elements.errorBanner, Boolean(message));
}

function showAuthError(message) {
  elements.authError.textContent = message;
  showElement(elements.authError, Boolean(message));
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 720px)').matches;
}

function isMobileMenuStackActive() {
  return isMobileLayout() && ['menu', 'projects', 'threads'].includes(state.activeDrawer);
}

function setActiveDrawer(nextDrawer) {
  state.activeDrawer = state.activeDrawer === nextDrawer ? '' : nextDrawer;
  renderDrawerState();
}

function closeDrawers() {
  state.activeDrawer = '';
  renderDrawerState();
}

function renderDrawerState() {
  const mobile = isMobileLayout();

  showElement(elements.projectDrawer, mobile ? state.activeDrawer === 'projects' : true);
  showElement(elements.threadDrawer, mobile ? state.activeDrawer === 'threads' : true);
  showElement(elements.menuDrawer, state.activeDrawer === 'menu');
  showElement(elements.drawerBackdrop, mobile && Boolean(state.activeDrawer));

  elements.openProjectsButton.classList.toggle('active-toggle', state.activeDrawer === 'projects');
  elements.openThreadsButton.classList.toggle('active-toggle', state.activeDrawer === 'threads');
  elements.openMenuButton.classList.toggle('active-toggle', mobile ? isMobileMenuStackActive() : state.activeDrawer === 'menu');
  elements.closeProjectsButton.textContent = mobile ? '이전' : '닫기';
  elements.closeThreadsButton.textContent = mobile ? '이전' : '닫기';
  showElement(elements.closeMenuButton, !mobile);
}

function toggleMenuRoot() {
  if (isMobileMenuStackActive()) {
    closeDrawers();
    return;
  }

  setActiveDrawer('menu');
}

function stepBackFromNestedDrawer() {
  if (isMobileLayout()) {
    state.activeDrawer = 'menu';
    renderDrawerState();
    return;
  }

  closeDrawers();
}

function renderMobileTitle() {
  const thread = getSelectedThread();
  const project = state.selectedProject;

  elements.mobileTitle.textContent = thread?.title || project?.name || 'Codex 원격';
  elements.mobileSubtitle.textContent = thread ? '스레드' : project ? '프로젝트' : 'macOS 원격 브리지';
}

function getSelectedThread() {
  return state.threads.find((thread) => thread.id === state.selectedThreadId) || null;
}

function renderMenuPanel() {
  const project = state.selectedProject;
  const thread = getSelectedThread();
  const filter = String(elements.menuSearchInput?.value || '')
    .trim()
    .toLowerCase();
  const visiblePinnedThreads = state.pinnedThreads.filter((threadItem) => {
    if (!filter) {
      return true;
    }

    return [threadItem.title, threadItem.preview, threadItem.cwd]
      .some((value) => String(value || '').toLowerCase().includes(filter));
  });

  elements.menuCurrentProject.textContent = project
    ? `${project.name} · ${project.threadCount}개 스레드`
    : '선택된 워크스페이스가 없습니다.';
  elements.menuCurrentThread.textContent = thread?.title || '선택된 스레드가 없습니다.';

  elements.menuNewThreadButton.disabled = state.sending || !state.selectedProjectPath;
  elements.menuPinnedThreadsList.innerHTML = '';
  elements.menuProjectSections.innerHTML = '';
  showElement(elements.menuPinnedThreadsSection, visiblePinnedThreads.length > 0);

  visiblePinnedThreads.forEach((threadItem) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu-thread-button ${threadItem.id === state.selectedThreadId ? 'selected' : ''}`;
    button.dataset.threadId = threadItem.id;
    button.dataset.projectPath = threadItem.cwd || '';
    button.disabled = state.sending;

    const title = document.createElement('span');
    title.className = 'menu-project-title';
    title.textContent = threadItem.title || '고정 스레드';

    const meta = document.createElement('span');
    meta.className = 'menu-project-meta';
    meta.textContent = threadItem.updatedAt ? formatTimestamp(threadItem.updatedAt) : '고정';

    button.append(title, meta);
    elements.menuPinnedThreadsList.appendChild(button);
  });

  const visibleProjects = state.projects.filter((projectItem) => {
    if (!filter) {
      return true;
    }

    const projectMatch = [projectItem.name, projectItem.path]
      .some((value) => String(value || '').toLowerCase().includes(filter));

    if (projectMatch) {
      return true;
    }

    const cachedThreads = state.menuProjectThreads[projectItem.path] || [];
    return cachedThreads.some((threadItem) =>
      [threadItem.title, threadItem.preview].some((value) => String(value || '').toLowerCase().includes(filter))
    );
  });

  if (visibleProjects.length === 0 && visiblePinnedThreads.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = filter ? '검색 결과가 없습니다.' : '표시할 프로젝트가 없습니다.';
    elements.menuProjectSections.appendChild(empty);
    return;
  }

  visibleProjects.forEach((projectItem) => {
    const section = document.createElement('section');
    section.className = 'menu-project-group';

    const expanded = Boolean(state.menuExpandedProjects[projectItem.path]);
    const cachedThreads = state.menuProjectThreads[projectItem.path] || [];
    const visibleThreads = cachedThreads.filter((threadItem) =>
      !filter || [threadItem.title, threadItem.preview].some((value) => String(value || '').toLowerCase().includes(filter))
    );

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `menu-project-toggle ${projectItem.path === state.selectedProjectPath ? 'selected' : ''}`;
    toggle.dataset.projectPath = projectItem.path;
    toggle.disabled = state.sending;

    const lead = document.createElement('span');
    lead.className = 'menu-project-toggle-main';

    const arrow = document.createElement('span');
    arrow.className = 'menu-project-arrow';
    arrow.textContent = expanded ? '▾' : '▸';

    const title = document.createElement('span');
    title.className = 'menu-project-title';
    title.textContent = projectItem.name;

    lead.append(arrow, title);

    const meta = document.createElement('span');
    meta.className = 'menu-project-meta';
    meta.textContent = `${projectItem.threadCount}개`;

    toggle.append(lead, meta);
    section.appendChild(toggle);

    if (expanded) {
      const body = document.createElement('div');
      body.className = 'menu-project-body';

      if (state.menuLoadingProjectPath === projectItem.path) {
        const loading = document.createElement('div');
        loading.className = 'menu-empty';
        loading.textContent = '스레드를 불러오는 중...';
        body.appendChild(loading);
      } else if (visibleThreads.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'menu-empty';
        empty.textContent = filter ? '일치하는 스레드가 없습니다.' : '최근 스레드가 없습니다.';
        body.appendChild(empty);
      } else {
        visibleThreads.forEach((threadItem) => {
          const threadButton = document.createElement('button');
          threadButton.type = 'button';
          threadButton.className = `menu-thread-button ${threadItem.id === state.selectedThreadId ? 'selected' : ''}`;
          threadButton.dataset.threadId = threadItem.id;
          threadButton.dataset.projectPath = projectItem.path;
          threadButton.disabled = state.sending;

          const threadTitle = document.createElement('span');
          threadTitle.className = 'menu-project-title';
          threadTitle.textContent = threadItem.title || '새 스레드';

          const threadMeta = document.createElement('span');
          threadMeta.className = 'menu-project-meta';
          threadMeta.textContent = threadItem.updatedAt ? formatTimestamp(threadItem.updatedAt) : '';

          threadButton.append(threadTitle, threadMeta);
          body.appendChild(threadButton);
        });
      }

      section.appendChild(body);
    }

    elements.menuProjectSections.appendChild(section);
  });
}

function setSelectedProject(projectPath, persist = true) {
  state.selectedProjectPath = projectPath || '';

  if (persist && projectPath) {
    localStorage.setItem(PROJECT_KEY, projectPath);
  }

  if (!projectPath) {
    localStorage.removeItem(PROJECT_KEY);
  }
}

function setSelectedThread(threadId, persist = true) {
  state.selectedThreadId = threadId || '';
  state.historyMessages = [];
  state.historyHasMore = false;
  state.historyNextBeforeMessageId = '';
  state.shouldStickToBottom = true;
  state.live = createEmptyLiveState(state.selectedThreadId);
  state.approvalSubmittingAction = '';
  state.userInputSubmitting = false;
  state.terminalInputSubmitting = '';

  if (persist && threadId) {
    localStorage.setItem(THREAD_KEY, threadId);
  }

  if (!threadId) {
    localStorage.removeItem(THREAD_KEY);
  }

  renderPinnedThreads();
  renderProjects();
  renderThreads();
  renderThreadHeader();
  renderHistoryControls();
  renderLoadingIndicator();
  renderLivePanel();
  renderApprovalBanner();
  renderUserInputBanner();
  renderTerminalInputBanner();
  renderMobileTitle();
  renderMenuPanel();
  openLiveStream();
}

function setSending(sending) {
  state.sending = sending;
  elements.sendButton.disabled = sending || !elements.promptInput.value.trim() || !state.selectedThreadId;
  elements.promptInput.disabled = sending;
  elements.newThreadButton.disabled = sending || !state.selectedProjectPath;
  elements.resetButton.disabled = sending;
  renderProjects();
  renderPinnedThreads();
  renderThreads();
  renderLoadingIndicator();
  renderMenuPanel();
}

function setHistoryLoading(loading) {
  state.historyLoading = loading;
  elements.loadMoreButton.disabled = loading || state.sending;
  elements.refreshHistoryButton.disabled = loading || state.sending || !state.selectedThreadId;
}

function autosizeTextarea() {
  elements.promptInput.style.height = 'auto';
  elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 220)}px`;
  elements.sendButton.disabled = state.sending || !elements.promptInput.value.trim() || !state.selectedThreadId;
}

function updateViewportLayout() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
}

function keepPromptVisible() {
  if (!isMobileLayout()) {
    return;
  }

  requestAnimationFrame(() => {
    elements.promptInput.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const lastMessage = elements.messageList.lastElementChild;

    if (lastMessage) {
      lastMessage.scrollIntoView({ block: 'end', inline: 'nearest' });
    }
  });
}

async function api(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});

  headers.set('Accept', 'application/json');

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (state.token) {
    headers.set('Authorization', `Bearer ${state.token}`);
  }

  const response = await fetch(endpoint, {
    ...options,
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (response.status === 401) {
    logout();
    throw new Error(payload?.error || '인증되지 않았습니다.');
  }

  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error || '요청에 실패했습니다.');
    error.payload = payload?.data || null;
    throw error;
  }

  return payload.data;
}

function closeLiveStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function hasLiveContent(liveState) {
  return Boolean(
    liveState?.activeTurnId ||
      liveState?.queueCount ||
      liveState?.pendingAction ||
      liveState?.stream?.assistant?.content ||
      liveState?.stream?.plan?.text ||
      liveState?.stream?.plan?.explanation ||
      liveState?.stream?.command?.output ||
      (liveState?.events || []).length > 0
  );
}

function getConversationMessages() {
  const messages = [...state.historyMessages];
  const draftContent = String(state.live?.stream?.assistant?.content || '').trim();

  if (!draftContent) {
    return messages;
  }

  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');

  if (lastAssistantMessage?.content?.trim() === draftContent) {
    return messages;
  }

  messages.push({
    id: `live-draft-${state.selectedThreadId || 'current'}`,
    role: 'assistant',
    content: draftContent,
    createdAt: state.live?.updatedAt || new Date().toISOString(),
    transient: true,
  });

  return messages;
}

function renderConversation(options = {}, emptyText = '첫 메시지를 보내면 여기에 대화가 표시됩니다.') {
  renderMessages(getConversationMessages(), emptyText, options);
}

function isNearMessageListBottom(threshold = 48) {
  const remaining =
    elements.messageList.scrollHeight - elements.messageList.clientHeight - elements.messageList.scrollTop;

  return remaining <= threshold;
}

function refreshHistoryAndWorkspaceSoon() {
  refreshHistory().catch(() => {});
  refreshWorkspace().catch(() => {});
  refreshHealth().catch(() => {});
}

function applyLiveSnapshot(snapshot) {
  const previousLive = state.live || createEmptyLiveState();
  state.live = snapshot || createEmptyLiveState(state.selectedThreadId);

  if (!state.live.threadId) {
    state.live.threadId = state.selectedThreadId || '';
  }

  renderConversation({ stickToBottom: state.shouldStickToBottom });
  renderLivePanel();
  renderLoadingIndicator();
  renderApprovalBanner();
  renderUserInputBanner();
  renderTerminalInputBanner();

  const previousPhase = previousLive.activity?.phase || 'idle';
  const nextPhase = state.live.activity?.phase || 'idle';
  const wasActive = Boolean(previousLive.activeTurnId || previousPhase === 'running');
  const isTerminalPhase = ['completed', 'interrupted', 'failed', 'error'].includes(nextPhase);

  if (wasActive && isTerminalPhase) {
    window.setTimeout(() => {
      refreshHistoryAndWorkspaceSoon();
    }, 200);
  }
}

function openLiveStream() {
  closeLiveStream();

  if (!state.selectedThreadId) {
    applyLiveSnapshot(createEmptyLiveState(state.selectedThreadId));
    return;
  }

  const params = new URLSearchParams({
    threadId: state.selectedThreadId,
  });
  const source = new EventSource(`/api/live/events?${params.toString()}`);

  source.addEventListener('snapshot', (event) => {
    try {
      applyLiveSnapshot(JSON.parse(event.data));
    } catch (error) {
      console.error('Failed to parse live snapshot.', error);
    }
  });

  source.onerror = () => {
    // EventSource retries automatically. Health polling remains the fallback.
  };

  state.eventSource = source;
}

function formatTimestamp(value) {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleString();
}

function renderProjects() {
  elements.projectList.innerHTML = '';

  if (state.projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '프로젝트가 없습니다.';
    elements.projectList.appendChild(empty);
    return;
  }

  state.projects.forEach((project) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `project-button ${project.path === state.selectedProjectPath ? 'selected' : ''}`;
    button.dataset.projectPath = project.path;
    button.disabled = state.sending;

    const line = document.createElement('div');
    line.className = 'list-line';

    const title = document.createElement('span');
    title.className = 'list-title';
    title.textContent = project.name;

    line.appendChild(title);
    button.title = `${project.name}\n${project.path}\n${project.threadCount}개 스레드`;
    button.append(line);
    elements.projectList.appendChild(button);
  });
}

function renderPinnedThreads() {
  elements.pinnedList.innerHTML = '';
  showElement(elements.pinnedStrip, state.pinnedThreads.length > 0);

  state.pinnedThreads.forEach((thread) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pinned-chip ${thread.id === state.selectedThreadId ? 'selected' : ''}`;
    button.dataset.threadId = thread.id;
    button.dataset.projectPath = thread.cwd;
    button.disabled = state.sending;
    button.textContent = thread.title || '고정 스레드';
    button.title = [thread.title || '고정 스레드', thread.cwd, thread.updatedAt ? formatTimestamp(thread.updatedAt) : '']
      .filter(Boolean)
      .join('\n');
    elements.pinnedList.appendChild(button);
  });
}

function renderThreads() {
  elements.threadList.innerHTML = '';

  if (!state.selectedProjectPath) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '먼저 프로젝트를 선택하세요.';
    elements.threadList.appendChild(empty);
    renderThreadHeader();
    return;
  }

  if (state.threads.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '아직 스레드가 없습니다. 새 스레드를 만들어 시작하세요.';
    elements.threadList.appendChild(empty);
    renderThreadHeader();
    return;
  }

  state.threads.forEach((thread) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `thread-button ${thread.id === state.selectedThreadId ? 'selected' : ''}`;
    button.dataset.threadId = thread.id;
    button.disabled = state.sending;

    const line = document.createElement('div');
    line.className = 'list-line';

    const title = document.createElement('span');
    title.className = 'list-title';
    title.textContent = thread.title || '새 스레드';

    line.appendChild(title);

    if (thread.id === state.liveThreadId) {
      const badge = document.createElement('span');
      badge.className = 'list-badge';
      badge.textContent = '실행 중';
      line.appendChild(badge);
    } else if (thread.isPinned) {
      const badge = document.createElement('span');
      badge.className = 'list-badge';
      badge.textContent = '고정';
      line.appendChild(badge);
    }

    const details = [
      thread.source || 'codex',
      thread.updatedAt ? formatTimestamp(thread.updatedAt) : '',
    ]
      .filter(Boolean)
      .join(' · ');

    button.title = details ? `${thread.title || '새 스레드'}\n${details}` : thread.title || '새 스레드';
    button.append(line);
    elements.threadList.appendChild(button);
  });

  renderThreadHeader();
}

function renderProjectHeader() {
  const project = state.selectedProject;

  elements.workspaceSummary.textContent =
    state.projects.length > 0 ? `${state.projects.length}개 워크스페이스` : '불러온 워크스페이스가 없습니다.';

  if (!project) {
    elements.projectName.textContent = '선택된 프로젝트가 없습니다';
    elements.projectPath.textContent = '프로젝트를 선택하면 스레드를 볼 수 있습니다.';
    return;
  }

  elements.projectName.textContent = project.name;
  elements.projectPath.textContent = `${project.threadCount}개 스레드 · ${project.path}`;
  renderMobileTitle();
}

function renderThreadHeader() {
  const thread = getSelectedThread();

  if (!thread) {
    elements.threadTitle.textContent = '선택된 스레드가 없습니다';
    elements.threadState.textContent = '스레드를 선택하면 저장된 Codex 기록이 표시됩니다.';
    renderMobileTitle();
    return;
  }

  elements.threadTitle.textContent = thread.title || '새 스레드';
  const details = [];

  if (thread.id === state.liveThreadId) {
    details.push('라이브 세션 연결됨');
  } else {
    details.push('저장된 기록');
  }

  if (thread.source) {
    details.push(thread.source);
  }

  if (thread.updatedAt) {
    details.push(formatTimestamp(thread.updatedAt));
  }

  elements.threadState.textContent = details.join(' · ');
  renderMobileTitle();
}

function renderMessages(messages, emptyText, options = {}) {
  const { stickToBottom = true, preserveViewport = null } = options;

  elements.messageList.innerHTML = '';

  messages.forEach((message) => {
    const wrapper = document.createElement('article');
    wrapper.className = `message ${message.role}`;

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = message.transient
      ? `${message.role} · live`
      : message.createdAt
        ? `${message.role} · ${formatTimestamp(message.createdAt)}`
        : message.role;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = message.content;

    wrapper.append(meta, bubble);
    elements.messageList.appendChild(wrapper);
  });

  elements.emptyState.querySelector('p').textContent = emptyText;
  showElement(elements.emptyState, messages.length === 0);

  if (preserveViewport) {
    requestAnimationFrame(() => {
      const addedHeight = elements.messageList.scrollHeight - preserveViewport.previousScrollHeight;
      elements.messageList.scrollTop = preserveViewport.previousScrollTop + Math.max(addedHeight, 0);
    });
    return;
  }

  if (stickToBottom) {
    requestAnimationFrame(() => {
      const lastMessage = elements.messageList.lastElementChild;

      if (lastMessage) {
        lastMessage.scrollIntoView({ block: 'end' });
        return;
      }

      elements.messageList.scrollTop = 0;
    });
  }
}

function renderHistoryControls() {
  showElement(elements.refreshHistoryButton, Boolean(state.selectedThreadId));
  showElement(elements.loadMoreButton, state.historyHasMore && Boolean(state.selectedThreadId));
  elements.refreshHistoryButton.disabled = state.historyLoading || state.sending || !state.selectedThreadId;
  elements.loadMoreButton.disabled = state.historyLoading || state.sending;
}

function formatActivityLabel(activity) {
  switch (activity?.phase) {
    case 'queued':
      return '메시지 대기 중';
    case 'preparing_turn':
      return '스레드 준비 중';
    case 'attaching_thread':
      return '스레드 연결 중';
    case 'starting_turn':
      return '응답 시작 중';
    case 'running':
      return 'Codex가 작업 중입니다';
    case 'waiting_for_approval':
      return '승인이 필요합니다';
    case 'waiting_for_user_input':
      return '추가 입력이 필요합니다';
    case 'waiting_for_terminal_input':
      return '터미널 입력이 필요합니다';
    case 'interrupting':
      return '중단하는 중';
    case 'completed':
      return '응답을 받았습니다';
    case 'interrupted':
      return '작업이 중단되었습니다';
    case 'failed':
    case 'error':
      return '요청에 실패했습니다';
    default:
      return 'Codex 응답을 기다리는 중...';
  }
}

function formatActivityMeta(activity) {
  const pendingAction = state.live?.pendingAction;

  if (pendingAction?.prompt) {
    return pendingAction.prompt;
  }

  if (activity?.status === 'queued') {
    return activity.messagePreview ? `대기 중: ${activity.messagePreview}` : '메시지가 서버 대기열에 들어갔습니다.';
  }

  if (activity?.status === 'running') {
    return activity.messagePreview ? activity.messagePreview : '현재 요청을 처리하고 있습니다.';
  }

  if (activity?.status === 'completed') {
    return '이번 요청 처리가 끝났습니다.';
  }

  if (activity?.phase === 'interrupted') {
    return '현재 작업이 중단되었습니다.';
  }

  if (activity?.status === 'error') {
    return '요청이 정상적으로 끝나지 않았습니다.';
  }

  if (state.sending) {
    return 'Codex에 메시지를 보내는 중...';
  }

  return '메시지를 처리하고 있습니다.';
}

function renderApprovalBanner() {
  const pendingAction = state.live?.pendingAction;
  const isApproval = pendingAction?.kind === 'approval';

  if (!isApproval) {
    showElement(elements.approvalBanner, false);
    return;
  }

  const details = [];

  if (pendingAction.detail?.command) {
    details.push(pendingAction.detail.command);
  }

  if (pendingAction.detail?.cwd) {
    details.push(pendingAction.detail.cwd);
  }

  if (pendingAction.detail?.grantRoot) {
    details.push(`루트: ${pendingAction.detail.grantRoot}`);
  }

  elements.approvalLabel.textContent = pendingAction.title || '승인이 필요합니다';
  elements.approvalPrompt.textContent = pendingAction.prompt || 'Codex가 결정을 기다리고 있습니다.';
  elements.approvalOptions.textContent = details.join('  ');
  elements.approveButton.textContent = '승인';
  elements.approveButton.disabled = state.approvalSubmittingAction === 'approve';
  elements.denyButton.disabled = state.approvalSubmittingAction === 'deny';

  showElement(elements.approvalBanner, true);
}

function renderUserInputBanner() {
  const pendingAction = state.live?.pendingAction;
  const isUserInput = pendingAction?.kind === 'user_input';

  if (!isUserInput) {
    showElement(elements.userInputBanner, false);
    elements.userInputQuestions.innerHTML = '';
    return;
  }

  elements.userInputLabel.textContent = pendingAction.title || '추가 입력이 필요합니다';
  elements.userInputPrompt.textContent = pendingAction.prompt || '계속하려면 추가 정보가 필요합니다.';
  const existingValues = {};

  elements.userInputQuestions.querySelectorAll('input[name]').forEach((input) => {
    existingValues[input.name] = input.value;
  });

  elements.userInputQuestions.innerHTML = '';

  (pendingAction.questions || []).forEach((question) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'user-input-question';

    const label = document.createElement('label');
    label.setAttribute('for', `question-${question.id}`);
    label.textContent = question.header || question.id;

    const prompt = document.createElement('p');
    prompt.textContent = question.question || '';

    const input = document.createElement('input');
    input.id = `question-${question.id}`;
    input.name = question.id;
    input.type = question.isSecret ? 'password' : 'text';
    input.autocomplete = 'off';
    input.placeholder = question.isOther ? '답변을 입력하세요' : '입력을 작성하세요';
    input.disabled = state.userInputSubmitting;
    input.value = existingValues[question.id] || '';

    wrapper.append(label, prompt, input);

    if (Array.isArray(question.options) && question.options.length > 0) {
      const optionsRow = document.createElement('div');
      optionsRow.className = 'user-input-options';

      question.options.forEach((option) => {
        const optionButton = document.createElement('button');
        optionButton.type = 'button';
        optionButton.className = 'user-option-chip';
        optionButton.textContent = option.label;
        optionButton.disabled = state.userInputSubmitting;
        optionButton.addEventListener('click', () => {
          input.value = option.label;
        });
        optionsRow.appendChild(optionButton);
      });

      wrapper.appendChild(optionsRow);
    }

    elements.userInputQuestions.appendChild(wrapper);
  });

  elements.userInputSubmitButton.disabled = state.userInputSubmitting;
  showElement(elements.userInputBanner, true);
}

function renderTerminalInputBanner() {
  const pendingAction = state.live?.pendingAction;
  const isTerminalInput = pendingAction?.kind === 'terminal_input';

  if (!isTerminalInput) {
    showElement(elements.terminalInputBanner, false);
    elements.terminalInputField.value = '';
    elements.terminalInputField.dataset.pendingKey = '';
    return;
  }

  const pendingKey = `${pendingAction.processId || ''}:${pendingAction.itemId || ''}`;

  if (elements.terminalInputField.dataset.pendingKey !== pendingKey) {
    elements.terminalInputField.value = '';
    elements.terminalInputField.dataset.pendingKey = pendingKey;
  }

  elements.terminalInputLabel.textContent = pendingAction.title || '터미널 입력이 필요합니다';
  elements.terminalInputPrompt.textContent =
    pendingAction.prompt || '실행 중인 명령이 입력을 기다리고 있습니다.';
  elements.terminalInputField.disabled = Boolean(state.terminalInputSubmitting);
  elements.terminalInputSubmitButton.disabled = state.terminalInputSubmitting === 'send';
  elements.terminalInputCloseButton.disabled = Boolean(state.terminalInputSubmitting);

  showElement(elements.terminalInputBanner, true);
}

function renderLivePanel() {
  showElement(elements.interruptButton, Boolean(state.live?.activeTurnId));
  elements.interruptButton.disabled = state.sending;
  showElement(elements.livePanel, false);
}

function renderLoadingIndicator() {
  const hasThreadLiveContent = hasLiveContent(state.live);
  const activity = hasThreadLiveContent ? state.live.activity || {} : state.activity || {};
  const activePhases = new Set([
    'queued',
    'preparing_turn',
    'attaching_thread',
    'starting_turn',
    'running',
    'waiting_for_approval',
    'waiting_for_user_input',
    'waiting_for_terminal_input',
    'interrupting',
  ]);
  const isActive = state.sending || Boolean(state.live?.pendingAction) || activePhases.has(activity.phase);

  elements.loadingLabel.textContent = formatActivityLabel(activity);
  elements.loadingMeta.textContent = formatActivityMeta(activity);
  elements.loadingIndicator.classList.toggle('error', activity.status === 'error');
  showElement(elements.loadingIndicator, isActive);
  renderApprovalBanner();
  renderUserInputBanner();
  renderTerminalInputBanner();
}

function looksLikeCleanAssistantReply(content) {
  const normalized = typeof content === 'string' ? content.trim() : '';

  if (!normalized) {
    return false;
  }

  const blockedFragments = [
    'Remote bridge request id ',
    'Update available',
    'Press enter to continue',
    'OpenAI Codex',
    'Use /skills to list available skills',
    '? for shortcuts',
    'Working (',
    "'codex' 'resume'",
    'Before your answer, print the exact line',
    'After your answer, print the exact line',
  ];

  return !blockedFragments.some((fragment) => normalized.includes(fragment));
}

function applyProvisionalAssistantReply(content) {
  const normalizedContent = typeof content === 'string' ? content.trim() : '';

  if (!normalizedContent || !state.selectedThreadId) {
    return;
  }

  const lastAssistantMessage = [...state.historyMessages]
    .reverse()
    .find((message) => message.role === 'assistant');

  if (lastAssistantMessage?.content?.trim() === normalizedContent) {
    return;
  }

  state.historyMessages = [
    ...state.historyMessages,
    {
      id: `provisional-${Date.now()}`,
      role: 'assistant',
      content: normalizedContent,
      createdAt: new Date().toISOString(),
      provisional: true,
    },
  ];

  renderConversation({ stickToBottom: true });
}

function applyWorkspacePayload(data) {
  state.projects = data.projects || [];
  state.pinnedThreads = data.pinnedThreads || [];
  state.selectedProject = data.selectedProject || null;
  state.threads = data.threads || [];
  state.liveThreadId = data.liveThreadId || null;
  const validProjectPaths = new Set(state.projects.map((projectItem) => projectItem.path));
  state.menuProjectThreads = Object.fromEntries(
    Object.entries(state.menuProjectThreads).filter(([projectPath]) => validProjectPaths.has(projectPath))
  );
  state.menuExpandedProjects = Object.fromEntries(
    Object.entries(state.menuExpandedProjects).filter(([projectPath]) => validProjectPaths.has(projectPath))
  );

  if (state.selectedProject?.path) {
    state.menuProjectThreads[state.selectedProject.path] = state.threads;
    state.menuExpandedProjects[state.selectedProject.path] = true;
  }

  renderLoadingIndicator();

  setSelectedProject(state.selectedProject?.path || '', Boolean(state.selectedProject?.path));

  const selectedStillExists = state.threads.some((thread) => thread.id === state.selectedThreadId);

  if (!selectedStillExists) {
    setSelectedThread(data.threads?.[0]?.id || '', Boolean(data.threads?.[0]?.id));
  } else {
    renderPinnedThreads();
    renderProjects();
    renderThreads();
    renderThreadHeader();
  }

  renderProjectHeader();
  renderMenuPanel();
}

async function refreshWorkspace() {
  const query = state.selectedProjectPath ? `?projectPath=${encodeURIComponent(state.selectedProjectPath)}` : '';
  const data = await api(`/api/threads${query}`);
  applyWorkspacePayload(data);
}

async function handleMenuProjectToggle(projectPath) {
  if (!projectPath || state.sending) {
    return;
  }

  const isExpanded = Boolean(state.menuExpandedProjects[projectPath]);
  state.menuExpandedProjects = {
    ...state.menuExpandedProjects,
    [projectPath]: !isExpanded,
  };
  renderMenuPanel();

  if (isExpanded || state.menuProjectThreads[projectPath]) {
    return;
  }

  if (projectPath === state.selectedProjectPath) {
    state.menuProjectThreads[projectPath] = state.threads;
    renderMenuPanel();
    return;
  }

  state.menuLoadingProjectPath = projectPath;
  renderMenuPanel();

  try {
    const data = await api(`/api/threads?projectPath=${encodeURIComponent(projectPath)}`);
    state.menuProjectThreads[projectPath] = data.threads || [];
  } catch (error) {
    showError(error.message);
  } finally {
    if (state.menuLoadingProjectPath === projectPath) {
      state.menuLoadingProjectPath = '';
    }

    renderMenuPanel();
  }
}

async function refreshHistory() {
  if (!state.selectedThreadId) {
    state.historyMessages = [];
    state.historyHasMore = false;
    state.historyNextBeforeMessageId = '';
    renderHistoryControls();
    renderConversation({ stickToBottom: true }, '스레드를 선택하면 저장된 Codex 메시지를 볼 수 있습니다.');
    return;
  }

  const params = new URLSearchParams({
    threadId: state.selectedThreadId,
    limit: String(HISTORY_PAGE_SIZE),
  });
  const data = await api(`/api/history?${params.toString()}`);

  if (data.threadId !== state.selectedThreadId) {
    return;
  }

  state.historyMessages = data.messages || [];
  state.historyHasMore = Boolean(data.pageInfo?.hasMore);
  state.historyNextBeforeMessageId = data.pageInfo?.nextBeforeMessageId || '';
  renderHistoryControls();
  renderConversation(
    { stickToBottom: state.shouldStickToBottom || state.historyMessages.length === 0 },
    '첫 메시지를 보내면 여기에 대화가 표시됩니다.'
  );
}

async function loadOlderMessages() {
  if (!state.selectedThreadId || !state.historyHasMore || !state.historyNextBeforeMessageId || state.historyLoading) {
    return;
  }

  const previousScrollHeight = elements.messageList.scrollHeight;
  const previousScrollTop = elements.messageList.scrollTop;
  setHistoryLoading(true);

  try {
    const params = new URLSearchParams({
      threadId: state.selectedThreadId,
      limit: String(HISTORY_PAGE_SIZE),
      beforeMessageId: state.historyNextBeforeMessageId,
    });
    const data = await api(`/api/history?${params.toString()}`);

    if (data.threadId !== state.selectedThreadId) {
      return;
    }

    const seen = new Set();
    state.historyMessages = [...(data.messages || []), ...state.historyMessages].filter((message) => {
      if (seen.has(message.id)) {
        return false;
      }

      seen.add(message.id);
      return true;
    });
    state.historyHasMore = Boolean(data.pageInfo?.hasMore);
    state.historyNextBeforeMessageId = data.pageInfo?.nextBeforeMessageId || '';
    renderHistoryControls();
    renderConversation(
      {
      stickToBottom: false,
      preserveViewport: {
        previousScrollHeight,
        previousScrollTop,
      },
      },
      '첫 메시지를 보내면 여기에 대화가 표시됩니다.'
    );
  } finally {
    setHistoryLoading(false);
  }
}

async function refreshHealth() {
  const params = new URLSearchParams();

  if (state.selectedProjectPath) {
    params.set('projectPath', state.selectedProjectPath);
  }

  if (state.selectedThreadId) {
    params.set('threadId', state.selectedThreadId);
  }

  const query = params.toString() ? `?${params.toString()}` : '';
  const data = await api(`/api/health${query}`);

  setStatus(elements.serverStatus, `서버 ${data.server.status}`, 'ok');
  setStatus(
    elements.codexStatus,
    `codex 세션 ${data.codex.status === 'ok' ? '정상' : '준비 안 됨'}`,
    data.codex.status === 'ok' ? 'ok' : 'error'
  );
  setStatus(
    elements.queueStatus,
    `대기열 ${data.queue.length}${data.queue.processing ? ' + 실행 중' : ''}`,
    data.queue.length === 0 ? 'ok' : null
  );

  state.liveThreadId = data.liveThreadId;
  state.activity = data.activity || {
    status: 'idle',
    phase: 'idle',
    threadId: null,
    messagePreview: '',
    updatedAt: null,
  };
  state.approval = {
    ...createEmptyApprovalState(),
    ...(data.approval || {}),
    submittingAction:
      state.approval.pending && data.approval?.pending ? state.approval.submittingAction || '' : '',
  };
  if (data.live) {
    applyLiveSnapshot(data.live);
  }
  renderLoadingIndicator();
  renderProjects();
  renderPinnedThreads();
  renderThreads();
  renderMenuPanel();
}

async function refreshAll() {
  await refreshWorkspace();
}

function startPolling() {
  stopPolling();

  state.healthPollId = window.setInterval(() => {
    refreshHealth().catch((error) => showError(error.message));
  }, 1200);

  state.workspacePollId = window.setInterval(() => {
    refreshAll().catch((error) => showError(error.message));
  }, 4000);
}

function stopPolling() {
  if (state.healthPollId) {
    clearInterval(state.healthPollId);
    state.healthPollId = null;
  }

  if (state.workspacePollId) {
    clearInterval(state.workspacePollId);
    state.workspacePollId = null;
  }
}

async function bootstrapAuthorizedView() {
  await refreshAll();
  await Promise.all([refreshHistory(), refreshHealth()]);
  showElement(elements.authOverlay, false);
  showAuthError('');
  showError('');
  startPolling();
  elements.promptInput.focus();
}

function resetWorkspaceView() {
  closeLiveStream();
  state.activeDrawer = '';
  state.projects = [];
  state.pinnedThreads = [];
  state.threads = [];
  state.selectedProject = null;
  state.liveThreadId = null;
  state.historyMessages = [];
  state.historyHasMore = false;
  state.historyNextBeforeMessageId = '';
  state.activity = {
    status: 'idle',
    phase: 'idle',
    threadId: null,
    messagePreview: '',
    updatedAt: null,
  };
  state.approval = createEmptyApprovalState();
  state.live = createEmptyLiveState();
  state.shouldStickToBottom = true;
  state.approvalSubmittingAction = '';
  state.userInputSubmitting = false;
  state.terminalInputSubmitting = '';
  setSelectedProject('', false);
  setSelectedThread('', false);
  elements.workspaceSummary.textContent = '...';
  elements.projectName.textContent = '...';
  elements.projectPath.textContent = '';
  renderMobileTitle();
  renderPinnedThreads();
  renderProjects();
  renderThreads();
  renderHistoryControls();
  renderLoadingIndicator();
  renderLivePanel();
  renderUserInputBanner();
  renderTerminalInputBanner();
  renderDrawerState();
  renderMenuPanel();
  renderConversation({ stickToBottom: true }, '프로젝트와 스레드를 선택하면 메시지가 표시됩니다.');
}

async function handleRefreshRecentMessages() {
  if (!state.selectedThreadId || state.historyLoading || state.sending) {
    return;
  }

  showError('');
  setHistoryLoading(true);

  try {
    await Promise.all([refreshHistory(), refreshWorkspace().catch(() => {}), refreshHealth().catch(() => {})]);
  } catch (error) {
    showError(error.message);
  } finally {
    setHistoryLoading(false);
  }
}

function logout() {
  fetch('/api/auth/logout', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
  }).catch(() => {});

  stopPolling();
  state.token = '';
  setSending(false);
  resetWorkspaceView();
  elements.tokenInput.value = '';
  showAuthError('');
  showElement(elements.authOverlay, true);
  setStatus(elements.serverStatus, '서버 ...', null);
  setStatus(elements.codexStatus, 'codex 세션 ...', null);
  setStatus(elements.queueStatus, '대기열 ...', null);
}

async function handleLogin(event) {
  event.preventDefault();
  const candidateToken = elements.tokenInput.value.trim();

  if (!candidateToken) {
    showAuthError('인증 토큰이 필요합니다.');
    return;
  }

  try {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({
        token: candidateToken,
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || '인증되지 않았습니다.');
    }

    state.token = '';
    await bootstrapAuthorizedView();
    elements.tokenInput.value = '';
  } catch (error) {
    showAuthError(error.message);
    state.token = '';
  }
}

async function handleApproval(action) {
  if (state.live?.pendingAction?.kind !== 'approval' || !state.selectedThreadId) {
    return;
  }

  showError('');
  state.approvalSubmittingAction = action;
  renderApprovalBanner();

  try {
    const data = await api('/api/live/approval', {
      method: 'POST',
      body: JSON.stringify({
        threadId: state.selectedThreadId,
        action,
      }),
    });

    state.approvalSubmittingAction = '';
    applyLiveSnapshot(data.live || createEmptyLiveState(state.selectedThreadId));
    await refreshHealth().catch(() => {});
  } catch (error) {
    state.approvalSubmittingAction = '';
    renderApprovalBanner();
    showError(error.message);
    await refreshHealth().catch(() => {});
  }
}

async function handleUserInputSubmit(event) {
  event.preventDefault();

  if (state.live?.pendingAction?.kind !== 'user_input' || !state.selectedThreadId || state.userInputSubmitting) {
    return;
  }

  showError('');
  state.userInputSubmitting = true;
  renderUserInputBanner();

  try {
    const formData = new FormData(elements.userInputForm);
    const answers = {};

    (state.live.pendingAction.questions || []).forEach((question) => {
      answers[question.id] = String(formData.get(question.id) || '').trim();
    });

    const data = await api('/api/live/input', {
      method: 'POST',
      body: JSON.stringify({
        threadId: state.selectedThreadId,
        answers,
      }),
    });

    state.userInputSubmitting = false;
    applyLiveSnapshot(data.live || createEmptyLiveState(state.selectedThreadId));
    await refreshHealth().catch(() => {});
  } catch (error) {
    state.userInputSubmitting = false;
    renderUserInputBanner();
    showError(error.message);
  }
}

async function handleInterrupt() {
  if (!state.selectedThreadId || !state.live?.activeTurnId) {
    return;
  }

  showError('');

  try {
    const data = await api('/api/live/interrupt', {
      method: 'POST',
      body: JSON.stringify({
        threadId: state.selectedThreadId,
      }),
    });

    applyLiveSnapshot(data.live || state.live);
  } catch (error) {
    showError(error.message);
  }
}

async function handleRenameThread() {
  const thread = getSelectedThread();

  if (!thread || state.sending) {
    return;
  }

  const nextName = window.prompt('스레드 이름 변경', thread.title || '새 스레드');

  if (nextName === null) {
    return;
  }

  const name = nextName.trim();

  if (!name || name === thread.title) {
    return;
  }

  showError('');

  try {
    const data = await api('/api/threads/rename', {
      method: 'POST',
      body: JSON.stringify({
        threadId: thread.id,
        name,
        projectPath: state.selectedProjectPath,
      }),
    });

    applyWorkspacePayload(data.workspace);
    closeDrawers();
    await refreshHistory();
    await refreshHealth().catch(() => {});
  } catch (error) {
    showError(error.message);
  }
}

async function handleArchiveThread() {
  const thread = getSelectedThread();

  if (!thread || state.sending) {
    return;
  }

  if (!window.confirm(`"${thread.title || '새 스레드'}" 스레드를 보관할까요?`)) {
    return;
  }

  showError('');

  try {
    const data = await api('/api/threads/archive', {
      method: 'POST',
      body: JSON.stringify({
        threadId: thread.id,
        projectPath: state.selectedProjectPath,
      }),
    });

    applyWorkspacePayload(data.workspace);
    closeDrawers();
    await refreshHistory();
    await refreshHealth().catch(() => {});
  } catch (error) {
    showError(error.message);
  }
}

async function handleTerminalInputSubmit(event) {
  event.preventDefault();

  if (state.live?.pendingAction?.kind !== 'terminal_input' || !state.selectedThreadId || state.terminalInputSubmitting) {
    return;
  }

  showError('');
  state.terminalInputSubmitting = 'send';
  renderTerminalInputBanner();

  try {
    const data = await api('/api/live/terminal-input', {
      method: 'POST',
      body: JSON.stringify({
        threadId: state.selectedThreadId,
        input: elements.terminalInputField.value,
        closeStdin: false,
      }),
    });

    state.terminalInputSubmitting = '';
    elements.terminalInputField.value = '';
    applyLiveSnapshot(data.live || createEmptyLiveState(state.selectedThreadId));
    await refreshHealth().catch(() => {});
  } catch (error) {
    state.terminalInputSubmitting = '';
    renderTerminalInputBanner();
    showError(error.message);
  }
}

async function handleTerminalInputClose() {
  if (state.live?.pendingAction?.kind !== 'terminal_input' || !state.selectedThreadId || state.terminalInputSubmitting) {
    return;
  }

  showError('');
  state.terminalInputSubmitting = 'close';
  renderTerminalInputBanner();

  try {
    const data = await api('/api/live/terminal-input', {
      method: 'POST',
      body: JSON.stringify({
        threadId: state.selectedThreadId,
        input: '',
        closeStdin: true,
      }),
    });

    state.terminalInputSubmitting = '';
    elements.terminalInputField.value = '';
    applyLiveSnapshot(data.live || createEmptyLiveState(state.selectedThreadId));
    await refreshHealth().catch(() => {});
  } catch (error) {
    state.terminalInputSubmitting = '';
    renderTerminalInputBanner();
    showError(error.message);
  }
}

async function handleSend() {
  const message = elements.promptInput.value.trim();

  if (!message || state.sending || !state.selectedThreadId) {
    return;
  }

  showError('');
  closeDrawers();
  setSending(true);

  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        threadId: state.selectedThreadId,
        message,
      }),
    });

    elements.promptInput.value = '';
    autosizeTextarea();
    if (data.live) {
      applyLiveSnapshot(data.live);
    }
    await refreshHealth().catch(() => {});
  } catch (error) {
    showError(error.message);

    if (error.payload?.workspace) {
      applyWorkspacePayload(error.payload.workspace);
    }

    await refreshHealth().catch(() => {});
  } finally {
    setSending(false);
  }
}

async function handleNewThread() {
  if (state.sending || !state.selectedProjectPath) {
    return;
  }

  showError('');

  try {
    const data = await api('/api/threads', {
      method: 'POST',
      body: JSON.stringify({
        projectPath: state.selectedProjectPath,
      }),
    });

    applyWorkspacePayload(data);
    setSelectedThread(data.thread.id);
    closeDrawers();
    await refreshHistory();
    await refreshHealth().catch(() => {});
    elements.promptInput.focus();
  } catch (error) {
    showError(error.message);
  }
}

async function handleReset() {
  if (!window.confirm('라이브 tmux Codex 세션만 초기화합니다. 저장된 기록은 남습니다. 계속할까요?')) {
    return;
  }

  showError('');
  closeDrawers();

  try {
    await api('/api/clear', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    state.liveThreadId = null;
    renderThreads();
    renderThreadHeader();
    await refreshHealth();
  } catch (error) {
    showError(error.message);
  }
}

async function handleProjectSelection(projectPath) {
  if (!projectPath || state.sending || projectPath === state.selectedProjectPath) {
    return;
  }

  showError('');
  setSelectedProject(projectPath);
  setSelectedThread('', false);
  await refreshWorkspace();
  closeDrawers();
  await refreshHistory();
  await refreshHealth().catch(() => {});
}

async function handleThreadSelection(threadId) {
  if (!threadId || state.sending || threadId === state.selectedThreadId) {
    return;
  }

  showError('');
  setSelectedThread(threadId);
  closeDrawers();
  await refreshHistory();
  await refreshHealth().catch(() => {});
}

async function handlePinnedThreadSelection(threadId, projectPath) {
  if (!threadId || state.sending) {
    return;
  }

  showError('');

  if (projectPath && projectPath !== state.selectedProjectPath) {
    setSelectedProject(projectPath);
    setSelectedThread('', false);
    await refreshWorkspace();
  }

  setSelectedThread(threadId);
  closeDrawers();
  await refreshHistory();
  await refreshHealth().catch(() => {});
}

elements.authForm.addEventListener('submit', handleLogin);
elements.openProjectsButton.addEventListener('click', () => {
  setActiveDrawer('projects');
});
elements.openThreadsButton.addEventListener('click', () => {
  setActiveDrawer('threads');
});
elements.openMenuButton.addEventListener('click', toggleMenuRoot);
elements.menuNewThreadButton.addEventListener('click', () => {
  handleNewThread().catch((error) => showError(error.message));
});
elements.menuSearchInput.addEventListener('input', () => {
  renderMenuPanel();
});
elements.closeProjectsButton.addEventListener('click', stepBackFromNestedDrawer);
elements.closeThreadsButton.addEventListener('click', stepBackFromNestedDrawer);
elements.closeMenuButton.addEventListener('click', closeDrawers);
elements.drawerBackdrop.addEventListener('click', closeDrawers);
elements.logoutButton.addEventListener('click', logout);
elements.resetButton.addEventListener('click', handleReset);
elements.newThreadButton.addEventListener('click', handleNewThread);
elements.sendButton.addEventListener('click', handleSend);
elements.approveButton.addEventListener('click', () => {
  handleApproval('approve').catch((error) => showError(error.message));
});
elements.denyButton.addEventListener('click', () => {
  handleApproval('deny').catch((error) => showError(error.message));
});
elements.interruptButton.addEventListener('click', () => {
  handleInterrupt().catch((error) => showError(error.message));
});
elements.userInputForm.addEventListener('submit', (event) => {
  handleUserInputSubmit(event).catch((error) => showError(error.message));
});
elements.terminalInputForm.addEventListener('submit', (event) => {
  handleTerminalInputSubmit(event).catch((error) => showError(error.message));
});
elements.terminalInputCloseButton.addEventListener('click', () => {
  handleTerminalInputClose().catch((error) => showError(error.message));
});
elements.loadMoreButton.addEventListener('click', () => {
  loadOlderMessages().catch((error) => showError(error.message));
});
elements.refreshHistoryButton.addEventListener('click', () => {
  handleRefreshRecentMessages().catch((error) => showError(error.message));
});
elements.messageList.addEventListener('scroll', () => {
  state.shouldStickToBottom = isNearMessageListBottom();
});
elements.pinnedList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-thread-id]');

  if (!button) {
    return;
  }

  handlePinnedThreadSelection(button.dataset.threadId, button.dataset.projectPath).catch((error) =>
    showError(error.message)
  );
});
elements.projectList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-project-path]');

  if (!button) {
    return;
  }

  handleProjectSelection(button.dataset.projectPath).catch((error) => showError(error.message));
});
elements.menuPinnedThreadsList.addEventListener('click', (event) => {
  const threadButton = event.target.closest('[data-thread-id]');

  if (!threadButton) {
    return;
  }

  handlePinnedThreadSelection(threadButton.dataset.threadId, threadButton.dataset.projectPath).catch((error) =>
    showError(error.message)
  );
});
elements.menuProjectSections.addEventListener('click', (event) => {
  const threadButton = event.target.closest('[data-thread-id]');

  if (threadButton) {
    handlePinnedThreadSelection(threadButton.dataset.threadId, threadButton.dataset.projectPath).catch((error) =>
      showError(error.message)
    );
    return;
  }

  const projectButton = event.target.closest('[data-project-path]');

  if (!projectButton) {
    return;
  }

  handleMenuProjectToggle(projectButton.dataset.projectPath).catch((error) => showError(error.message));
});
elements.threadList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-thread-id]');

  if (!button) {
    return;
  }

  handleThreadSelection(button.dataset.threadId).catch((error) => showError(error.message));
});
elements.promptInput.addEventListener('input', autosizeTextarea);
elements.promptInput.addEventListener('keydown', (event) => {
  if (!isMobileLayout() && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend().catch((error) => showError(error.message));
  }
});
elements.promptInput.addEventListener('focus', () => {
  updateViewportLayout();
  keepPromptVisible();
});
elements.promptInput.addEventListener('click', () => {
  updateViewportLayout();
  keepPromptVisible();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.activeDrawer) {
    closeDrawers();
  }
});
window.addEventListener('resize', () => {
  updateViewportLayout();
  renderDrawerState();
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    updateViewportLayout();
    keepPromptVisible();
  });

  window.visualViewport.addEventListener('scroll', () => {
    updateViewportLayout();
  });
}

autosizeTextarea();
updateViewportLayout();
resetWorkspaceView();
renderDrawerState();

bootstrapAuthorizedView().catch(() => {
  showElement(elements.authOverlay, true);
});
