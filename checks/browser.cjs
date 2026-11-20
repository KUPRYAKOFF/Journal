const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { chromium } = require('playwright');

const group = { id: 'demo', name: '2ПИЛОТ-25', subject: 'Информационные технологии', subjectCode: 'ИТ' };
const otherCourse = { id: 'demo-first', name: '1ПИЛОТ-26', subject: 'Информатика', subjectCode: 'ИНФ' };
const students = [
  { id: 's1', surname: 'Тестов', name: 'Иван', patronymic: 'Иванович', subgroup: '1' },
  { id: 's2', surname: 'Тестова', name: 'Анна', patronymic: '', subgroup: '2' }
];
const topics = [];
const lessons = Array.from({ length: 20 }, (_, index) => ({
  id: 'existing-' + index, date: '2026-11-' + String(index + 1).padStart(2, '0'), type: index === 19 ? 'П1' : 'Г', topicId: '',
  note: '', marks: { s1: { value: '5', note: '' }, s2: { value: 'н', note: '' } }, position: index, version: 1
}));
const denseStudents = Array.from({ length: 33 }, (_, index) => ({ id: 'dense-' + index, surname: 'Тестов', name: 'Иван', subgroup: '1' }));
const denseLessons = Array.from({ length: 48 }, (_, index) => ({
  ...lessons[index % lessons.length], id: 'dense-' + index, position: index,
  date: new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10)
}));
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api') {
      const request = JSON.parse(await new Promise(resolve => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
      }));
      const row = request.id && (request.action.endsWith('Lesson') ? lessons : topics).find(item => item.id === request.id);
      let data;
      switch (request.action) {
        case 'session': data = { email: 'pilot@example.test' }; break;
        case 'groups': data = [group, otherCourse]; break;
        case 'group':
          data = request.groupId === otherCourse.id
            ? { group: otherCourse, students: denseStudents, lessons: denseLessons, topics: [] }
            : { group, students, lessons, topics };
          break;
        case 'saveTopic':
          if (row) Object.assign(row, { title: request.title, version: row.version + 1 });
          else topics.push({ id: request.newId, kind: request.kind, title: request.title, unmatchedDates: {}, version: 1 });
          break;
        case 'deleteTopic': row.archived = true; break;
        case 'saveLesson': {
          const marks = Object.fromEntries(request.changes.map(({ studentId, value, note }) => [studentId, { value, note }]));
          lessons.push({ ...request, id: request.newId, marks, version: 1, position: lessons.length });
          break;
        }
        case 'schedule':
          data = { parity: 'нечетная', items: [{ day: 1, pair: 2, week: 1, group: '2пилот-25', subject: 'Информатика', room: '5' },
            { day: 2, pair: 1, week: 1, group: '8', subject: 'Информатика', room: '6' }] };
          break;
      }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, data }));
    }
    const filename = path === '/' ? 'index.html' : path.slice(1);
    if (!['index.html','app.js','styles.css','config.js','vendor/chart.umd.js'].includes(filename)) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ html:'text/html', css:'text/css', js:'text/javascript' })[filename.split('.').pop()] + '; charset=UTF-8');
    const source = filename === 'config.js'
      ? 'window.JOURNAL_CONFIG={apiUrl:"/api",timeZone:"Asia/Irkutsk"};'
      : await readFile(join(__dirname, '../site', filename));
    res.end(source);
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    assert.ok(await page.getByRole('button', { name: 'Войти через Google' }).isVisible());
    assert.equal(await page.locator('.grid-mark').count(), 0);
    await page.evaluate(() => sessionStorage.setItem('journal.session', 'browser-fixture'));
    await page.reload();
    await page.getByRole('heading', { name: 'Расписание' }).waitFor();
    assert.ok(await page.getByRole('heading', { name: 'Главная' }).isVisible());
    assert.ok(await page.getByText('Каб. 5', { exact: false }).isVisible());
    assert.ok(await page.getByText('Группа 8', { exact: true }).isVisible());
    const firstCourse = page.locator('details[data-course="1"]');
    await firstCourse.locator('summary').press('Enter');
    assert.equal(await firstCourse.getAttribute('open'), '');
    assert.ok(await page.getByRole('heading', { name: 'Главная' }).isVisible());
    await page.setViewportSize({ width: 1366, height: 768 });
    await firstCourse.getByRole('button', { name: /1ПИЛОТ-26/ }).click();
    await page.getByRole('heading', { name: 'Оценки и посещаемость' }).waitFor();
    assert.equal(await page.locator('.matrix tbody tr').count(), 33);
    assert.equal(await page.locator('.grid-date').count(), 48);
    const matrix = await page.locator('#matrix-scroll').evaluate(node => ({
      sw: node.scrollWidth, cw: node.clientWidth, sh: node.scrollHeight, ch: node.clientHeight,
      bottom: node.getBoundingClientRect().bottom, viewport: innerHeight,
      components: [...document.querySelectorAll('.main-content, .group-header, .summary, .tabs, .banner, .journal-panel .toolbar')]
        .map(el => [el.className, el.getBoundingClientRect().top, el.getBoundingClientRect().height])
    }));
    assert.ok(matrix.sw <= matrix.cw && matrix.sh <= matrix.ch && matrix.bottom <= matrix.viewport, JSON.stringify(matrix));
    await page.getByRole('button', { name: 'Главная' }).click();
    await page.locator('.schedule-lesson').getByRole('button', { name: '2ПИЛОТ-25' }).click();
    await page.getByRole('heading', { name: 'Оценки и посещаемость' }).waitFor();
    assert.equal(await page.locator('.matrix tbody tr').count(), 2);
    assert.equal(await page.locator('#group-title').textContent(), 'Информационные технологии - 2ПИЛОТ-25');
    assert.equal(await page.locator('.grid-date').first().textContent(), '20.11');
    assert.equal(await page.locator('.grid-date').last().textContent(), '01.11');
    const firstStudent = page.locator('.matrix tbody th').first();
    assert.equal(await firstStudent.locator('.student-name').textContent(), 'Тестов Иван');
    assert.equal(await firstStudent.locator('.student-sub').textContent(), 'П1');
    assert.ok(await firstStudent.evaluate(node => {
      const name = node.querySelector('.student-name').getBoundingClientRect();
      const subgroup = node.querySelector('.student-sub').getBoundingClientRect();
      return name.right < subgroup.left && name.top < subgroup.bottom && subgroup.top < name.bottom;
    }));
    const date = page.locator('.grid-date').first();
    const style = await date.evaluate(node => ({
      width: node.closest('th').getBoundingClientRect().width,
      writing: getComputedStyle(node).writingMode,
      typeBelow: node.nextElementSibling.getBoundingClientRect().top >= node.getBoundingClientRect().bottom
    }));
    assert.equal(style.writing, 'vertical-rl');
    assert.ok(style.width <= 34 && style.typeBelow);
    const locked = page.locator('.grid-mark[disabled]').last();
    assert.ok(await locked.isDisabled());
    assert.equal(await locked.evaluate(node => getComputedStyle(node).cursor), 'not-allowed');
    assert.match(await locked.evaluate(node => getComputedStyle(node).backgroundImage), /repeating-linear-gradient/);
    const editable = page.locator('.grid-mark:not([disabled])').last();
    assert.equal(await editable.evaluate(node => getComputedStyle(node).cursor), 'pointer');
    await page.getByRole('button', { name: 'Настройки' }).click();
    assert.deepEqual(await page.locator('#settings-language option').allTextContents(), ['Русский']);
    await page.locator('#settings-theme').selectOption('dark');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.reload();
    await page.locator('.schedule-lesson').getByRole('button', { name: '2ПИЛОТ-25' }).click();
    await page.getByRole('heading', { name: 'Оценки и посещаемость' }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    if (process.env.JOURNAL_PREVIEW) await page.screenshot({ path: process.env.JOURNAL_PREVIEW + '-dark.png' });
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.locator('#settings-theme').selectOption('light');
    await page.getByRole('button', { name: 'Готово' }).click();
    if (process.env.JOURNAL_PREVIEW) await page.screenshot({ path: process.env.JOURNAL_PREVIEW + '-desktop.png' });
    await page.getByRole('searchbox').fill('Анна');
    assert.equal(await page.locator('.matrix tbody tr').count(), 1);
    await page.getByRole('searchbox').fill('');
    await page.getByRole('button', { name: 'Вычитка' }).click();
    await page.getByRole('button', { name: '＋ Тема' }).first().click();
    await page.getByLabel('Название темы').fill('Тестовая тема');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.getByRole('button', { name: 'Тестовая тема' }).click();
    await page.getByLabel('Название темы').fill('Тема после правки');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.getByRole('button', { name: 'Тема после правки' }).waitFor();
    await page.getByRole('button', { name: '＋ Занятие' }).click();
    await page.getByLabel('Тема', { exact: true }).selectOption({ label: 'Тема после правки' });
    await page.getByLabel('Отметка · Тестов Иван').selectOption('4');
    await page.getByLabel('Комментарий · Тестов Иван').fill('Комментарий\nв две строки');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.getByText('Занятие сохранено.').waitFor();
    assert.equal(lessons.at(-1).marks.s1.note, 'Комментарий\nв две строки');
    await page.getByRole('button', { name: 'Тема после правки' }).click();
    await page.getByRole('button', { name: 'Удалить тему' }).click();
    await page.getByRole('button', { name: 'Удалить', exact: true }).click();
    await page.getByText('Тема удалена из вычитки.').waitFor();
    await page.getByRole('button', { name: 'Занятия', exact: true }).click();
    assert.ok(await page.getByText('Тема после правки', { exact: true }).isVisible());
    await page.getByRole('button', { name: 'Аналитика' }).click();
    await page.locator('#chart-average').waitFor();
    assert.equal(await page.locator('#chart-average').evaluate(node => Chart.getChart(node).config.type), 'line');
    assert.equal(await page.locator('#chart-attendance').evaluate(node => Chart.getChart(node).config.type), 'line');
    assert.equal(await page.locator('#chart-average').evaluate(node => Chart.getChart(node).data.labels[0]), '01.11');
    await page.locator('#timeline-attendance').selectOption('month');
    assert.equal(await page.locator('#timeline-attendance').inputValue(), 'month');
    if (process.env.JOURNAL_PREVIEW) await page.screenshot({ path: process.env.JOURNAL_PREVIEW + '-charts.png' });
    await page.getByRole('button', { name: 'Рулетка' }).click();
    await page.getByLabel('Кого включить').selectOption('existing-0');
    await page.getByRole('button', { name: 'Выбрать студента' }).click();
    assert.equal(await page.locator('#roulette-result').textContent(), 'Тестов Иван Иванович');
    await page.getByRole('button', { name: 'Закрыть' }).click();
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать CSV' }).click()]);
    assert.match(file.suggestedFilename(), /\.csv$/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Журнал', exact: true }).click();
    const widths = await page.evaluate(() => ({
      viewport: innerWidth, page: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body > *, .workspace > *, .sidebar > *, .main-content > *')]
        .map(node => [node.className || node.id, node.getBoundingClientRect().right, node.scrollWidth])
    }));
    assert.ok(widths.page <= widths.viewport, JSON.stringify(widths));
    assert.ok(await page.locator('#group-title').evaluate(node =>
      getComputedStyle(node).whiteSpace === 'nowrap' && node.scrollWidth <= node.clientWidth));
    assert.ok(await page.locator('#matrix-scroll').evaluate(node => node.scrollWidth > node.clientWidth));
    if (process.env.JOURNAL_PREVIEW) await page.screenshot({ path: process.env.JOURNAL_PREVIEW + '-mobile.png' });
    assert.deepEqual(errors, []);
    console.log('Chromium: вход, курсы, компактный журнал, настройки темы, редакторы, расписание, рулетка, CSV, мобильная ширина.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
