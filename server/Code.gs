const TABLES = {
  Groups: ['id', 'name', 'subjectCode', 'subject'],
  Students: ['id', 'groupId', 'surname', 'name', 'patronymic', 'subgroup', 'position'],
  Topics: ['id', 'groupId', 'kind', 'title', 'position', 'unmatchedDates', 'archived', 'version'],
  Lessons: ['id', 'groupId', 'type', 'date', 'topicId', 'note', 'marks', 'position', 'archived', 'version', 'headerNote']
};
const TYPES = { 'Г': 'lecture', 'П1': 'practice', 'П2': 'practice', 'ИН': null };
const SESSION_SECONDS = 3600;

function doGet() {
  return reply_({ ok: true, service: 'journal-pilot' });
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents;
    if (!body || body.length > 180000) fail_('INPUT', 'Недопустимый размер запроса.');
    const req = JSON.parse(body);
    if (!req || typeof req !== 'object') fail_('INPUT', 'Неверный запрос.');
    if (req.action === 'login') return reply_({ ok: true, data: login_(req) });
    const account = requireSession_(req.token);
    let data;
    switch (req.action) {
      case 'session': data = { email: account.email }; break;
      case 'logout': CacheService.getScriptCache().remove(sessionKey_(req.token)); data = {}; break;
      case 'groups': data = read_('Groups').items; break;
      case 'group': data = group_(req.groupId); break;
      case 'schedule': data = schedule_(); break;
      case 'saveTopic': case 'deleteTopic': case 'saveLesson': case 'deleteLesson':
        data = locked_(() => {
          requireSession_(req.token);
          return req.action.endsWith('Topic') ? updateTopic_(req) : updateLesson_(req);
        });
        break;
      default: fail_('INPUT', 'Неизвестное действие.');
    }
    return reply_({ ok: true, data });
  } catch (error) {
    if (!error.publicCode) console.error(String(error.stack || error));
    return reply_({ ok: false, code: error.publicCode || 'SERVER',
      message: error.publicCode ? error.message : 'Ошибка сервера журнала.' });
  }
}

function reply_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const error = new Error(message);
  error.publicCode = code;
  throw error;
}

function setting_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) fail_('CONFIG', 'Настройте параметр сервера ' + key + '.');
  return value;
}

function allowed_(email) {
  return setting_('ALLOWED_GOOGLE_EMAILS').split(/[\s,;]+/)
    .some(item => item.toLowerCase() === email);
}

function login_(req) {
  if (typeof req.code !== 'string' || req.code.length < 10 || req.code.length > 2048 ||
      typeof req.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(req.verifier)) {
    fail_('AUTH', 'Начните вход в Google заново.');
  }
  const grant = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: {
      client_id: setting_('GOOGLE_CLIENT_ID'), client_secret: setting_('GOOGLE_CLIENT_SECRET'),
      redirect_uri: setting_('OAUTH_REDIRECT_URI'), code: req.code,
      code_verifier: req.verifier, grant_type: 'authorization_code'
    }
  });
  if (grant.getResponseCode() !== 200) fail_('AUTH', 'Google не подтвердил вход. Войдите заново.');
  const accessToken = JSON.parse(grant.getContentText()).access_token;
  if (typeof accessToken !== 'string' || !accessToken) fail_('AUTH', 'Google не подтвердил вход.');
  const identity = UrlFetchApp.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken }, muteHttpExceptions: true
  });
  if (identity.getResponseCode() !== 200) fail_('AUTH', 'Не удалось получить аккаунт Google.');
  const profile = JSON.parse(identity.getContentText());
  const email = String(profile.email || '').trim().toLowerCase();
  if (!profile.sub || !email || profile.email_verified !== true || !allowed_(email)) {
    fail_('FORBIDDEN', 'У этого Google-аккаунта нет доступа к журналу.');
  }
  const token = Utilities.getUuid() + Utilities.getUuid();
  const session = { email, expires: Date.now() + SESSION_SECONDS * 1000 };
  CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify(session), SESSION_SECONDS);
  return { token, email };
}

function sessionKey_(token) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  return 'session:' + Utilities.base64EncodeWebSafe(digest);
}

function requireSession_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9-]{72}$/i.test(token)) {
    fail_('AUTH', 'Войдите в Google для доступа к журналу.');
  }
  const value = CacheService.getScriptCache().get(sessionKey_(token));
  if (!value) fail_('AUTH', 'Сеанс завершён. Войдите снова.');
  const session = JSON.parse(value);
  if (session.expires <= Date.now()) fail_('AUTH', 'Сеанс завершён. Войдите снова.');
  if (!allowed_(session.email)) fail_('FORBIDDEN', 'Доступ к журналу отозван.');
  return session;
}

function locked_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) fail_('BUSY', 'Другой пользователь сохраняет данные. Повторите попытку.');
  try {
    const result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function read_(name) {
  const sheet = SpreadsheetApp.openById(setting_('DATABASE_ID')).getSheetByName(name);
  if (!sheet) fail_('CONFIG', 'В базе отсутствует лист ' + name + '.');
  const fields = TABLES[name];
  const values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), fields.length).getValues();
  if (!fields.every((key, i) => values[0][i] === key)) fail_('CONFIG', 'Проверьте заголовки листа ' + name + '.');
  return { sheet, items: values.slice(1).map((row, index) => {
    const item = Object.fromEntries(fields.map((key, i) => {
      let value = row[i];
      if (key === 'date' && value instanceof Date) value = Utilities.formatDate(value, sheet.getParent().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
      if (key === 'subgroup') value = String(value);
      if (key === 'version' || key === 'position') value = Number(value);
      if (key === 'archived') value = value === true || String(value).toLowerCase() === 'true';
      if (key === 'marks' || key === 'unmatchedDates') value = JSON.parse(value || '{}');
      return [key, value];
    }));
    Object.defineProperty(item, '_row', { value: index + 2 });
    return item;
  }).filter(item => item.id) };
}

function write_(table, name, item) {
  const row = TABLES[name].map(key => {
    const value = item[key];
    if (key === 'marks' || key === 'unmatchedDates') {
      const json = JSON.stringify(value);
      if (json.length > 48000) fail_('INPUT', 'Суммарный объём комментариев к этому занятию слишком большой.');
      return json;
    }
    return typeof value === 'string' && /^[=']/.test(value) ? "'" + value : value;
  });
  const index = item._row || table.sheet.getLastRow() + 1;
  if (index > table.sheet.getMaxRows()) table.sheet.insertRowsAfter(table.sheet.getMaxRows(), 100);
  table.sheet.getRange(index, 1, 1, row.length).setValues([row]);
  return item;
}

function getGroup_(id) {
  if (typeof id !== 'string') fail_('INPUT', 'Выберите группу.');
  const group = read_('Groups').items.find(item => item.id === id);
  if (!group) fail_('NOT_FOUND', 'Группа не найдена.');
  return group;
}

function group_(id) {
  const group = getGroup_(id);
  const belongs = item => item.groupId === group.id;
  const byPosition = (a, b) => a.position - b.position;
  return {
    group,
    students: read_('Students').items.filter(belongs).sort(byPosition),
    topics: read_('Topics').items.filter(belongs).sort(byPosition),
    lessons: read_('Lessons').items.filter(item => belongs(item) && !item.archived).sort(byPosition)
  };
}

function text_(value, max, label) {
  if (typeof value !== 'string' || value.length > max) fail_('INPUT', 'Проверьте поле «' + label + '».');
  return value;
}

function current_(rows, req) {
  if (!req.id) return null;
  const item = rows.find(row => row.id === req.id && !row.archived);
  if (!item) fail_('NOT_FOUND', 'Запись уже удалена или отсутствует.');
  if (item.version !== req.version) fail_('CONFLICT', 'Запись уже изменили. Обновите журнал и повторите правку.');
  return item;
}

function creation_(rows, req) {
  if (req.id || req.action.startsWith('delete')) return null;
  if (typeof req.newId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(req.newId)) {
    fail_('INPUT', 'Откройте форму создания заново.');
  }
  if (rows.some(row => row.id === req.newId)) {
    fail_('CONFLICT', 'Запись уже создана. Обновите журнал, чтобы увидеть результат.');
  }
  return req.newId;
}

function nextPosition_(rows, byKind) {
  return rows.filter(byKind).reduce((position, row) => Math.max(position, row.position), 0) + 1;
}

function updateTopic_(req) {
  const group = getGroup_(req.groupId);
  const table = read_('Topics');
  const rows = table.items.filter(item => item.groupId === group.id);
  const old = current_(rows, req);
  const newId = creation_(table.items, req);
  if (req.action === 'deleteTopic') {
    if (!old) fail_('INPUT', 'Выберите тему.');
    old.archived = true;
    old.version++;
    return write_(table, 'Topics', old);
  }
  const title = text_(req.title, 500, 'Тема').trim();
  const kind = req.kind;
  if (!title || !['lecture', 'practice'].includes(kind)) fail_('INPUT', 'Укажите тему и её тип.');
  if (old && old.kind !== kind) fail_('INPUT', 'Выберите тип темы при её создании.');
  const item = old || { id: newId, groupId: group.id, kind,
    position: nextPosition_(rows, row => row.kind === kind), unmatchedDates: {}, archived: false, version: 0 };
  item.title = title;
  item.version++;
  return write_(table, 'Topics', item);
}

function updateLesson_(req) {
  const group = getGroup_(req.groupId);
  const table = read_('Lessons');
  const rows = table.items.filter(item => item.groupId === group.id);
  const old = current_(rows, req);
  const newId = creation_(table.items, req);
  if (req.action === 'deleteLesson') {
    if (!old) fail_('INPUT', 'Выберите занятие.');
    old.archived = true;
    old.version++;
    return write_(table, 'Lessons', old);
  }
  if (!Object.prototype.hasOwnProperty.call(TYPES, req.type)) fail_('INPUT', 'Укажите тип занятия.');
  const date = text_(req.date, 10, 'Дата');
  const parsed = new Date(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    fail_('INPUT', 'Укажите корректную дату занятия.');
  }
  const topicId = text_(req.topicId, 80, 'Тема');
  if (topicId) {
    const topic = read_('Topics').items.find(item => item.groupId === group.id && item.id === topicId);
    if (!topic || (topic.archived && topicId !== old?.topicId) || topic.kind !== TYPES[req.type]) {
      fail_('INPUT', 'Выберите доступную тему нужного типа.');
    }
    const duplicate = rows.some(item => !item.archived && item.id !== old?.id && item.type === req.type && item.topicId === topicId);
    if (duplicate && !(old?.topicId === topicId && old.type === req.type)) {
      fail_('INPUT', 'Для этого типа занятий тема уже использована.');
    }
  }
  const students = new Map(read_('Students').items.filter(item => item.groupId === group.id).map(student => [student.id, student]));
  const marks = Object.assign(Object.create(null), old?.marks);
  if (!Array.isArray(req.changes) || req.changes.length > students.size) fail_('INPUT', 'Проверьте изменения оценок.');
  const seen = new Set();
  for (const change of req.changes) {
    const student = change && students.get(change.studentId);
    if (!student || seen.has(student.id)) fail_('INPUT', 'Проверьте список студентов.');
    seen.add(student.id);
    if (!applicable_(student, req.type)) fail_('INPUT', 'Студент в другой подгруппе.');
    const previous = marks[student.id] || {};
    const value = text_(change.value, 40, 'Оценка');
    const note = text_(change.note, Math.max(2000, String(previous.note || '').length), 'Комментарий студента');
    if (!['', '2', '3', '4', '5', 'н'].includes(value) && value !== previous.value) fail_('INPUT', 'Укажите оценку от 2 до 5 или «н».');
    if (value || note) marks[student.id] = { value, note };
    else delete marks[student.id];
  }
  if (old && old.type !== req.type && Object.keys(marks).some(id => students.has(id) && !applicable_(students.get(id), req.type))) {
    fail_('INPUT', 'Сначала очистите отметки и комментарии студентов, которые не относятся к новому типу.');
  }
  const item = old || { id: newId, groupId: group.id,
    position: nextPosition_(rows, () => true), archived: false, version: 0, headerNote: '' };
  Object.assign(item, { type: req.type, date, topicId, marks,
    note: text_(req.note, Math.max(5000, String(item.note || '').length), 'Комментарий занятия'),
    version: item.version + 1 });
  return write_(table, 'Lessons', item);
}

function applicable_(student, type) {
  return !(type === 'П1' && student.subgroup === '2') && !(type === 'П2' && student.subgroup === '1');
}

function schedule_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('schedule');
  if (cached) return JSON.parse(cached);
  const id = PropertiesService.getScriptProperties().getProperty('SCHEDULE_TEACHER_ID') || '59';
  if (!/^\d+$/.test(id)) fail_('CONFIG', 'Проверьте номер преподавателя для расписания.');
  const base = 'http://scheduleapi.iek.irk.ru/API/';
  try {
    const responses = UrlFetchApp.fetchAll([
      { url: base + 'GetSettings', muteHttpExceptions: true },
      { url: base + 'TeacherScheduleByID?id=' + id, muteHttpExceptions: true }
    ]);
    if (responses[1].getResponseCode() !== 200) throw new Error('Schedule unavailable');
    const settings = responses[0].getResponseCode() === 200 ? JSON.parse(responses[0].getContentText()) : [];
    const parityText = String(settings?.[0]?.parityWeek || '').toLowerCase().replace(/ё/g, 'е');
    const [year, month] = Utilities.formatDate(new Date(), 'Asia/Irkutsk', 'yyyy-MM').split('-').map(Number);
    const academicYear = month >= 9 ? year : year - 1;
    const result = {
      parity: ['четная', 'нечетная'].includes(parityText) ? parityText : '',
      items: JSON.parse(responses[1].getContentText()).map(item => ({
        day: Number(item.dayOfWeek), pair: Number(item.numberPair), week: item.typeWeek == null ? -1 : Number(item.typeWeek),
        group: scheduleGroup_(item.group, academicYear),
        subject: String(item.pair?.name || ''), room: String(item.numberRoom || '')
      })).filter(item => item.day >= 1 && item.day <= 6 && item.pair >= 1 && item.pair <= 4)
    };
    cache.put('schedule', JSON.stringify(result), 300);
    return result;
  } catch (_) {
    fail_('SCHEDULE', 'Источник расписания сейчас недоступен.');
  }
}

function scheduleGroup_(group, academicYear) {
  if (typeof group === 'string') return group;
  const abbreviation = String(group?.nameNavigation?.nameGroup || '').trim();
  const course = Number(group?.numberCourse);
  if (abbreviation && Number.isInteger(course) && course > 0) {
    return `${course}${abbreviation}-${String(academicYear - course + 1).slice(-2)}`;
  }
  return String(group?.name || group?.number || '');
}
