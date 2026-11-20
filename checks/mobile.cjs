const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve, extname } = require('node:path');
const { chromium } = require('playwright');

const site = resolve(__dirname, '../site');
const prefix = '/Journal/';
const groups = [{ id: 'tito25-it', name: '2ТиТО-25', subject: 'Информационные технологии' },
  { id: 'op26-inf', name: '1ОП-26', subject: 'Информатика' }];
const ivan = { id: 'ivan', surname: 'Тестов', name: 'Иван', patronymic: 'Иванович', subgroup: '1' };
const anna = { id: 'anna', surname: 'Проверова', name: 'Анна', patronymic: 'Олеговна', subgroup: '2' };
const makeLesson = (id, type, date, marks = {}) => ({ id, type, date, topicId: 'topic1', position: 1, marks, version: 1, note: '' });
const journals = {
  'tito25-it': { group: groups[0], students: [ivan, anna], topics: [{ id: 'topic1', title: 'Работа с таблицами' }],
    lessons: [makeLesson('lecture', 'Г', '2026-11-18', { ivan: { value: '3', note: 'Комментарий' } }),
      makeLesson('practice1', 'П1', '2026-11-20'), makeLesson('practice2', 'П2', '2026-11-21')] },
  'op26-inf': { group: groups[1], students: [{ id: 'maria', surname: 'Соседова', name: 'Мария', subgroup: '1' }],
    topics: [], lessons: [makeLesson('other-lecture', 'Г', '2026-11-18')] }
};
const expectedChallenge = new Map();
const tokens = { 'first-token': 'teacher@example.test', 'second-token': 'other@example.test' };
const saves = [];
let lostResponse = false;

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path === '/api') {
      const request = JSON.parse(await new Promise(resolveBody => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolveBody(body));
      }));
      const send = data => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      const respond = data => send({ ok: true, data });
      const fail = (code, message) => send({ ok: false, code, message });
      if (request.action === 'login') {
        assert.equal(crypto.createHash('sha256').update(request.verifier).digest('base64url'), expectedChallenge.get(request.code));
        return respond({ token: 'first-token', email: tokens['first-token'] });
      }
      if (!Object.hasOwn(tokens, request.token)) return fail('AUTH', 'Требуется вход');
      if (request.action === 'session') return respond({ email: tokens[request.token] });
      if (request.action === 'groups') return respond(groups);
      if (request.action === 'group') return respond(journals[request.groupId]);
      if (request.action === 'logout') return respond({});
      if (request.action === 'saveLesson') {
        const lesson = journals[request.groupId].lessons.find(item => item.id === request.id);
        if (request.version !== lesson.version) return fail('CONFLICT', 'Запись уже изменили');
        const before = structuredClone(lesson.marks);
        for (const { studentId, ...mark } of request.changes) lesson.marks[studentId] = mark;
        lesson.version++;
        saves.push({ request, before });
        if (lostResponse) { lostResponse = false; return req.socket.destroy(); }
        return respond(lesson);
      }
      return fail('INPUT', 'Неизвестное действие');
    }
    if (!path.startsWith(prefix)) return res.writeHead(404).end();
    const suffix = path.slice(prefix.length);
    const filename = !suffix || suffix.endsWith('/') ? suffix + 'index.html' : suffix;
    const absolute = resolve(site, filename);
    if (!absolute.startsWith(site + '/')) return res.writeHead(404).end();
    const mimes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    let source = await readFile(absolute);
    if (filename === 'config.js') source += '\nwindow.JOURNAL_CONFIG = { ...window.JOURNAL_CONFIG, apiUrl: "/api", redirectUri: location.origin + "/Journal/" };';
    res.writeHead(200, { 'Content-Type': mimes[extname(filename)] || 'text/plain' }).end(source);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(error);
    res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + server.address().port + prefix;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(8500);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(root + 'mobile/');
    assert.ok(await page.getByRole('button', { name: 'Войти через Google' }).isVisible());
    assert.equal(await page.locator('.list-item').count(), 0);
    const authNavigation = page.waitForRequest('https://accounts.google.com/o/oauth2/v2/auth**');
    await context.route('https://accounts.google.com/**', route => route.fulfill({ body: 'Test OAuth provider' }));
    await page.getByRole('button', { name: 'Войти через Google' }).click();
    const grant = new URL((await authNavigation).url());
    assert.equal(grant.searchParams.get('redirect_uri'), root);
    assert.equal(grant.searchParams.get('code_challenge_method'), 'S256');
    expectedChallenge.set('test-oauth-code', grant.searchParams.get('code_challenge'));
    await page.waitForURL('https://accounts.google.com/**');
    await page.goto(root + '?code=test-oauth-code&state=' + encodeURIComponent(grant.searchParams.get('state')));
    await page.waitForURL(root + 'mobile/');
    await page.getByRole('heading', { name: 'Выберите группу' }).waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/mobile/sw.js'));
    const appManifest = await (await page.request.get(root + 'mobile/manifest.webmanifest')).json();
    assert.equal(appManifest.display, 'standalone');
    assert.equal(new URL(appManifest.start_url, root + 'mobile/').href, root + 'mobile/');
    for (const icon of appManifest.icons) {
      assert.equal((await page.request.get(new URL(icon.src, root + 'mobile/').href)).status(), 200);
    }
    await page.getByRole('searchbox', { name: 'Поиск студента во всех группах' }).fill('соседова');
    await page.getByRole('button', { name: /Соседова Мария/ }).click();
    await page.getByRole('heading', { name: 'Соседова Мария' }).waitFor();
    await page.getByRole('button', { name: 'Назад' }).click();

    async function openIvan() {
      await page.getByRole('button', { name: /2ТиТО-25/ }).click();
      await page.getByRole('button', { name: 'Подгр. 1', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: /Проверова Анна/ }).count(), 0);
      await page.getByRole('button', { name: /Тестов Иван/ }).click();
      assert.equal(await page.locator('#lesson-list .student').count(), 2);
      assert.ok(await page.getByText('20.11.2026', { exact: true }).isVisible());
      assert.equal(await page.getByText('21.11.2026', { exact: true }).count(), 0);
    }
    await openIvan();
    assert.ok(await page.evaluate(() => {
      const bounds = document.querySelector('#send-btn').getBoundingClientRect();
      return bounds.right <= visualViewport.width && bounds.bottom <= visualViewport.height;
    }));
    if (process.env.JOURNAL_PREVIEW) await page.screenshot({ path: process.env.JOURNAL_PREVIEW, animations: 'disabled' });
    await context.setOffline(true);
    await page.getByRole('button', { name: '5 · 18.11.2026', exact: true }).click();
    await page.getByRole('button', { name: 'Отправить в очередь (1)' }).click();
    await page.locator('#sync-btn').filter({ hasText: 'Офлайн · 1' }).waitFor();
    assert.equal(saves.length, 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Войти через Google' }).waitFor();
    assert.equal(await page.locator('.list-item').count(), 0);

    const mockLesson = journals['tito25-it'].lessons[0];
    mockLesson.marks.ivan = { value: '4', note: 'Комментарий после правки' };
    mockLesson.version++;
    await context.setOffline(false);
    await page.locator('#sync-btn').filter({ hasText: 'Проверить: 1' }).waitFor();
    assert.equal(mockLesson.marks.ivan.value, '4');
    await page.locator('#sync-btn').click();
    assert.ok(await page.getByText(/Сейчас в журнале: 4/).isVisible());
    lostResponse = true;
    await page.getByRole('button', { name: 'Записать мою оценку' }).click();
    await page.getByText('Неотправленных оценок нет.').waitFor({ timeout: 12000 });
    assert.equal(mockLesson.marks.ivan.value, '5');
    assert.equal(mockLesson.marks.ivan.note, 'Комментарий после правки');
    assert.equal(saves.length, 1);
    await page.getByRole('button', { name: 'Закрыть очередь' }).click();
    await openIvan();
    assert.ok(await page.getByText('В журнале: 5', { exact: true }).isVisible());
    await page.getByRole('button', { name: '2 · 20.11.2026', exact: true }).click();
    assert.ok(await page.getByRole('button', { name: 'Отправить в очередь (1)' }).isEnabled());
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await page.getByRole('button', { name: 'Войти через Google' }).waitFor();
    assert.equal(await page.getByText('Тестов Иван', { exact: true }).count(), 0);
    await page.evaluate(() => sessionStorage.setItem('journal.session', 'second-token'));
    await page.reload();
    await page.getByRole('heading', { name: 'Выберите группу' }).waitFor();
    await openIvan();
    assert.ok(await page.getByRole('button', { name: 'Отправить в очередь' }).isDisabled());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('Mobile PWA: OAuth/PKCE, install manifest and offline shell, search, local queue, account isolation, conflict resolution and idempotent retry.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
