'use strict';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, symbol => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[symbol]);
const sync = MobileJournalSync;
const themes = { default: ['Стандартная', '#0b0e14'], win98: ['Windows 98', '#000080'], business: ['Деловая', '#ffffff'] };
const typeLabels = { 'Г': 'Л', 'П1': 'П1', 'П2': 'П2', 'ИН': 'Ин' };
const typeClasses = { 'Г': 't-G', 'П1': 't-P1', 'П2': 't-P2', 'ИН': 't-IN' };
const state = {
  token: '', owner: '', epoch: 0, screen: 'groups', groups: [], groupId: '', studentId: '',
  groupsQuery: '', directoryQuery: '', studentQuery: '', subgroup: '', fromDirectory: false,
  cache: new Map(), requests: new Map(), drafts: new Map(), queue: [], storage: null,
  loading: false, syncing: false, sending: false, directoryLoading: false,
  error: '', directoryError: '', syncError: ''
};
let writeChain = Promise.resolve();
let timer = null;
let toastTimer = null;
let retry = 1500;
let installPrompt = null;
let screenRequest = 0;

const fullname = student => [student.surname, student.name, student.patronymic].filter(Boolean).join(' ');
const shortname = student => [student.surname, student.name].filter(Boolean).join(' ');
const normalize = value => String(value).trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
const dateLabel = iso => iso ? iso.split('-').reverse().join('.') : 'Без даты';
const groupData = () => state.cache.get(state.groupId);
const currentStudent = () => groupData()?.students.find(student => student.id === state.studentId);
const currentDrafts = () => [...state.drafts.values()].filter(draft => draft.groupId === state.groupId && draft.studentId === state.studentId);
const keyFor = lesson => sync.cellKey(state.groupId, lesson.id, state.studentId);
const queuedFor = key => state.queue.findLast(operation => operation.key === key);
const gradeFor = (data, lesson, studentId) => {
  const key = sync.cellKey(data.group.id, lesson.id, studentId);
  return state.drafts.get(key)?.value ?? queuedFor(key)?.value ?? sync.mark(lesson, studentId);
};

function toast(message, kind = '') {
  clearTimeout(toastTimer);
  const node = $('toast');
  node.textContent = message;
  node.className = 'show ' + kind;
  toastTimer = setTimeout(() => { node.className = ''; }, 4200);
}

function applyTheme(theme) {
  const selected = Object.hasOwn(themes, theme) ? theme : 'default';
  document.documentElement.dataset.theme = selected;
  document.querySelector('meta[name="theme-color"]').content = themes[selected][1];
  for (const button of $('theme-options').querySelectorAll('[data-theme-option]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeOption === selected));
  }
}

function initThemes() {
  $('theme-options').innerHTML = Object.entries(themes).map(([key, [name]]) => `
    <button type="button" class="theme-choice" data-action="theme" data-theme-option="${key}" aria-pressed="false">
      <span class="theme-preview preview-${key}" aria-hidden="true"><span class="theme-preview-bar"></span>
        <span class="theme-preview-cols"><span class="theme-preview-tile"></span><span class="theme-preview-tile"></span></span></span>
      <span class="theme-choice-name">${name}</span><span class="theme-choice-check" aria-hidden="true">✓</span>
    </button>`).join('');
  try { applyTheme(localStorage.getItem('journal.mobile.theme')); } catch { applyTheme('default'); }
}

function showSignIn(message = '') {
  state.epoch++;
  screenRequest++;
  clearTimeout(timer);
  state.storage?.close();
  Object.assign(state, {
    token: '', owner: '', groups: [], groupId: '', studentId: '', storage: null, screen: 'groups',
    directoryQuery: '', studentQuery: '', groupsQuery: '', subgroup: '', fromDirectory: false,
    cache: new Map(), requests: new Map(), drafts: new Map(), queue: [],
    error: '', directoryError: '', syncError: '', syncing: false, sending: false, loading: false, directoryLoading: false
  });
  writeChain = Promise.resolve();
  for (const panel of [$('queue-panel'), $('theme-panel')]) if (panel.open) panel.close();
  $('queue-content').replaceChildren();
  $('mobile-account').textContent = '';
  $('toast').textContent = '';
  $('storage-alert').hidden = true;
  $('sync-btn').hidden = $('refresh-btn').hidden = $('logout-btn').hidden = $('mobile-account').hidden = $('sendbar').hidden = true;
  showPageLoading();
  $('app').innerHTML = `<section class="card auth-mobile">
    <h1>Мобильный журнал</h1><p>Войдите через разрешённый аккаунт Google.</p>
    ${message ? `<p class="auth-message" role="status">${escape(message)}</p>` : ''}
    <button type="button" class="mobile-primary" data-action="signin">Войти через Google</button>
    ${JournalAuth.token() ? '<button type="button" class="sync-action" data-action="boot">Повторить проверку</button>' : ''}
    </section>`;
}

async function api(action, fields, epoch = state.epoch) {
  try {
    const value = await JournalAuth.request(action, fields, state.token);
    if (epoch !== state.epoch) throw new DOMException('Сеанс изменился', 'AbortError');
    return value;
  } catch (error) {
    if (epoch === state.epoch && ['AUTH', 'FORBIDDEN'].includes(error.code)) {
      JournalAuth.clear();
      showSignIn(error.message);
    }
    throw error;
  }
}

async function boot() {
  const token = JournalAuth.token();
  if (!token) { showSignIn(); return; }
  if (state.owner || state.token) return;
  const epoch = ++state.epoch;
  state.token = token;
  $('app').replaceChildren();
  showPageLoading('Проверяем доступ…');
  try {
    const account = await api('session', {}, epoch);
    state.owner = account.email;
    try {
      const storage = await MobileJournalStorage.open(state.owner);
      if (epoch !== state.epoch) { storage.close(); return; }
      state.storage = storage;
      const local = await storage.read();
      if (epoch !== state.epoch) return;
      state.drafts = new Map(local.drafts.map(draft => [draft.key, draft]));
      state.queue = local.queue;
    } catch (error) {
      if (epoch === state.epoch) storageError(error);
    }
    if (epoch !== state.epoch) return;
    $('mobile-account').textContent = state.owner;
    $('sync-btn').hidden = $('refresh-btn').hidden = $('logout-btn').hidden = $('mobile-account').hidden = false;
    await loadGroups();
    scheduleSync();
  } catch (error) {
    if (epoch === state.epoch) showSignIn(error.message);
  }
}

async function loadGroups() {
  const epoch = state.epoch;
  state.loading = true;
  state.error = '';
  render();
  try {
    state.groups = await api('groups', {}, epoch);
  } catch (error) {
    if (epoch === state.epoch) state.error = error.message;
  } finally {
    if (epoch === state.epoch) { state.loading = false; render(); }
  }
  if (state.directoryQuery) loadDirectory();
}

function showPageLoading(label = '') {
  const node = $('page-loading');
  node.hidden = !label;
  node.textContent = label;
  if (label) node.insertAdjacentHTML('afterbegin', JOURNAL_LOADER);
}

function failure(message, action = 'refresh') {
  return `<div class="error-box" role="status">${escape(message)}<button type="button" data-action="${action}">Повторить</button></div>`;
}

function getGroup(groupId, refresh = false) {
  if (!refresh && state.cache.has(groupId)) return Promise.resolve(state.cache.get(groupId));
  if (state.requests.has(groupId)) return state.requests.get(groupId);
  const epoch = state.epoch;
  const request = api('group', { groupId }, epoch).then(data => {
    if (data?.group?.id !== groupId) throw new Error('Сервер вернул другую группу.');
    state.cache.set(groupId, data);
    return data;
  }).finally(() => {
    if (epoch === state.epoch) state.requests.delete(groupId);
  });
  state.requests.set(groupId, request);
  return request;
}

async function loadDirectory() {
  if (state.directoryLoading || !state.directoryQuery || !state.groups.length) return;
  const missing = state.groups.filter(group => !state.cache.has(group.id));
  if (!missing.length) return;
  const epoch = state.epoch;
  state.directoryLoading = true;
  state.directoryError = '';
  renderDirectory();
  const errors = [];
  const worker = async () => {
    while (missing.length && epoch === state.epoch) {
      const group = missing.shift();
      try { await getGroup(group.id); } catch (error) { errors.push(error.message); }
      if (epoch === state.epoch) renderDirectory();
    }
  };
  await Promise.all([worker(), worker()]);
  if (epoch !== state.epoch) return;
  state.directoryLoading = false;
  state.directoryError = errors.length ? 'Часть групп пока недоступна для поиска.' : '';
  renderDirectory();
}

async function openGroup(groupId, studentId = '', fromDirectory = false) {
  if (!state.groups.some(group => group.id === groupId)) return;
  const sequence = ++screenRequest;
  Object.assign(state, {
    groupId, studentId, fromDirectory, subgroup: '', studentQuery: '', error: '',
    screen: studentId ? 'student' : 'students', loading: !state.cache.has(groupId)
  });
  render('forward');
  window.scrollTo(0, 0);
  try {
    await getGroup(groupId);
  } catch (error) {
    if (sequence === screenRequest) state.error = error.message;
  } finally {
    if (sequence === screenRequest) { state.loading = false; render(); }
  }
}

async function refresh() {
  if (state.screen === 'groups') {
    const old = state.cache;
    state.cache = new Map();
    await loadGroups();
    if (!state.error) return;
    if (state.owner) { state.cache = old; render(); }
    return;
  }
  const groupId = state.groupId;
  const sequence = ++screenRequest;
  state.error = '';
  state.loading = !groupData();
  render();
  try { await getGroup(groupId, true); }
  catch (error) {
    if (sequence === screenRequest) state.error = error.message;
  } finally {
    if (sequence === screenRequest) { state.loading = false; render(); }
  }
}

function back() {
  screenRequest++;
  if (state.screen === 'student' && !state.fromDirectory) {
    state.screen = 'students';
    state.studentId = '';
  } else {
    state.screen = 'groups';
    state.groupId = state.studentId = '';
  }
  state.error = '';
  state.loading = false;
  render('back');
  window.scrollTo(0, 0);
}

function storageError(error) {
  const banner = $('storage-alert');
  banner.textContent = 'Не удалось сохранить данные в памяти телефона. ' + (error?.message || '');
  banner.hidden = false;
}

async function setGrade(lessonId, value) {
  if (!state.storage || state.sending || !sync.grades.includes(value)) return;
  const data = groupData();
  const student = currentStudent();
  const lesson = data?.lessons.find(item => item.id === lessonId);
  if (!lesson || !student || !sync.allows(student, lesson)) return;
  const key = keyFor(lesson);
  const previous = state.drafts.get(key);
  const expectedValue = previous?.expectedValue ?? queuedFor(key)?.value ?? sync.mark(lesson, student.id);
  const draft = previous?.value === value || value === expectedValue ? null : {
    id: crypto.randomUUID(), key, groupId: data.group.id, lessonId: lesson.id, studentId: student.id,
    lessonDate: lesson.date, lessonType: lesson.type, expectedValue, value
  };
  if (draft) state.drafts.set(key, draft); else state.drafts.delete(key);
  updateStudent();
  renderSync();
  const epoch = state.epoch;
  const storage = state.storage;
  writeChain = writeChain.catch(() => {}).then(() => storage.changeDraft(key, draft));
  try { await writeChain; }
  catch (error) {
    if (epoch !== state.epoch) return;
    storageError(error);
    const local = await storage.read();
    if (epoch !== state.epoch) return;
    state.drafts = new Map(local.drafts.map(item => [item.key, item]));
    render();
  }
}

async function enqueue() {
  const drafts = currentDrafts();
  if (!state.storage || state.sending || !drafts.length) return;
  const epoch = state.epoch;
  const storage = state.storage;
  state.sending = true;
  renderSendbar();
  try {
    await writeChain;
    await storage.enqueue(drafts);
    const local = await storage.read();
    if (epoch !== state.epoch) return;
    state.drafts = new Map(local.drafts.map(item => [item.key, item]));
    state.queue = local.queue;
    $('storage-alert').hidden = true;
    toast('Оценки добавлены в очередь', 'ok');
    scheduleSync();
  } catch (error) {
    if (epoch === state.epoch) storageError(error);
  } finally {
    if (epoch === state.epoch) { state.sending = false; updateStudent(); renderSync(); }
  }
}

function scheduleSync(delay = 0) {
  clearTimeout(timer);
  if (state.owner && state.storage && navigator.onLine) timer = setTimeout(processQueue, delay);
}

async function processQueue() {
  if (state.syncing || !state.storage || !navigator.onLine) return;
  const epoch = state.epoch;
  const storage = state.storage;
  let lockedElsewhere = false;
  state.syncing = true;
  renderSync();
  const run = async () => {
    if (epoch !== state.epoch) return;
    const { queue } = await storage.read();
    if (epoch !== state.epoch) return;
    state.queue = queue;
    const batch = sync.nextBatch(queue);
    if (!batch.length) return;
    let data;
    try { data = await getGroup(batch[0].groupId, true); }
    catch (error) {
      if (error.code !== 'NOT_FOUND') throw error;
      await storage.resolveQueue([], batch.map(op => ({ ...op, status: 'invalid', error: error.message })));
      return;
    }
    await sync.sendBatch(batch, data, fields => api('saveLesson', fields, epoch),
      (confirmed, rejected) => storage.resolveQueue(confirmed, rejected));
  };
  try {
    if (navigator.locks) {
      await navigator.locks.request('journal-mobile-sync:' + state.owner, { ifAvailable: true }, lock => {
        if (lock) return run();
        lockedElsewhere = true;
      });
    } else await run();
    if (epoch !== state.epoch) return;
    state.syncError = '';
    retry = lockedElsewhere ? 1200 : 1500;
  } catch (error) {
    if (epoch !== state.epoch) return;
    state.syncError = error.message;
    retry = Math.min(retry * 2, 60000);
  } finally {
    if (epoch === state.epoch) {
      try {
        const local = await storage.read();
        if (epoch === state.epoch) state.queue = local.queue;
      } catch (error) { if (epoch === state.epoch) storageError(error); }
      if (epoch === state.epoch) {
        state.syncing = false;
        if (state.screen === 'student') updateStudent();
        else if (state.screen === 'students') renderStudentList();
        renderSync();
        if (sync.nextBatch(state.queue)) scheduleSync(state.syncError || lockedElsewhere ? retry : 80);
      }
    }
  }
}

const badge = subgroup => ['1', '2'].includes(subgroup)
  ? `<span class="badge b${subgroup}">П${subgroup}</span>`
  : '<span class="badge b0">без П</span>';

function listItem({ action, groupId, studentId, title, subtitle, groupBadge = '' }) {
  return `<button type="button" class="card list-item" data-action="${action}"
    data-group="${escape(groupId)}" data-student="${escape(studentId)}">
    <span class="list-content"><span class="li-name">${escape(title)}</span><span class="li-sub">${escape(subtitle)}</span></span>
    ${groupBadge}<span class="chev" aria-hidden="true">›</span></button>`;
}

function renderDirectory() {
  const content = $('directory-results');
  if (!content) return;
  const query = normalize(state.directoryQuery);
  if (!query) { content.replaceChildren(); return; }
  const matches = state.groups.flatMap(group => (state.cache.get(group.id)?.students || [])
    .filter(student => normalize(fullname(student)).includes(query))
    .map(student => ({ group, student })));
  const status = state.directoryLoading ? `<div class="global-search-hint loading-status" role="status">${JOURNAL_LOADER}Загружаем список студентов…</div>`
    : state.directoryError ? failure(state.directoryError, 'directory')
    : matches.length ? '' : '<div class="global-search-hint">Студенты не найдены.</div>';
  content.innerHTML = status + (matches.length ? `<div class="global-result-count">Найдено: ${matches.length}${matches.length > 40 ? ' · показаны первые 40' : ''}</div>
    <div class="global-results">${matches.slice(0, 40).map(({ group, student }) => listItem({
      action: 'global-student', groupId: group.id, studentId: student.id,
      title: fullname(student), subtitle: group.name + ' · ' + group.subject, groupBadge: badge(student.subgroup)
    })).join('')}</div>` : '');
}

function renderGroupList() {
  const node = $('group-list');
  if (!node) return;
  const query = normalize(state.groupsQuery);
  const groups = state.groups.filter(group => normalize(group.name + ' ' + group.subject).includes(query));
  node.innerHTML = groups.map(group => listItem({
    action: 'group', groupId: group.id, title: group.name, subtitle: group.subject
  })).join('') || (state.loading || state.error ? '' : '<div class="empty">Группы не найдены.</div>');
}

function renderGroups() {
  $('app').innerHTML = `<section class="card global-search-card">
    <div class="global-search-title">Поиск студента во всех группах</div>
    <input id="directory-query" class="search" type="search" autocomplete="off"
      aria-label="Поиск студента во всех группах" placeholder="Фамилия, имя или отчество" value="${escape(state.directoryQuery)}">
    <div id="directory-results"></div>
    </section>
    <h1 class="group-list-title">Выберите группу</h1>
    <input id="groups-query" class="search" type="search" aria-label="Поиск группы"
      placeholder="Поиск группы или предмета…" value="${escape(state.groupsQuery)}">
    ${state.error ? failure(state.error) : ''}
    <div id="group-list" class="list"></div>`;
  renderGroupList();
  renderDirectory();
}

function studentSummary(data, student) {
  let total = 0, graded = 0, sum = 0, abs = 0;
  for (const lesson of data.lessons) {
    if (!sync.allows(student, lesson)) continue;
    total++;
    const value = gradeFor(data, lesson, student.id);
    if (sync.normalGrade(value) === 'Н') abs++;
    if (sync.grades.includes(value)) { graded++; sum += Number(value); }
  }
  return { total, graded, avg: graded ? (sum / graded).toFixed(2) : '—', abs };
}

function renderStudentList() {
  const node = $('student-list');
  const data = groupData();
  if (!node || !data) return;
  const query = normalize(state.studentQuery);
  const students = data.students.filter(student => (!state.subgroup || student.subgroup === state.subgroup) &&
    normalize(fullname(student)).includes(query));
  node.innerHTML = students.map(student => {
    const { graded, avg, abs } = studentSummary(data, student);
    return listItem({ action: 'student', groupId: data.group.id, studentId: student.id, title: shortname(student),
      subtitle: 'оценок: ' + graded + (graded ? ' · ср. ' + avg : '') + (abs ? ' · пропусков: ' + abs : ''),
      groupBadge: badge(student.subgroup) });
  }).join('') || '<div class="empty">Студенты не найдены.</div>';
}

function pageHeading(title, subtitle, label = '') {
  return `<div class="group-head"><button type="button" class="icon-btn" data-action="back" aria-label="Назад">←</button>
    <div class="list-content"><h1 class="screen-title small">${escape(title)}</h1>
    <div class="header-sub">${escape(subtitle)}</div></div>${label}</div>`;
}

function renderStudents() {
  const group = state.groups.find(item => item.id === state.groupId);
  if (!group) { state.screen = 'groups'; renderGroups(); return; }
  const data = groupData();
  $('app').innerHTML = pageHeading(group.name, group.subject + ' · выберите студента') +
    (state.error ? failure(state.error) : '') +
    (data ? `<input class="search" id="student-query" type="search" aria-label="Поиск студента в группе"
      placeholder="Поиск студента…" value="${escape(state.studentQuery)}">
      <div class="seg" aria-label="Подгруппа">${[['', 'Все'], ['1', 'Подгр. 1'], ['2', 'Подгр. 2']].map(([value, label]) =>
        `<button type="button" data-action="subgroup" data-value="${value}" aria-pressed="${state.subgroup === value}"
          class="${state.subgroup === value ? 'on' : ''}">${label}</button>`).join('')}</div>
      <div class="list" id="student-list"></div>` : '');
  renderStudentList();
}

function lessonCard(lesson, data, student) {
  const key = keyFor(lesson);
  const draft = state.drafts.get(key);
  const queued = queuedFor(key);
  const saved = sync.normalGrade(sync.mark(lesson, student.id));
  const value = draft?.value ?? queued?.value;
  const topic = data.topics.find(item => item.id === lesson.topicId)?.title;
  const chip = draft ? '<span class="chip local-chip">Черновик</span>'
    : queued ? (queued.status === 'queued' ? '<span class="chip saving-chip">В очереди</span>'
      : '<span class="chip error-chip">Требует проверки</span>') : '';
  return `<article class="card student">
    <div class="student-top"><span class="tb ${typeClasses[lesson.type] || 't-X'}">${escape(typeLabels[lesson.type] || lesson.type || '—')}</span>
    <div class="lesson-heading"><span class="lesson-date">${escape(dateLabel(lesson.date))}</span>
    ${topic ? `<span class="lesson-topic" title="${escape(topic)}">· ${escape(topic)}</span>` : ''}</div>
    ${saved ? `<span class="chip">В журнале: ${escape(saved)}</span>` : ''}${chip}</div>
    <div class="grades">${sync.grades.map(grade => `<button type="button" class="grade-btn g${grade} ${value === grade ? 'active' : ''}"
      data-action="grade" data-lesson="${escape(lesson.id)}" data-value="${grade}" aria-pressed="${value === grade}"
      aria-label="${grade} · ${escape(dateLabel(lesson.date))}" ${!state.storage || state.sending ? 'disabled' : ''}>${grade}</button>`).join('')}</div>
    </article>`;
}

function updateStudent() {
  const data = groupData();
  const student = currentStudent();
  if (!student || !data || !$('lesson-list')) { renderSendbar(); return; }
  const focus = document.activeElement?.dataset;
  const focusedGrade = focus?.action === 'grade' ? [focus.lesson, focus.value] : null;
  const summary = studentSummary(data, student);
  $('student-stats').innerHTML = [[summary.total, 'занятий'], [summary.graded, 'оценок'], [summary.avg, 'ср. балл'], [summary.abs, 'пропуски']]
    .map(([value, label]) => `<div class="stat-mini"><div class="v">${value}</div><div class="k">${label}</div></div>`).join('');
  const lessons = data.lessons.filter(lesson => sync.allows(student, lesson))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.position - a.position);
  $('lesson-list').innerHTML = lessons.map(lesson => lessonCard(lesson, data, student)).join('') ||
    '<div class="empty">Занятий пока нет.</div>';
  if (focusedGrade) $('lesson-list').querySelector(`[data-lesson="${CSS.escape(focusedGrade[0])}"][data-value="${CSS.escape(focusedGrade[1])}"]`)?.focus({ preventScroll: true });
  renderSendbar();
}

function renderStudent() {
  const group = state.groups.find(item => item.id === state.groupId);
  const student = currentStudent();
  if (!student) {
    if (state.loading || state.error) {
      $('app').innerHTML = pageHeading(group?.name || '', '') + (state.error ? failure(state.error) : '');
      return;
    }
    state.screen = 'students';
    renderStudents();
    return;
  }
  $('app').innerHTML = pageHeading(shortname(student), group.name + ' · ' + group.subject, badge(student.subgroup)) +
    (state.error ? failure(state.error) : '') +
    '<div class="stats-row" id="student-stats"></div><div class="students" id="lesson-list"></div>';
  updateStudent();
}

function renderSendbar() {
  const student = state.owner && state.screen === 'student' ? currentStudent() : null;
  $('sendbar').hidden = !student;
  if (!student) return;
  const count = currentDrafts().length;
  $('send-info').textContent = count ? student.surname + ': черновиков — ' + count : 'Выберите оценку на карточке занятия';
  const button = $('send-btn');
  button.textContent = state.sending ? 'Сохраняем…' : 'Отправить в очередь' + (count ? ' (' + count + ')' : '');
  button.disabled = !state.storage || !count || state.sending;
  button.classList.toggle('loading-status', state.sending);
  if (state.sending) button.insertAdjacentHTML('afterbegin', JOURNAL_LOADER);
}

function render(direction = '') {
  if (!state.owner) return;
  if (state.screen === 'groups') renderGroups();
  else if (state.screen === 'students') renderStudents();
  else renderStudent();
  $('app').className = direction ? 'page-enter-' + direction : '';
  showPageLoading(state.loading ? (state.screen === 'groups' ? 'Загружаем группы…' : 'Загружаем журнал…') : '');
  renderSendbar();
  renderSync();
}

function currentQueueCount() {
  return state.queue.filter(op => op.status !== 'queued').length;
}

function renderSync() {
  const btn = $('sync-btn');
  const issues = currentQueueCount();
  const queued = state.queue.length;
  const sending = Boolean(state.storage && !issues && navigator.onLine && state.syncing && queued);
  btn.className = 'sync-btn' + (issues ? ' error' : queued ? ' attention' : '');
  btn.textContent = !state.storage ? 'Ошибка памяти' : issues ? 'Проверить: ' + issues
    : !navigator.onLine ? 'Офлайн' + (queued ? ' · ' + queued : '') : sending ? 'Отправка · ' + queued
    : queued ? 'Очередь · ' + queued : state.drafts.size ? 'Черновики · ' + state.drafts.size : '✓ Всё отправлено';
  if (sending) {
    btn.classList.add('loading-status');
    btn.insertAdjacentHTML('afterbegin', JOURNAL_LOADER);
  }
  if ($('queue-panel').open) renderQueue();
}

function renderQueue() {
  const count = currentQueueCount();
  $('queue-content').innerHTML = `<div class="sync-line-detail">
    Черновиков: ${state.drafts.size} · В очереди: ${state.queue.length - count} · Требуют проверки: ${count}</div>
    ${state.syncError ? `<div class="sync-line-detail">${escape(state.syncError)}</div>` : ''}
    <div class="sync-actions">
      <button type="button" data-action="sync" class="sync-action primary" ${state.syncing ? 'disabled' : ''}>Повторить отправку</button>
      <button type="button" data-action="export" class="sync-action">Скачать резервную копию</button>
      <button type="button" data-action="import" class="sync-action" ${!state.storage || state.syncing ? 'disabled' : ''}>Восстановить из копии</button>
    </div>
    ${state.queue.map(op => {
      const data = state.cache.get(op.groupId);
      const group = state.groups.find(item => item.id === op.groupId);
      const student = data?.students.find(item => item.id === op.studentId);
      return `<div class="sync-line">
        <div class="sync-line-title">${escape(student ? shortname(student) : 'Студент')} · ${escape(dateLabel(op.lessonDate))} · ${escape(typeLabels[op.lessonType])}</div>
        <div class="sync-line-detail">${escape(group?.name || 'Группа')} · Оценка: ${escape(op.value)}
          ${op.status === 'conflict' ? ' · Сейчас в журнале: ' + escape(sync.normalGrade(op.currentValue) || 'пусто') : ''}</div>
        ${op.error ? `<div class="sync-line-detail">${escape(op.error)}</div>` : ''}
        <div class="sync-actions">
          ${op.status === 'conflict' ? `<button type="button" data-action="overwrite" data-operation="${op.localId}"
            class="sync-action primary" ${state.syncing ? 'disabled' : ''}>Записать мою оценку</button>` : ''}
          <button type="button" data-action="discard" data-operation="${op.localId}" class="sync-action danger"
            ${state.syncing ? 'disabled' : ''}>Отменить изменение</button>
        </div></div>`;
    }).join('') || '<div class="empty">Неотправленных оценок нет.</div>'}`;
}

async function resolveOperation(localId, overwrite) {
  const storage = state.storage;
  const operation = state.queue.find(op => op.localId === localId);
  if (!storage || !operation || state.syncing) return;
  if (!overwrite && !confirm('Отменить изменения этой оценки в очереди и черновиках?')) return;
  const epoch = state.epoch;

  const apply = async () => {
    if (epoch !== state.epoch) return;
    const { queue } = await storage.read();
    const latest = queue.find(op => op.localId === localId);
    if (epoch !== state.epoch || !latest) return;
    if (overwrite) {
      if (latest.status !== 'conflict' || latest.currentValue !== operation.currentValue) {
        throw new Error('Очередь изменилась. Проверьте актуальную отметку.');
      }
      await storage.resolveQueue([], [{ ...latest, expectedValue: latest.currentValue, status: 'queued', error: '' }]);
    } else {
      await writeChain;
      await storage.resolveQueue(queue.filter(item => item.key === latest.key), [], latest.key);
    }
  };

  if (navigator.locks) await navigator.locks.request('journal-mobile-sync:' + state.owner, apply);
  else await apply();
  if (epoch !== state.epoch) return;
  const local = await storage.read();
  if (epoch !== state.epoch) return;
  state.queue = local.queue;
  state.drafts = new Map(local.drafts.map(item => [item.key, item]));
  updateStudent();
  renderSync();
  scheduleSync();
}

function backup() {
  const strip = ({ owner, localId, ...entry }) => entry;
  const contents = JSON.stringify({ format: 'journal-mobile-v1', account: state.owner,
    drafts: [...state.drafts.values()].map(strip), queue: state.queue.map(strip) }, null, 2);
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'journal-mobile-unsent.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function restore(file) {
  if (!file || !state.storage || state.syncing) return;
  const epoch = state.epoch;
  const storage = state.storage;
  if (file.size > 5242880) throw new Error('Копия слишком большая.');
  const saved = JSON.parse(await file.text());
  if (epoch !== state.epoch) return;
  if (saved?.format !== 'journal-mobile-v1' || saved.account !== state.owner ||
      !Array.isArray(saved.drafts) || !Array.isArray(saved.queue) || saved.drafts.length + saved.queue.length > 5000) {
    throw new Error('Выберите резервную копию мобильного журнала для этого Google-аккаунта.');
  }
  const validate = (item, queued) => {
    if (!item || ![item.groupId, item.lessonId, item.studentId, item.id].every(id =>
        typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)) ||
        !sync.grades.includes(item.value) || typeof item.expectedValue !== 'string' || item.expectedValue.length > 40 ||
        typeof item.lessonDate !== 'string' || !/^(?:\d{4}-\d{2}-\d{2})?$/.test(item.lessonDate) ||
        !Object.hasOwn(typeLabels, item.lessonType)) throw new Error('В копии есть повреждённые записи.');
    const { id, groupId, lessonId, studentId, lessonDate, lessonType, expectedValue, value } = item;
    return { id, groupId, lessonId, studentId, lessonDate, lessonType, expectedValue, value,
      key: sync.cellKey(groupId, lessonId, studentId), ...(queued ? { status: 'queued' } : {}) };
  };
  const drafts = saved.drafts.map(item => validate(item, false));
  const queue = [...new Map(saved.queue.map(item => { const op = validate(item, true); return [op.id, op]; })).values()];
  if (!confirm(`Восстановить черновики (${drafts.length}) и записи очереди (${queue.length})?`)) return;
  await writeChain;
  await storage.restore(drafts, queue);
  const result = await storage.read();
  if (epoch !== state.epoch) return;
  state.queue = result.queue;
  state.drafts = new Map(result.drafts.map(item => [item.key, item]));
  toast('Резервная копия восстановлена', 'ok');
  updateStudent();
  renderSync();
  scheduleSync();
}

async function install() {
  if (installPrompt) {
    await installPrompt.prompt();
    installPrompt = null;
    return;
  }
  $('install-help').textContent = /iPhone|iPad/i.test(navigator.userAgent)
    ? 'В Safari нажмите «Поделиться», затем «На экран Домой».'
    : 'Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран».';
  $('install-help').hidden = false;
}

async function logout() {
  const token = state.token;
  await writeChain.catch(storageError);
  JournalAuth.clear();
  showSignIn();
  if (token && navigator.onLine) JournalAuth.request('logout', {}, token).catch(() => {});
}

function handleAction(button) {
  const { action, group, student, value, lesson, operation, themeOption } = button.dataset;
  switch (action) {
    case 'signin':
      button.disabled = true;
      $('app').replaceChildren();
      showPageLoading('Открываем вход через Google…');
      return JournalAuth.signIn('mobile').catch(error => showSignIn(error.message));
    case 'boot': return boot();
    case 'logout': return logout();
    case 'settings': $('theme-panel').showModal(); break;
    case 'queue': if (state.owner) { renderQueue(); $('queue-panel').showModal(); } break;
    case 'close': button.closest('dialog')?.close(); break;
    case 'install': return install();
    case 'theme':
      applyTheme(themeOption);
      try { localStorage.setItem('journal.mobile.theme', themeOption); } catch { toast('Браузер не сохранил тему', 'err'); }
      $('theme-panel').close();
      break;
    case 'refresh': return refresh();
    case 'directory': return loadDirectory();
    case 'group': return openGroup(group);
    case 'global-student': return openGroup(group, student, true);
    case 'student':
      state.studentId = student;
      state.screen = 'student';
      render('forward');
      window.scrollTo(0, 0);
      break;
    case 'back': back(); break;
    case 'subgroup':
      state.subgroup = value;
      for (const option of button.parentElement.querySelectorAll('button')) {
        const active = option === button;
        option.classList.toggle('on', active);
        option.setAttribute('aria-pressed', String(active));
      }
      renderStudentList();
      break;
    case 'grade': return setGrade(lesson, value);
    case 'send': return enqueue();
    case 'sync': scheduleSync(); break;
    case 'export': if (state.owner) backup(); break;
    case 'import': $('backup-import').click(); break;
    case 'overwrite': return resolveOperation(Number(operation), true);
    case 'discard': return resolveOperation(Number(operation), false);
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  Promise.resolve().then(() => handleAction(button)).catch(error => toast(error.message, 'err'));
});

$('app').addEventListener('input', event => {
  if (event.target.id === 'directory-query') {
    state.directoryQuery = event.target.value;
    renderDirectory();
    if (state.directoryQuery.trim()) loadDirectory();
  } else if (event.target.id === 'groups-query') {
    state.groupsQuery = event.target.value;
    renderGroupList();
  } else if (event.target.id === 'student-query') {
    state.studentQuery = event.target.value;
    renderStudentList();
  }
});

$('backup-import').addEventListener('change', event => {
  restore(event.target.files[0]).catch(error => toast(error.message, 'err'));
  event.target.value = '';
});

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
window.addEventListener('online', () => {
  if (state.owner) scheduleSync();
  else if (JournalAuth.token()) boot();
  renderSync();
});
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.owner || !navigator.onLine) return;
  api('session', {}).then(() => scheduleSync()).catch(() => {});
});

initThemes();
boot();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
