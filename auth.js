'use strict';

window.JournalAuth = (() => {
  const config = window.JOURNAL_CONFIG;
  const sessionKey = 'journal.session';
  const oauthKey = 'journal.oauth';

  async function request(action, fields = {}, token = '') {
    if (!config.apiUrl) throw new Error('Адрес сервера журнала ещё не настроен.');
    let response, result;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      response = await fetch(config.apiUrl, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ ...fields, action, token }),
        credentials: 'omit', cache: 'no-store', signal: controller.signal
      });
      result = await response.json();
    } catch {
      const error = new Error('Связь с сервером журнала прервалась. Проверьте соединение.');
      error.code = 'NETWORK';
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok || !result?.ok) {
      const error = new Error(result?.message || 'Сервер не смог выполнить запрос.');
      error.code = result?.code || 'SERVER';
      throw error;
    }
    return result.data;
  }

  function base64(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function signIn(target = '') {
    if (!config.googleClientId || !config.redirectUri || !config.apiUrl) {
      throw new Error('Подключение к Google ещё не настроено.');
    }
    const verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = base64(crypto.getRandomValues(new Uint8Array(24)));
    const challenge = base64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    sessionStorage.setItem(oauthKey, JSON.stringify({ nonce, verifier, target, created: Date.now() }));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.googleClientId, redirect_uri: config.redirectUri, response_type: 'code',
      scope: 'openid email', state: nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
    });
    location.assign(url);
  }

  function hasCallback() {
    const params = new URLSearchParams(location.search);
    return params.has('code') || params.has('error');
  }

  async function finishSignIn() {
    const params = new URLSearchParams(location.search);
    history.replaceState(null, '', location.pathname);
    const pending = JSON.parse(sessionStorage.getItem(oauthKey) || 'null');
    sessionStorage.removeItem(oauthKey);
    if (!pending || pending.nonce !== params.get('state') || Date.now() - pending.created > 600000 || params.has('error')) {
      throw new Error('Вход отменён или истёк. Начните заново.');
    }
    const account = await request('login', { code: params.get('code'), verifier: pending.verifier });
    sessionStorage.setItem(sessionKey, account.token);
    return { account, target: pending.target };
  }

  return Object.freeze({
    request, signIn, hasCallback, finishSignIn,
    token: () => sessionStorage.getItem(sessionKey) || '',
    clear: () => sessionStorage.removeItem(sessionKey)
  });
})();
