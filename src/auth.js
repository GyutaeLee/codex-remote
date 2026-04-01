const crypto = require('crypto');

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(cookieHeader) {
  const cookies = {};

  for (const part of String(cookieHeader || '').split(';')) {
    const trimmed = part.trim();

    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!name || !value) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(value);
    } catch (error) {
      continue;
    }
  }

  return cookies;
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader('Set-Cookie');

  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }

  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path || '/'}`);

  if (Number.isFinite(options.maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }

  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function getBearerToken(req) {
  const authorization = req.get('authorization') || '';

  if (!authorization.startsWith('Bearer ')) {
    return '';
  }

  return authorization.slice('Bearer '.length).trim();
}

function isValidBearerToken(expectedToken, candidateToken) {
  return Boolean(expectedToken && candidateToken && safeEquals(expectedToken, candidateToken));
}

function isSecureRequest(req) {
  if (req.secure) {
    return true;
  }

  const forwardedProto = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  return forwardedProto === 'https';
}

function isLoopbackRequest(req) {
  const candidate = String(req.ip || req.socket?.remoteAddress || '')
    .trim()
    .toLowerCase();

  return candidate === '127.0.0.1' || candidate === '::1' || candidate === '::ffff:127.0.0.1';
}

class SessionStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  cleanup() {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }

  create(metadata = {}) {
    this.cleanup();

    const sessionId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session = {
      id: sessionId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      metadata,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId) {
    this.cleanup();
    const session = this.sessions.get(String(sessionId || ''));

    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(session.id);
      return null;
    }

    return session;
  }

  delete(sessionId) {
    this.sessions.delete(String(sessionId || ''));
  }
}

function createSessionStore(ttlMs) {
  return new SessionStore(ttlMs);
}

function readSessionId(req, cookieName) {
  const cookies = parseCookies(req.headers.cookie || '');
  return String(cookies[cookieName] || '').trim();
}

function setSessionCookie(res, cookieName, sessionId, req, ttlMs) {
  const maxAgeSeconds = Math.floor(ttlMs / 1000);
  const secure = isSecureRequest(req);

  appendSetCookie(
    res,
    serializeCookie(cookieName, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      secure,
      maxAgeSeconds,
    })
  );
}

function clearSessionCookie(res, cookieName, req) {
  appendSetCookie(
    res,
    serializeCookie(cookieName, '', {
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      secure: isSecureRequest(req),
      maxAgeSeconds: 0,
    })
  );
}

function createAuthMiddleware({ expectedToken, sessionStore, sessionCookieName }) {
  return function authMiddleware(req, res, next) {
    const bearerToken = getBearerToken(req);

    if (isValidBearerToken(expectedToken, bearerToken)) {
      req.auth = {
        type: 'token',
      };
      return next();
    }

    const sessionId = readSessionId(req, sessionCookieName);
    const session = sessionStore.get(sessionId);

    if (session) {
      req.auth = {
        type: 'session',
        sessionId,
        session,
      };
      return next();
    }

    return res.status(401).json({
      ok: false,
      error: 'Unauthorized.',
    });
  };
}

module.exports = {
  clearSessionCookie,
  createAuthMiddleware,
  createSessionStore,
  getBearerToken,
  isLoopbackRequest,
  isSecureRequest,
  isValidBearerToken,
  readSessionId,
  safeEquals,
  setSessionCookie,
};
