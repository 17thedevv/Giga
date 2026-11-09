import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Chrome DevTools Protocol avoids adding browser dependencies to the applications.
export async function browserSmoke({ base, email, password, conversationId }) {
  const profile = await mkdtemp(join(tmpdir(), 'giga-browser-smoke-'));
  const chrome = spawn(process.env.CHROME_BIN ?? 'google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000);
      chrome.once('error', () => { clearTimeout(timer); reject(new Error('Chrome executable unavailable')); });
      let text = '';
      chrome.stderr.on('data', chunk => {
        text += chunk;
        const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const debugOrigin = endpoint.replace('ws:', 'http:').split('/devtools/')[0];
    const targets = await (await fetch(debugOrigin + '/json/list')).json();
    const target = targets.find(item => item.type === 'page');
    assert.ok(target, 'Chrome page target exists');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Chrome protocol connection failed')), { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const response = JSON.parse(String(event.data));
      const waiter = pending.get(response.id);
      if (waiter) {
        clearTimeout(waiter.timer); pending.delete(response.id);
        response.error ? waiter.reject(new Error('Chrome protocol command failed')) : waiter.resolve(response.result);
      }
    });
    function send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Chrome command timed out')); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression: '(async () => (' + expression + '))()', returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, 'Browser script executes successfully');
      return result.result.value;
    }
    async function waitFor(expression, label) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try { if (await evaluate(expression)) return; } catch {}
        await delay(150);
      }
      throw new Error('Browser timed out: ' + label);
    }
    await send('Page.enable');
    await send('Page.navigate', { url: base + '/chat/' + conversationId });
    await waitFor('location.pathname === "/login" && !!document.querySelector("#email")', 'protected deep link redirects to login');
    assert.equal(await evaluate('localStorage.getItem("giga_api_mode")'), 'real', 'Built application defaults to real API');
    // Use real keyboard events so React receives browser-native input changes.
    for (const [selector, value] of [['#email', email], ['#password', password]]) {
      await evaluate('document.querySelector(' + JSON.stringify(selector) + ').focus()');
      await send('Input.insertText', { text: value });
    }
    await evaluate('document.querySelector("form").requestSubmit()');
    const signedIn = '!!document.querySelector("button[title*=\\"sign out\\"]")';
    await waitFor('location.pathname.startsWith("/chat") && ' + signedIn, 'real login completes');
    assert.equal(await evaluate('(await fetch("/api/v1/auth/me")).status'), 200, 'Browser sends real session cookie');
    assert.equal(await evaluate('document.cookie.includes("giga_session")'), false, 'HttpOnly session is inaccessible to browser JavaScript');
    await send('Page.navigate', { url: 'about:blank' });
    await waitFor('location.href === "about:blank"', 'intermediate page');
    await send('Page.navigate', { url: base + '/chat/' + conversationId });
    await waitFor('location.pathname === ' + JSON.stringify('/chat/' + conversationId) + ' && ' + signedIn, 'authenticated deep link and reload');
    await evaluate('document.querySelector("button[title*=\\"sign out\\"]").click()');
    await waitFor('location.pathname === "/login" && !!document.querySelector("#email")', 'real logout completes');
    assert.equal(await evaluate('(await fetch("/api/v1/auth/me")).status'), 401, 'Logout revokes browser session');
    return { checks: ['real-mode default', 'protected deep link', 'form login', 'HttpOnly cookie', 'authenticated reload', 'logout'] };
  } finally {
    socket?.close();
    const exited = chrome.exitCode !== null || chrome.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => chrome.once('exit', resolve));
    const signalChrome = signal => {
      try {
        if (process.platform !== 'win32' && chrome.pid) process.kill(-chrome.pid, signal);
        else chrome.kill(signal);
      } catch {}
    };
    if (chrome.exitCode === null && chrome.signalCode === null) signalChrome('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) signalChrome('SIGKILL');
    await Promise.race([exited, delay(5000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}
