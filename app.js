'use strict';

const cfg = window.JOURNAL_CONFIG;
const state = {
  token: '', email: '', groups: [], selected: '', data: null, tab: 'journal',
  query: '', type: '', period: '', request: 0
};
const types = { 'Г': 'Лекция', 'П1': 'Практика · 1', 'П2': 'Практика · 2', 'ИН': 'ИН' };
const $ = id => document.getElementById(id);
const form = $('dialog-form');
const dialog = $('dialog');
const html = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const absent = value => ['н', 'нб'].includes(String(value ?? '').trim().toLowerCase());
const applies = (student, type) => !(type === 'П1' && student.subgroup === '2') && !(type === 'П2' && student.subgroup === '1');
const shortStudentName = student => [student.surname, student.name].filter(Boolean).join(' ');
const studentName = student => [shortStudentName(student), student.patronymic].filter(Boolean).join(' ');
const groupCourse = group => String(group.name).trim().match(/^([1-9]\d*)/)?.[1] || 'other';
const mark = (lesson, student) => lesson.marks[student.id] || { value: '', note: '' };
const ordered = lessons => [...lessons].sort((a, b) =>
  (a.date || '9999').localeCompare(b.date || '9999') || a.position - b.position);
const shortDate = iso => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : '—';
const fullDate = iso => iso ? shortDate(iso) + '.' + iso.slice(0, 4) : '—';
const number = (value, digits = 1) => value === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: cfg.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const topicName = id => state.data?.topics.find(topic => topic.id === id)?.title || '';
const months = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

function message(node, text = '', error = false) {
  node.hidden = !text;
  node.textContent = text;
  node.classList.toggle('error', error);
}

async function api(action, fields = {}) {
  if (!cfg.apiUrl) throw new Error('Для подключения укажите адрес Web App в config.js.');
  let response, result;
  try {
    response = await fetch(cfg.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ action, token: state.token, ...fields }),
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30000)
    });
    result = await response.json();
  } catch {
    throw new Error('Связь с сервером журнала прервалась. Проверьте соединение и повторите попытку.');
  }
  if (!response.ok || !result.ok) {
    const error = new Error(result.message || 'Сервер не смог выполнить запрос.');
    error.code = result.code;
    if (state.token && ['AUTH', 'FORBIDDEN'].includes(error.code)) showSignIn(error.message);
    throw error;
  }
  return result.data;
}

function base64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signIn() {
  if (!cfg.googleClientId || !cfg.redirectUri || !cfg.apiUrl) {
    message($('auth-status'), 'Подключение к Google ещё не настроено. Заполните config.js.', true);
    return;
  }
  $('sign-in').disabled = true;
  try {
    const verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = base64(crypto.getRandomValues(new Uint8Array(24)));
    const challenge = base64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    sessionStorage.setItem('journal.oauth', JSON.stringify({ nonce, verifier, created: Date.now() }));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: cfg.googleClientId, redirect_uri: cfg.redirectUri, response_type: 'code',
      scope: 'openid email', state: nonce, code_challenge: challenge,
      code_challenge_method: 'S256', prompt: 'select_account'
    });
    location.assign(url);
  } catch {
    $('sign-in').disabled = false;
    message($('auth-status'), 'Не удалось начать вход. Проверьте настройки браузера.', true);
  }
}

function showSignIn(error = '') {
  state.token = '';
  state.groups = [];
  state.selected = '';
  state.data = null;
  state.request++;
  sessionStorage.removeItem('journal.session');
  $('workspace').hidden = true;
  $('content').replaceChildren();
  renderGroups();
  $('summary').replaceChildren();
  if (dialog.open) dialog.close();
  $('dialog-body').replaceChildren();
  $('auth').hidden = false;
  $('sign-in').disabled = false;
  message($('auth-status'), error, Boolean(error));
}

async function openWorkspace(account) {
  state.email = account.email;
  $('email').textContent = account.email;
  $('email').title = account.email;
  $('avatar').textContent = account.email.slice(0, 2).toUpperCase();
  const groups = await api('groups');
  state.groups = groups;
  $('auth').hidden = true;
  $('workspace').hidden = false;
  if (groups.length) await loadGroup(groups[0].id);
  else {
    renderGroups();
    renderGroup();
    message($('banner'), 'В базе пока нет групп.');
  }
}

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('code') || params.has('error')) {
    history.replaceState(null, '', location.pathname);
    const pending = JSON.parse(sessionStorage.getItem('journal.oauth') || 'null');
    sessionStorage.removeItem('journal.oauth');
    if (!pending || pending.nonce !== params.get('state') || (Date.now() - pending.created) > 600000 || params.has('error')) {
      return showSignIn('Вход отменён или истёк. Начните заново.');
    }
    $('sign-in').disabled = true;
    message($('auth-status'), 'Проверяем доступ…');
    const account = await api('login', { code: params.get('code'), verifier: pending.verifier });
    state.token = account.token;
    sessionStorage.setItem('journal.session', state.token);
    return openWorkspace(account);
  }
  state.token = sessionStorage.getItem('journal.session') || '';
  if (state.token) {
    $('sign-in').disabled = true;
    message($('auth-status'), 'Проверяем доступ…');
    await openWorkspace(await api('session'));
  }
}

function renderGroups() {
  const courses = [...new Set(state.groups.map(groupCourse))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  const selected = state.groups.find(group => group.id === state.selected);
  const active = selected ? groupCourse(selected) : courses[0];
  $('courses').innerHTML = courses.map(course => `
    <button type="button" id="course-${course}" role="tab" data-course="${course}" aria-controls="course-panel"
      aria-selected="${course === active}" tabindex="${course === active ? '0' : '-1'}">${course === 'other' ? 'Другие' : course + ' курс'}</button>`).join('');

  const panel = $('course-panel');
  panel.hidden = !active;
  if (active) panel.setAttribute('aria-labelledby', 'course-' + active);
  else panel.removeAttribute('aria-labelledby');
  $('groups').innerHTML = state.groups.filter(group => groupCourse(group) === active).map(group => `
    <button type="button" data-group="${html(group.id)}" aria-current="${group.id === state.selected}">
      <span class="group-letter" aria-hidden="true">${html(group.subjectCode)}</span>
      <span class="group-name">${html(group.name)}<small>${html(group.subject)}</small></span>
    </button>`).join('');
}

function selectCourse(tab) {
  if (tab.getAttribute('aria-selected') === 'true') return;
  const group = state.groups.find(item => groupCourse(item) === tab.dataset.course);
  if (!group) return;
  loadGroup(group.id);
  $(tab.id)?.focus();
}

async function loadGroup(id, refresh = false, success = '') {
  const request = ++state.request;
  if (id !== state.selected) {
    state.selected = id;
    state.data = null;
    state.query = state.type = state.period = '';
  }
  renderGroups();
  renderGroup();
  message($('banner'), 'Загружаем журнал…');
  try {
    const data = await api('group', { groupId: id });
    if (state.request !== request) return;
    state.data = data;
    renderGroup();
    message($('banner'), success);
    if (refresh) $('refresh').focus();
  } catch (error) {
    if (state.request !== request) return;
    message($('banner'), error.message, true);
  }
}

function gradeNumber(value) {
  const grade = String(value ?? '').toLowerCase().trim().replace(',', '.');
  const label = { отл: 5, отлично: 5, хор: 4, хорошо: 4, уд: 3, удовлетворительно: 3, неуд: 2, неудовлетворительно: 2 };
  if (Object.hasOwn(label, grade)) return label[grade];
  return /^\d+(\.\d+)?$/.test(grade) ? Number(grade) : null;
}
function statistics(students, lessons) {
  let assigned = 0, present = 0, count = 0, sum = 0;
  for (const lesson of lessons) {
    for (const student of students) {
      if (!applies(student, lesson.type)) continue;
      assigned++;
      const value = mark(lesson, student).value;
      if (!absent(value)) present++;
      const grade = gradeNumber(value);
      if (grade !== null) {
        count++;
        sum += grade;
      }
    }
  }
  return { average: count ? sum / count : null, attendance: assigned ? present / assigned * 100 : null, absences: assigned - present };
}

function renderGroup() {
  const data = state.data;
  const group = data?.group || state.groups.find(item => item.id === state.selected);
  const title = group ? [group.subject, group.name].filter(Boolean).join(' - ') : 'Группы';
  $('group-title').textContent = title;
  $('group-title').title = title;
  $('group-actions').hidden = !group;
  $('download').disabled = $('new-lesson').disabled = $('roulette').disabled = !data;
  $('summary').hidden = $('tabs').hidden = !data;
  if (!data) {
    $('content').replaceChildren();
    return;
  }
  const stats = statistics(data.students, data.lessons);
  const summary = [
    ['Студентов', data.students.length], ['Занятий', data.lessons.length],
    ['Средний балл', number(stats.average, 2)], ['Посещаемость', stats.attendance === null ? '—' : number(stats.attendance) + '%']
  ];
  $('summary').innerHTML = summary.map(([label, value]) => `<div class="metric"><small>${html(label)}</small><strong>${html(value)}</strong></div>`).join('');
  renderTab();
}

function renderTab() {
  for (const item of $('tabs').querySelectorAll('button')) {
    if (item.dataset.tab === state.tab) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (!state.data) return;
  const renderers = { journal: renderMatrix, lessons: renderLessons, topics: renderTopics, analytics: renderAnalytics };
  renderers[state.tab]();
}

function typePill(value) {
  const cls = value === 'Г' ? '' : value === 'ИН' ? ' neutral' : ' practice';
  return `<span class="pill${cls}">${html(types[value] || value || '—')}</span>`;
}
function typeSelect(selected = '', all = false) {
  return (all ? '<option value="">Все типы</option>' : '') + Object.entries(types).map(([key, name]) =>
    `<option value="${key}" ${key === selected ? 'selected' : ''}>${name}</option>`).join('');
}
function journalStudentLabel(student) {
  const name = html(shortStudentName(student));
  const subgroup = ['1', '2'].includes(student.subgroup)
    ? `<small class="student-sub" aria-label="Подгруппа ${student.subgroup}">П${student.subgroup}</small>` : '';
  return `<span class="student-label"><span class="student-name" title="${name}">${name}</span>${subgroup}</span>`;
}

function matrixBody(autoScroll = false) {
  const scroller = $('matrix-scroll');
  if (!scroller) return;
  const scroll = scroller.scrollLeft;
  const query = state.query.toLocaleLowerCase('ru').trim();
  const students = state.data.students.filter(student => studentName(student).toLocaleLowerCase('ru').includes(query));
  const lessons = ordered(state.data.lessons).filter(lesson =>
    (!state.type || lesson.type === state.type) && (!state.period || lesson.date.startsWith(state.period)));
  if (!lessons.length || !students.length) {
    scroller.innerHTML = `<p class="empty">${!lessons.length ? 'Нет занятий за выбранный период.' : 'Студенты не найдены.'}</p>`;
    return;
  }
  scroller.innerHTML = `<table class="matrix"><thead><tr><th scope="col">Студент</th>${lessons.map(lesson => {
    const label = [fullDate(lesson.date), types[lesson.type] || lesson.type, topicName(lesson.topicId)].filter(Boolean).join(' · ');
    return `<th scope="col"><button type="button" class="grid-head" data-lesson="${html(lesson.id)}"
      title="${html(label)}" aria-label="${html(label)}"><span class="grid-date">${html(shortDate(lesson.date))}</span>
      <small>${html(lesson.type)}</small></button></th>`;
  }).join('')}</tr></thead>
    <tbody>${students.map(student => `<tr><th scope="row">${journalStudentLabel(student)}</th>${lessons.map(lesson => {
      const entry = mark(lesson, student);
      const active = applies(student, lesson.type);
      const status = active ? (entry.value || 'присутствовал') : 'другая подгруппа';
      const tooltip = active ? (entry.value || 'Поставить отметку') : 'Другая подгруппа';
      const label = [shortStudentName(student), fullDate(lesson.date), status].join(', ');
      return `<td><button type="button" class="grid-mark" data-lesson="${html(lesson.id)}" data-student="${html(student.id)}"
        data-mark="${html(entry.value)}" data-note="${Boolean(entry.note)}" title="${html(tooltip)}" ${active ? '' : 'disabled'}
        aria-label="${html(label)}">${html(entry.value || (active ? '·' : '—'))}</button></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
  scroller.scrollLeft = autoScroll ? scroller.scrollWidth : scroll;
}

function renderMatrix() {
  const dates = [...new Set(ordered(state.data.lessons).map(lesson => lesson.date.slice(0, 7)).filter(Boolean))];
  $('content').innerHTML = `<article class="panel">
    <div class="toolbar"><div><h2>Оценки и посещаемость</h2><p>· присутствовал · н пропуск · штриховка — другая подгруппа</p></div>
    <div class="buttons"><input id="student-search" type="search" placeholder="Найти студента" aria-label="Поиск студента" value="${html(state.query)}">
    <select id="period-filter" aria-label="Месяц"><option value="">Все месяцы</option>${dates.map(iso => 
      `<option value="${html(iso)}" ${iso === state.period ? 'selected' : ''}>${months[Number(iso.slice(5)) - 1]} ${iso.slice(0, 4)}</option>`).join('')}</select>
    <select id="type-filter" aria-label="Тип занятия">${typeSelect(state.type, true)}</select></div></div>
    <div id="matrix-scroll" class="table-scroll"></div></article>`;
  matrixBody(true);
}

function renderLessons() {
  const lessons = ordered(state.data.lessons).reverse();
  $('content').innerHTML = `<article class="panel"><div class="toolbar"><h2>Ведомость занятий</h2><p>${lessons.length} в журнале</p></div>
    ${lessons.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Дата</th><th>Тип</th><th>Тема</th><th class="number">Пропуски</th></tr></thead>
    <tbody>${lessons.map(lesson => `<tr><td class="nowrap"><button class="link-btn" data-lesson="${html(lesson.id)}">${fullDate(lesson.date)}</button></td>
      <td>${typePill(lesson.type)}</td><td>${html(topicName(lesson.topicId) || '—')}${lesson.note ? '<br><small class="hint">' + html(lesson.note) + '</small>' : ''}</td>
      <td class="number">${statistics(state.data.students, [lesson]).absences}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Добавьте первое занятие.</p>'}</article>`;
}

function topicDate(topic, type) {
  const dates = state.data.lessons.filter(lesson => lesson.topicId === topic.id && lesson.type === type)
    .map(lesson => fullDate(lesson.date));
  if (topic.unmatchedDates[type]) dates.push(fullDate(topic.unmatchedDates[type]) + '*');
  return dates.join(', ') || '—';
}
function renderTopics() {
  const options = [['lecture', 'Лекции', ['Г']], ['practice', 'Практики', ['П1', 'П2']]];
  const hasUnmatched = state.data.topics.some(topic => !topic.archived && Object.keys(topic.unmatchedDates).length);
  $('content').innerHTML = `<div class="topic-columns">${options.map(([kind, name, valid]) => {
    const topics = state.data.topics.filter(topic => topic.kind === kind && !topic.archived);
    const done = type => topics.filter(topic => topicDate(topic, type) !== '—').length;
    return `<article class="panel"><div class="toolbar"><div><h2>${name}</h2>
      <p>${valid.map(type => (type === 'Г' ? 'Проведено ' : type + ' · ') + done(type) + ' / ' + topics.length).join(' · ')}</p></div>
      <button class="secondary" data-new-topic="${kind}">＋ Тема</button></div>
      ${topics.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Тема</th>${valid.map(type => '<th>' + (type === 'Г' ? 'Дата' : type) + '</th>').join('')}</tr></thead>
      <tbody>${topics.map(topic => `<tr><td><button class="link-btn" data-topic="${html(topic.id)}">${html(topic.title)}</button></td>
        ${valid.map(type => `<td class="nowrap">${html(topicDate(topic, type))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">Тем пока нет.</p>'}</article>`;
  }).join('')}</div>${hasUnmatched ? '<p class="hint">* Дата из исходной вычитки без соответствующего занятия в журнале.</p>' : ''}`;
}

function renderAnalytics() {
  const { students, lessons } = state.data;
  const rows = students.map(student => ({ student, ...statistics([student], lessons) }))
    .sort((a, b) => b.absences - a.absences || (a.average ?? 6) - (b.average ?? 6));
  const chronology = ordered(lessons).map(lesson => ({ date: lesson.date, ...statistics(students, [lesson]) }));
  const chart = (label, key, max, suffix) => `<article class="panel"><div class="toolbar"><h2>${label}</h2></div>
     <div class="trend-items">${chronology.filter(item => item[key] !== null).map(item =>
       `<div class="trend-item"><span>${shortDate(item.date)}</span><progress max="${max}" value="${item[key]}" aria-label="${label} ${fullDate(item.date)}"></progress>
       <span class="number">${number(item[key])}${suffix}</span></div>`).join('') || '<p class="empty">Данных пока нет.</p>'}</div></article>`;
  $('content').innerHTML = `<div class="analytics-layout">${chart('Средний балл по занятиям', 'average', 5, '')}${chart('Посещаемость по занятиям', 'attendance', 100, '%')}</div>
     <article class="panel"><div class="toolbar"><h2>По студентам</h2><p>Сортировка по числу пропусков</p></div>
     <div class="table-scroll"><table class="data-table"><thead><tr><th>Студент</th><th class="number">Средний балл</th>
     <th class="number">Пропуски</th><th class="number">Посещаемость</th></tr></thead><tbody>${rows.map(row =>
     `<tr><td>${html(studentName(row.student))}</td><td class="number">${number(row.average, 2)}</td>
     <td class="number">${row.absences}</td><td class="number">${row.attendance === null ? '—' : number(row.attendance) + '%'}</td></tr>`).join('')}</tbody></table></div></article>`;
}

function openDialog(title, body, actions = '', submit = null) {
  $('dialog-title').textContent = title;
  const kicker = $('dialog-kicker');
  kicker.textContent = state.data?.group.name || '';
  kicker.hidden = !kicker.textContent;
  $('dialog-body').innerHTML = body;
  $('dialog-actions').innerHTML = actions;
  $('dialog-body').scrollTop = 0;
  message($('dialog-status'));
  form.onsubmit = event => {
    event.preventDefault();
    if (submit) submit();
  };
  if (!dialog.open) dialog.showModal();
}
function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem('journal.preferences') || '{}');
    return { theme: saved?.theme === 'dark' ? 'dark' : 'light', language: 'ru' };
  } catch {
    return { theme: 'light', language: 'ru' };
  }
}

const preferences = readPreferences();

function applyPreferences() {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.lang = preferences.language;
  document.querySelector('meta[name="theme-color"]').content = preferences.theme === 'dark' ? '#131925' : '#f5f6fa';
}

function openSettings() {
  openDialog('Настройки', `
    <label class="field">Тема<select id="settings-theme">
      <option value="light">Светлая</option>
      <option value="dark">Тёмная</option>
    </select></label>
    <label class="field">Язык<select id="settings-language">
      <option value="ru">Русский</option>
    </select></label>`,
    '<button class="primary" type="submit">Готово</button>', () => dialog.close());
  $('dialog-kicker').hidden = true;

  const theme = $('settings-theme');
  const language = $('settings-language');
  theme.value = preferences.theme;
  language.value = preferences.language;
  const save = () => {
    preferences.theme = theme.value;
    preferences.language = language.value;
    applyPreferences();
    try {
      localStorage.setItem('journal.preferences', JSON.stringify(preferences));
    } catch {
      message($('dialog-status'), 'Браузер не сохраняет настройки между посещениями.', true);
    }
  };
  theme.onchange = language.onchange = save;
  theme.focus();
}

function busyDialog(busy) {
  form.dataset.busy = String(busy);
  for (const control of form.querySelectorAll('button,input,select,textarea')) {
    if (busy) {
      control.dataset.wasDisabled = String(control.disabled);
      control.disabled = true;
    } else {
      control.disabled = control.dataset.wasDisabled === 'true';
      delete control.dataset.wasDisabled;
    }
  }
}
async function mutate(action, payload, success) {
  if (form.dataset.busy === 'true') return;
  busyDialog(true);
  message($('dialog-status'), 'Сохраняем…');
  try {
    await api(action, payload);
    dialog.close();
    await loadGroup(payload.groupId, false, success);
  } catch (error) {
    if (dialog.open) message($('dialog-status'), error.message, true);
  } finally {
    busyDialog(false);
  }
}
function confirmDelete(action, payload, description, success, back) {
  openDialog('Подтвердите удаление', '<p>' + html(description) + '</p>',
    '<button type="button" id="delete-back" class="secondary">Назад</button><button class="danger">Удалить</button>',
    () => mutate(action, payload, success));
  $('delete-back').onclick = back;
}

function editTopic(kind, existing) {
  const groupId = state.selected;
  const newId = existing ? undefined : crypto.randomUUID();
  const name = kind === 'lecture' ? 'Лекция' : 'Практика';
  openDialog(existing ? 'Редактировать тему' : 'Новая тема',
    `<p>${typePill(kind === 'lecture' ? 'Г' : 'П1')} <span class="hint">${name === 'Практика' ? 'Одна тема для обеих подгрупп' : ''}</span></p>
    <label class="field">Название темы<input id="topic-title" required maxlength="500" value="${html(existing?.title)}"></label>`,
    (existing ? '<button type="button" id="topic-delete" class="danger">Удалить тему</button>' : '') +
    '<button class="primary">Сохранить</button>',
    () => mutate('saveTopic', { groupId, kind, title: $('topic-title').value, newId, id: existing?.id, version: existing?.version }, 'Тема сохранена.'));
  $('topic-title').focus();
  if (existing) {
    $('topic-delete').onclick = () => confirmDelete('deleteTopic', { groupId, id: existing.id, version: existing.version },
      'Тема исчезнет из вычитки и списка выбора. У проведённых занятий останутся название темы и все отметки.',
      'Тема удалена из вычитки.', () => editTopic(kind, existing));
  }
}

function editLesson(existing, studentId) {
  const groupId = state.selected;
  const newId = existing ? undefined : crypto.randomUUID();
  const students = state.data.students;
  const initialType = existing?.type || 'Г';
  const drafts = new Map(students.map(student => [student.id, { ...(existing ? mark(existing, student) : { value: '', note: '' }) }]));
  let activeType = initialType;
  let topicId = existing?.topicId || '';
  const specialDate = existing?.date || today();
  function captureRoster() {
    for (const row of $('lesson-roster').querySelectorAll('[data-roster]')) {
      drafts.set(row.dataset.roster, { value: row.querySelector('select').value, note: row.querySelector('textarea').value });
    }
  }
  function refreshRoster() {
    $('lesson-roster').innerHTML = students.filter(student => applies(student, activeType)).map(student => {
      const current = drafts.get(student.id);
      const values = [['', 'Присутствовал'], ['н', 'н · пропуск'], ...['2','3','4','5'].map(value => [value, value])];
      if (!values.some(([value]) => value === current.value)) values.push([current.value, current.value]);
      const name = shortStudentName(student);
      return `<div class="editor-row" data-roster="${html(student.id)}">${journalStudentLabel(student)}
        <select class="mark-select" aria-label="${html('Отметка · ' + name)}">${values.map(([value, label]) =>
          `<option value="${html(value)}" ${value === current.value ? 'selected' : ''}>${html(label)}</option>`).join('')}</select>
        <textarea rows="1" aria-label="${html('Комментарий · ' + name)}" placeholder="Комментарий" maxlength="${Math.max(2000, current.note.length)}">${html(current.note)}</textarea>
        </div>`;
    }).join('') || '<p class="empty">В этой подгруппе нет студентов.</p>';
  }
  function refreshTopics() {
    const kind = activeType === 'Г' ? 'lecture' : ['П1','П2'].includes(activeType) ? 'practice' : '';
    const available = state.data.topics.filter(topic => topic.kind === kind && (!topic.archived || topic.id === existing?.topicId) &&
      (topic.id === existing?.topicId || !state.data.lessons.some(lesson => lesson.type === activeType && lesson.topicId === topic.id)));
    if (!available.some(topic => topic.id === topicId)) topicId = '';
    $('lesson-topic').disabled = !kind;
    $('lesson-topic').innerHTML = '<option value="">Без темы</option>' + available.map(topic =>
      `<option value="${html(topic.id)}" ${topic.id === topicId ? 'selected' : ''}>${html(topic.title + (topic.archived ? ' (архив)' : ''))}</option>`).join('');
  }
  openDialog(existing ? 'Редактировать занятие' : 'Новое занятие',
    `<div class="lesson-fields"><label class="field">Дата<input id="lesson-date" type="date" required value="${html(specialDate)}"></label>
      <label class="field">Тип<select id="lesson-type">${typeSelect(initialType)}</select></label>
      <label class="field">Тема<select id="lesson-topic" aria-label="Тема"></select></label></div>
      <label class="field">Комментарий к занятию<textarea id="lesson-note" maxlength="${Math.max(5000, existing?.note.length || 0)}">${html(existing?.note)}</textarea></label>
      <div><h3>Студенты</h3><p class="hint">Без оценки студент считается присутствовавшим.</p></div>
      <div id="lesson-roster" class="editor-roster"></div>`,
    (existing ? '<button id="lesson-delete" type="button" class="danger">Удалить занятие</button>' : '') +
      '<button class="primary">Сохранить</button>',
    () => {
      captureRoster();
      const changes = students.filter(student => applies(student, activeType)).flatMap(student => {
        const before = existing ? mark(existing, student) : { value: '', note: '' };
        const draft = drafts.get(student.id);
        return draft.value === before.value && draft.note === before.note ? [] : [{ studentId: student.id, ...draft }];
      });
      mutate('saveLesson', { groupId, newId, id: existing?.id, version: existing?.version, changes,
        type: activeType, date: $('lesson-date').value, topicId: $('lesson-topic').value, note: $('lesson-note').value }, 'Занятие сохранено.');
    });
  refreshTopics();
  refreshRoster();
  $('lesson-type').onchange = event => {
    captureRoster();
    topicId = $('lesson-topic').value;
    activeType = event.target.value;
    refreshTopics();
    refreshRoster();
  };
  if (existing) {
    $('lesson-delete').onclick = () => confirmDelete('deleteLesson', { groupId, id: existing.id, version: existing.version },
      'Занятие исчезнет из журнала вместе с оценками и комментариями в этом столбце.',
      'Занятие удалено.', () => editLesson(existing, studentId));
  }
  if (studentId) {
    const row = [...$('lesson-roster').children].find(item => item.dataset.roster === studentId);
    row?.querySelector('select').focus();
  }
}

const weekdayNames = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
const baseTimes = ['08:30–10:00','10:20–11:50','12:30–14:00','14:10–15:40'];
const specialTimes = { 2: ['08:30–10:00','10:20–11:50','13:20–14:50','15:00–16:30'],
  6: ['08:30–10:00','10:20–11:40','12:10–13:40','13:50–15:20'] };
async function openSchedule() {
  openDialog('Расписание', '<p role="status">Загружаем расписание…</p>');
  try {
    const data = await api('schedule');
    if (!dialog.open || $('dialog-title').textContent !== 'Расписание') return;
    $('dialog-body').innerHTML = `<label class="field">Неделя<select id="schedule-week">
      <option value="all">Все недели</option><option value="1">Нечётная</option><option value="0">Чётная</option>
      </select></label><div id="schedule-grid" class="schedule-grid"></div>`;
    const selector = $('schedule-week');
    selector.value = data.parity === 'нечетная' ? '1' : data.parity === 'четная' ? '0' : 'all';
    const render = () => {
      $('schedule-grid').innerHTML = weekdayNames.map((day, index) => {
        const dayNumber = index + 1;
        const items = data.items.filter(item => item.day === dayNumber &&
          (selector.value === 'all' || ![0,1].includes(item.week) || String(item.week) === selector.value)).sort((a,b) => a.pair-b.pair);
        const times = specialTimes[dayNumber] || baseTimes;
        return `<section class="schedule-day"><h3>${day}</h3>${items.map(item =>
          `<div class="schedule-line"><strong>${item.pair} пара · ${times[item.pair - 1]}</strong>
          <div>${html([item.group, item.subject].filter(Boolean).join(' · ')) || 'Занятие'}</div>
          <small>${html([item.room ? 'Каб. ' + item.room : '', item.week === 1 ? 'Нечётная' : item.week === 0 ? 'Чётная' : 'Каждую неделю'].filter(Boolean).join(' · '))}</small></div>`).join('')
          || '<p class="hint">Нет занятий</p>'}</section>`;
      }).join('');
    };
    selector.onchange = render;
    render();
  } catch (error) {
    if (dialog.open && $('dialog-title').textContent === 'Расписание') $('dialog-body').textContent = error.message;
  }
}

function openRoulette() {
  const { students, lessons } = state.data;
  const options = ordered(lessons).reverse();
  const current = options.find(lesson => lesson.date === today());
  openDialog('Рулетка', `<label class="field">Кого включить<select id="roulette-lesson">
    <option value="">Вся группа</option>${options.map(lesson => `<option value="${html(lesson.id)}" ${lesson === current ? 'selected' : ''}>
      ${fullDate(lesson.date)} · ${html(lesson.type)}${lesson.topicId ? ' · ' + html(topicName(lesson.topicId)) : ''}</option>`).join('')}</select></label>
    <p id="roulette-count" class="hint"></p><p id="roulette-result" class="roulette-result" aria-live="polite">Кого вызовем?</p>`,
    '<button class="primary" id="spin">Выбрать студента</button>', () => {
      const pool = candidates();
      if (!pool.length) return;
      const index = Math.floor(Math.random() * pool.length);
      $('roulette-result').textContent = studentName(pool[index]);
    });
  const candidates = () => {
    const lesson = options.find(item => item.id === $('roulette-lesson').value);
    return lesson ? students.filter(student => applies(student, lesson.type) && !absent(mark(lesson, student).value)) : students;
  };
  const refresh = () => {
    const pool = candidates();
    $('roulette-count').textContent = ( $('roulette-lesson').value ? 'Присутствующих: ' : 'Студентов: ') + pool.length;
    $('roulette-result').textContent = pool.length ? 'Кого вызовем?' : 'Нет кандидатов';
    $('spin').disabled = !pool.length;
  };
  $('roulette-lesson').onchange = refresh;
  refresh();
}

function downloadCsv() {
  const { group, students, lessons } = state.data;
  const sequence = ordered(lessons);
  const slots = Math.max(32, sequence.length);
  const row = () => Array(5 + slots).fill('');
  const rows = Array.from({ length: 10 }, row);
  const dated = sequence.filter(lesson => lesson.date);
  const academicYear = lesson => Number(lesson.date.slice(0,4)) - (Number(lesson.date.slice(5,7)) < 8 ? 1 : 0);
  const year = dated.length ? ' ' + academicYear(dated[0]) + '/' + (academicYear(dated.at(-1)) + 1) + ' учебный год' : '';
  rows[0][0] = '^next_part^';
  rows[1][0] = 'Группа: ' + group.name + year;
  rows[2][0] = 'Дисциплина: ' + group.subject;
  rows[4][0] = 'ФИО преподавателя:';
  rows[6][0] = '№ п/п';
  rows[6][1] = 'Месяц';
  rows[6][3 + slots] = 'Сред. балл:';
  rows[6][4 + slots] = '1 сем';
  rows[7][1] = 'Число';
  rows[8][1] = 'Фамилия и имя учащегося';
  let previous = '';
  sequence.forEach((lesson, index) => {
    if (!lesson.date) return;
    const month = lesson.date.slice(0, 7);
    if (month !== previous) rows[6][index + 3] = months[Number(month.slice(5)) - 1];
    rows[7][index + 3] = String(Number(lesson.date.slice(8)));
    previous = month;
  });
  students.forEach((student, index) => {
    const line = row();
    line[0] = String(index + 1);
    line[1] = studentName(student);
    const grades = [];
    sequence.forEach((lesson, lessonIndex) => {
      const value = mark(lesson, student).value;
      line[3 + lessonIndex] = value;
      const grade = gradeNumber(value);
      if (grade !== null) grades.push(grade);
    });
    if (grades.length) line[3 + slots] = (grades.reduce((sum, grade) => sum + grade, 0) / grades.length).toFixed(2).replace('.', ',');
    rows.push(line);
  });
  const escape = value => {
    const text = /^[\s]*[=+\-@\t\r\n]/.test(value) ? "'" + value : value;
    return /[;"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  const blob = new Blob(['\uFEFF', rows.map(line => line.map(escape).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = ('Журнал_' + group.name + '_' + group.subjectCode).replace(/[^\p{L}\p{N}_-]+/gu, '_') + '.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('sign-in').onclick = signIn;
$('sign-out').onclick = async () => {
  const pending = api('logout');
  showSignIn();
  await pending.catch(() => {});
};
$('courses').onclick = event => {
  const tab = event.target.closest('[data-course]');
  if (tab) selectCourse(tab);
};
$('courses').onkeydown = event => {
  const tabs = [...$('courses').querySelectorAll('[data-course]')];
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  const last = tabs.length - 1;
  const target = {
    ArrowLeft: (index + last) % tabs.length, ArrowRight: (index + 1) % tabs.length,
    Home: 0, End: last
  }[event.key];
  if (typeof target !== 'number') return;
  event.preventDefault();
  selectCourse(tabs[target]);
};
$('groups').onclick = event => {
  const button = event.target.closest('[data-group]');
  if (button) loadGroup(button.dataset.group);
};
$('refresh').onclick = () => loadGroup(state.selected, true, 'Журнал обновлён.');
$('download').onclick = downloadCsv;
$('schedule').onclick = openSchedule;
$('settings').onclick = openSettings;
$('roulette').onclick = openRoulette;
$('new-lesson').onclick = () => editLesson();
$('tabs').onclick = event => {
  const button = event.target.closest('[data-tab]');
  if (button) {
    state.tab = button.dataset.tab;
    renderTab();
  }
};
$('content').addEventListener('input', event => {
  if (event.target.id === 'student-search') {
    state.query = event.target.value;
    matrixBody();
  }
});
$('content').addEventListener('change', event => {
  if (event.target.id === 'period-filter') state.period = event.target.value;
  else if (event.target.id === 'type-filter') state.type = event.target.value;
  else return;
  matrixBody(true);
});
$('content').onclick = event => {
  const action = event.target.closest('button');
  if (!action || action.disabled) return;
  if (action.dataset.lesson) editLesson(state.data.lessons.find(item => item.id === action.dataset.lesson), action.dataset.student);
  if (action.dataset.newTopic) editTopic(action.dataset.newTopic);
  if (action.dataset.topic) {
    const topic = state.data.topics.find(item => item.id === action.dataset.topic);
    editTopic(topic.kind, topic);
  }
};
$('dialog-close').onclick = () => dialog.close();
dialog.addEventListener('cancel', event => {
  if (form.dataset.busy === 'true') event.preventDefault();
});
applyPreferences();
init().catch(error => showSignIn(error.message));
