'use strict';

const manifest = chrome.runtime.getManifest();

// 30 minutes
const sessionExpiryThreshold = 30 * 60 * 1000;

// Ensure that sessions are initialized before API calls are made
let initSessions = refreshSessions();

chrome.cookies.onChanged.addListener(() => {
  console.log('refreshing sessions, cookies changed');
  initSessions = refreshSessions(true);
});

function sessionUserId(s) {
  if (!s || !s.user || !s.user.user_id) {
    return null;
  }

  return s.user.user_id;
}

async function refreshSessions(force) {
  const sessionCache = force ? {} : await getSessionCache();

  console.log(`refreshing sessions with${force ? '' : 'out'} force`);
  console.log(sessionCache);

  // Check for new Range workspace cookies
  const map = await cookieMap();
  for (const [slug, value] of Object.entries(map)) {
    if (!sessionCache[slug]) sessionCache[slug] = {};
    const session = sessionCache[slug];
    session.cookie_value = value;
  }

  const invalidCookieCache = await getInvalidCookieCache();

  for (const slug in sessionCache) {
    // Check for removed Range workspace cookies
    if (!map[slug]) {
      delete sessionCache[slug];
      continue;
    }

    const session = sessionCache[slug];
    // If session newly initialized or close to expiring, refresh session
    if (
      !session.session_max_age ||
      !session.local_session_expires_at ||
      moment(session.local_session_expires_at) - moment() < sessionExpiryThreshold
    ) {
      const cookieValue = session.cookie_value;
      delete sessionCache[slug];
      try {
        const newSession = await rangeLogin(slug);
        reportFirstAction(USER_ACTIONS.FIRST_LOGIN, newSession);
        newSession.cookie_value = cookieValue;
        // Convert max age duration to local time. Cannot rely on session.session_expires_at because
        // the user's computer might be using the wrong time. This caused a lot of login spam
        // requests if a user's computer thought that its time was after the session expiration
        // time.
        newSession.local_session_expires_at = moment()
          .add(session.session_max_age, 'seconds')
          .toISOString();
        sessionCache[slug] = newSession;
      } catch (_) {
        invalidCookieCache[cookieValue] = slug;
        console.log(`user is not authenticated with ${slug}`);
      }
    }
  }

  chrome.storage.local.get(['active_org'], (resp) => {
    const activeOrg = resp.active_org;
    const slugs = Object.keys(sessionCache);
    if (slugs.length < 1) {
      // If there are no sessions
      chrome.storage.local.set({ auth_state: AUTH_STATES.NO_AUTH.value });
      chrome.browserAction.setBadgeText({ text: AUTH_STATES.NO_AUTH.badge });
    } else if (slugs.length > 1 && !!activeOrg && !slugs.includes(activeOrg)) {
      // If the currently selected sync session isn't authenticated
      chrome.storage.local.set({ auth_state: AUTH_STATES.NO_SYNC_AUTH.value });
      chrome.browserAction.setBadgeText({ text: AUTH_STATES.NO_SYNC_AUTH.badge });
    } else if (slugs.length > 1 && !activeOrg) {
      // If there are multiple sessions and one isn't selected for sync
      chrome.storage.local.set({ auth_state: AUTH_STATES.NO_SYNC_SELECTED.value });
      chrome.browserAction.setBadgeText({ text: AUTH_STATES.NO_SYNC_SELECTED.badge });
    } else {
      // If everything is okay
      chrome.storage.local.set({ auth_state: AUTH_STATES.OK.value });
      chrome.browserAction.setBadgeText({ text: AUTH_STATES.OK.badge });
    }
  });

  await setSessionCache(sessionCache);
  await setInvalidCookieCache(invalidCookieCache);

  console.log(`done refreshing sessions with${force ? '' : 'out'} force`);
  console.log(sessionCache);

  return;
}

async function getSessions() {
  const sessionCache = await getSessionCache();
  const sessions = Object.values(sessionCache);

  if (sessions.length < 1) throw 'no authenticated sessions';
  return sessions;
}

// Returns a map of Range API cookie slugs and cookie values. Filters cookies
// that have been found to be invalid or expired
function cookieMap() {
  return new Promise(async (resolve, reject) => {
    const invalidCookieCache = await getInvalidCookieCache();
    chrome.cookies.getAll({ domain: CONFIG.cookie_host || CONFIG.api_host }, (cookies) => {
      if (cookies === null) {
        reject(chrome.runtime.lastError.message);
      } else {
        resolve(
          cookies
            // Get only Range API cookies
            .filter((c) => c.name.startsWith('at-'))
            // Filter cookies that have previously failed to authenticate
            .filter((c) => !invalidCookieCache[c.value])
            // Filter expired cookies
            .filter((c) => moment(c.expirationDate).isBefore(moment()))
            // Convert to slug:cookie_value map
            .reduce((acc, cur) => {
              acc[cur.name.substr(3)] = cur.value;
              return acc;
            }, {})
        );
      }
    });
  });
}

function getSessionCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get('session_cache', (r) => {
      resolve(r.session_cache || {});
    });
  });
}

function setSessionCache(sessionCache) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ session_cache: sessionCache }, resolve);
  });
}

function getInvalidCookieCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get('invalid_cookie_cache', (r) => {
      resolve(r.invalid_cookie_cache || {});
    });
  });
}

function setInvalidCookieCache(invalidCookieCache) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ invalid_cookie_cache: invalidCookieCache }, resolve);
  });
}

// Posts a new suggestion to the Range servers on behalf of the user. Based on
// the suggestion object it will be deduped.
function recordInteraction(interaction, params) {
  return post('/v1/activity', interaction, params);
}

// Retrieves that last 100 attachments associated with this user
function recentActivity(params) {
  return get(
    '/v1/activity?collation=ATTACHMENT&attachment_visibility=NEW&include_dismissed=true&include_refs=true&limit=100',
    params
  );
}

// Retrieves the last 100 attachments associated with this user for a given provider
function listActivity(provider, params) {
  return get(
    `/v1/activity?include_attachment_providers=${provider}&collation=ATTACHMENT&attachment_visibility=NEW&include_dismissed=true&include_refs=true&limit=100`,
    params
  );
}

// Posts a new snippet to a Check-in.
function addSnippet(userId, snippet, params) {
  return post(`/v1/users/${userId}/snippets`, snippet, params);
}

function userStats(userId, params) {
  return get(`/v1/users/${userId}/stats`, params);
}

function rangeLogin(orgSlug) {
  return request(`/v1/auth/login/${orgSlug}`);
}

function reportAction(action, params) {
  return post(
    '/v1/actions',
    {
      name: action,
      reportedAt: new Date(),
      sessionId: Date.now() + '.' + hashCode(navigator.userAgent),
    },
    params
  );
}

// Builds a request params object with the appropriate headers to make an
// authenticated request.
function authorize(session) {
  return {
    headers: {
      Authorization: `reflex ${session.access_token}`,
    },
  };
}

function post(path, data, params = {}) {
  return request(path, {
    ...params,
    method: 'POST',
    body: JSON.stringify(data),
    headers: {
      ...params.headers,
    },
  });
}

function get(path, params = {}) {
  return request(path, {
    ...params,
    method: 'GET',
    headers: {
      ...params.headers,
    },
  });
}

// Makes a request to the Range API server, handling authentication and common error cases
async function request(path, params = {}) {
  const isLogin = path.includes('login');

  // Make sure we don't do requests before we are authenticated
  if (!isLogin) await initSessions;

  let resp;
  try {
    resp = await fetch(`https://${CONFIG.api_host}${path}`, {
      ...params,
      headers: {
        ...params.headers,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json',
        'X-Range-Client': `ChromeExt/${manifest.version}`,
      },
      redirect: 'error',
    });
  } catch (e) {
    console.log(`Network error, status: (${String(e)})`);
    throw e;
  }

  if (resp.ok) return resp.json();

  if (resp.status === 401 || resp.status === 403) {
    if (isLogin) {
      console.log('failed login attempt, likely invalid cookies...');
    } else {
      console.log('no longer authenticated, refreshing sessions...');
      initSessions = refreshSessions(true);
    }
  } else {
    console.log(`invalid request: (${resp.status}, ${resp.statusText})`);
  }
  throw resp.json();
}

// Implementation of Java's String.hashCode. Not secure.
function hashCode(str) {
  let hash = 0;
  if (!str || str.length === 0) return hash;
  for (let i = 0; i < str.length; i++) {
    let char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}
