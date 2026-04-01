const crypto = require('crypto');

const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const BRACKETED_PASTE_PATTERN = /\[200~|\[201~/g;
const MENU_OPTION_PATTERN = /^\s*(?:[›>]\s*)?(\d+)\.\s+(.+?)\s*$/;
const TRUST_PROMPT_PATTERN = /do you trust the contents of this directory/i;
const APPROVAL_TEXT_PATTERN =
  /\b(approve|approval|allow|deny|reject|decline|abort|cancel|continue|command|changes|permissions|write access|network access|trust)\b/i;
const POSITIVE_OPTION_PATTERN = /\b(yes|approve|allow|accept|continue|run once)\b/i;
const NEGATIVE_OPTION_PATTERN = /\b(no|deny|reject|decline|abort|cancel|quit)\b/i;
const BROAD_APPROVE_OPTION_PATTERN = /\b(yes|approve|allow|accept|continue)\b/i;
const BROAD_DENY_OPTION_PATTERN = /\b(no|deny|reject|decline|abort|cancel|quit)\b/i;
const LOW_SCOPE_APPROVAL_PENALTY_PATTERN = /\b(always|session|don't ask|do not ask|prefix|amendment)\b/i;

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, '');
}

function sanitizeCapturedText(value) {
  return stripAnsi(normalizeNewlines(value)).replace(BRACKETED_PASTE_PATTERN, '');
}

function isDecorativeLine(value) {
  return /^[╭╰│─]+$/.test(value);
}

function extractBottomMenu(lines) {
  let endIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (MENU_OPTION_PATTERN.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    return null;
  }

  let startIndex = endIndex;

  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();

    if (!trimmed) {
      if (startIndex < endIndex) {
        break;
      }

      continue;
    }

    if (!MENU_OPTION_PATTERN.test(lines[index])) {
      break;
    }

    startIndex = index;
  }

  const options = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    const match = lines[index].match(MENU_OPTION_PATTERN);

    if (!match) {
      continue;
    }

    options.push({
      key: match[1],
      label: match[2].trim(),
      selected: /^\s*[›>]/.test(lines[index]),
    });
  }

  return options.length > 0 ? { startIndex, endIndex, options } : null;
}

function collectPromptLines(lines, startIndex) {
  const promptLines = [];

  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();

    if (!trimmed) {
      if (promptLines.length > 0) {
        break;
      }

      continue;
    }

    if (isDecorativeLine(trimmed)) {
      if (promptLines.length > 0) {
        break;
      }

      continue;
    }

    promptLines.unshift(trimmed);

    if (promptLines.length >= 5) {
      break;
    }
  }

  return promptLines;
}

function detectInteractivePromptKind(promptText, options) {
  const optionText = options.map((option) => option.label).join(' ');
  const combined = [promptText, optionText].filter(Boolean).join(' ');

  if (!combined) {
    return null;
  }

  if (TRUST_PROMPT_PATTERN.test(combined)) {
    return 'trust';
  }

  if (APPROVAL_TEXT_PATTERN.test(combined)) {
    return 'approval';
  }

  return null;
}

function hasRegularPromptAfterMenu(lines, endIndex) {
  for (let index = endIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();

    if (!trimmed) {
      continue;
    }

    if (MENU_OPTION_PATTERN.test(lines[index])) {
      continue;
    }

    if (/^[›>]\s+/.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function scoreInteractiveOption(option, action) {
  const label = String(option?.label || '').toLowerCase();

  if (!label) {
    return Number.NEGATIVE_INFINITY;
  }

  if (action === 'approve') {
    if (!BROAD_APPROVE_OPTION_PATTERN.test(label)) {
      return Number.NEGATIVE_INFINITY;
    }

    let score = 10;

    if (POSITIVE_OPTION_PATTERN.test(label)) {
      score += 10;
    }

    if (/run once|allow once|approve|accept|continue/.test(label)) {
      score += 10;
    }

    if (LOW_SCOPE_APPROVAL_PENALTY_PATTERN.test(label)) {
      score -= 8;
    }

    if (NEGATIVE_OPTION_PATTERN.test(label)) {
      score -= 20;
    }

    return score;
  }

  if (!BROAD_DENY_OPTION_PATTERN.test(label)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 10;

  if (NEGATIVE_OPTION_PATTERN.test(label)) {
    score += 10;
  }

  if (/deny|reject|decline|abort|cancel|quit/.test(label)) {
    score += 10;
  }

  if (POSITIVE_OPTION_PATTERN.test(label)) {
    score -= 20;
  }

  return score;
}

function resolveInteractiveActionOption(interactivePrompt, action) {
  if (!interactivePrompt || !Array.isArray(interactivePrompt.options)) {
    return null;
  }

  let bestOption = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const option of interactivePrompt.options) {
    const score = scoreInteractiveOption(option, action);

    if (score > bestScore) {
      bestScore = score;
      bestOption = option;
    }
  }

  return Number.isFinite(bestScore) && bestScore > Number.NEGATIVE_INFINITY ? bestOption : null;
}

function extractInteractivePrompt(capturedText) {
  const normalized = sanitizeCapturedText(capturedText);
  const lines = normalized.split('\n').slice(-120);
  const menu = extractBottomMenu(lines);

  if (!menu) {
    return null;
  }

  if (hasRegularPromptAfterMenu(lines, menu.endIndex)) {
    return null;
  }

  const promptLines = collectPromptLines(lines, menu.startIndex);
  const promptText = promptLines.join(' ').trim();
  const kind = detectInteractivePromptKind(promptText, menu.options);

  if (!kind) {
    return null;
  }

  return {
    kind,
    prompt: promptText,
    options: menu.options,
  };
}

function captureHasPrompt(capturedText) {
  const normalized = sanitizeCapturedText(capturedText);
  const tailLines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6);

  const hasBusyIndicator = tailLines.some(
    (line) => line.includes('Working (') || line.includes('esc to interrupt')
  );

  if (hasBusyIndicator) {
    return false;
  }

  const hasPromptLine = tailLines.some((line) => line === '›' || line.startsWith('› '));
  const hasShortcutLine = tailLines.some((line) => line.includes('? for shortcuts'));

  return hasPromptLine && hasShortcutLine;
}

function sanitizePrompt(input, maxPromptChars) {
  if (typeof input !== 'string') {
    return '';
  }

  const normalized = normalizeNewlines(input)
    .replace(CONTROL_CHARS_PATTERN, '')
    .trim();

  return normalized.slice(0, maxPromptChars).trim();
}

function buildBridgePrompt(userPrompt) {
  const requestId = crypto.randomUUID();
  const startMarker = `[[CODEX_REMOTE_START:${requestId}]]`;
  const endMarker = `[[CODEX_REMOTE_END:${requestId}]]`;
  const prompt = [
    `Remote bridge request id ${requestId}.`,
    `Answer the user's request normally.`,
    `Before your answer, print the exact line ${startMarker}.`,
    `After your answer, print the exact line ${endMarker}.`,
    'Do not print those markers anywhere else.',
    `User request as a JSON string: ${JSON.stringify(userPrompt)}.`,
  ].join(' ');

  return {
    requestId,
    startMarker,
    endMarker,
    prompt,
  };
}

function diffCapture(before, after) {
  if (!before) {
    return after;
  }

  if (after.startsWith(before)) {
    return after.slice(before.length);
  }

  const maxOverlap = Math.min(before.length, after.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (before.slice(-overlap) === after.slice(0, overlap)) {
      return after.slice(overlap);
    }
  }

  return after;
}

function extractMarkedResponse(capturedText, markers) {
  const normalized = sanitizeCapturedText(capturedText);
  const lines = normalized.split('\n');
  let startIndex = -1;
  let endIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === markers.startMarker) {
      startIndex = index;
      continue;
    }

    if (startIndex !== -1 && lines[index].trim() === markers.endMarker) {
      endIndex = index;
      break;
    }
  }

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return {
      complete: false,
      content: '',
      raw: normalized,
    };
  }

  return {
    complete: true,
    content: lines.slice(startIndex + 1, endIndex).join('\n').trim(),
    raw: normalized,
  };
}

function extractFallbackResponse(capturedText, markers) {
  const normalized = sanitizeCapturedText(capturedText);
  const lines = normalized.split('\n');

  const filtered = lines.filter((line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return true;
    }

    if (trimmed === markers.startMarker || trimmed === markers.endMarker) {
      return false;
    }

    if (line.includes(markers.startMarker) || line.includes(markers.endMarker)) {
      return false;
    }

    if (line.includes('Remote bridge request id ')) {
      return false;
    }

    if (line.includes("Answer the user's request normally.")) {
      return false;
    }

    if (line.includes('Before your answer, print the exact line ')) {
      return false;
    }

    if (line.includes('After your answer, print the exact line ')) {
      return false;
    }

    if (line.includes('Do not print those markers anywhere else.')) {
      return false;
    }

    if (line.includes('User request:')) {
      return false;
    }

    return true;
  });

  const content = filtered.join('\n').trim();

  if (!content) {
    return null;
  }

  return {
    complete: false,
    content,
    raw: normalized,
  };
}

module.exports = {
  buildBridgePrompt,
  captureHasPrompt,
  diffCapture,
  extractInteractivePrompt,
  extractFallbackResponse,
  extractMarkedResponse,
  resolveInteractiveActionOption,
  sanitizePrompt,
};
