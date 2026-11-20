const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');

const code = readFileSync(join(__dirname, '../server/Code.gs'), 'utf8');
const TABLES = {
  Groups: [['id','name','subjectCode','subject'], ['group','Пилот','ИТ','Информационные технологии']],
  Students: [['id','groupId','surname','name','patronymic','subgroup','position'],
    ['s1','group','Тестов','Первый','','1',1], ['s2','group','Тестов','Второй','','2',2]],
  Topics: [['id','groupId','kind','title','position','unmatchedDates','archived','version']],
  Lessons: [['id','groupId','type','date','topicId','note','marks','position','archived','version','headerNote']]
};
const properties = { DATABASE_ID: 'test', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test',
  OAUTH_REDIRECT_URI: 'https://example.test/', ALLOWED_GOOGLE_EMAILS: 'teacher@example.test' };

function server() {
  const tables = structuredClone(TABLES);
  const settings = { ...properties };
  const cache = new Map();
  let reads = 0;
  const response = (data, status = 200) => ({ getResponseCode: () => status, getContentText: () => JSON.stringify(data) });
  const context = {
    console, Date,
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    Utilities: {
      formatDate: () => '2026-11',
      getUuid: crypto.randomUUID, DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algorithm, text) => crypto.createHash(algorithm).update(text).digest(),
      base64EncodeWebSafe: bytes => bytes.toString('base64url')
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => settings[key] }) },
    CacheService: { getScriptCache: () => ({
      get: key => cache.get(key), put: (key, value) => cache.set(key, value), remove: key => cache.delete(key)
    }) },
    UrlFetchApp: {
      fetch: (url, options) => {
        if (url.endsWith('/token')) {
          assert.equal(options.payload.code_verifier.length, 43);
          assert.equal(options.payload.redirect_uri, 'https://example.test/');
          return response({ access_token: options.payload.code });
        }
        assert.match(url, /\/userinfo$/);
        const code = options.headers.Authorization.slice(7);
        return response({ sub: 'test-user', email: code === 'valid-code-for-teacher' ? 'Teacher@example.test' : 'visitor@example.test',
          email_verified: code !== 'unverified-code' });
      },
      fetchAll: () => [response([{ parityWeek: 'нечётная' }]), response([{ dayOfWeek: 1, numberPair: 2, typeWeek: null,
        group: { name: 5, numberCourse: 2, nameNavigation: { nameGroup: 'ТИТО' } }, pair: { name: 'Информатика' }, numberRoom: '5' }])]
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { flush() {}, openById: () => {
      reads++;
      return { getSheetByName: name => {
        const table = tables[name];
        return {
          getLastRow: () => table.length, getMaxRows: () => 1000,
          getRange: row => ({
            getValues: () => structuredClone(table),
            setValues: values => { table[row - 1] = values[0].map(value => typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value); }
          })
        };
      } };
    } }
  };
  const handler = runInNewContext(code + '\n;doPost', context);
  const call = (action, fields) => JSON.parse(handler({ postData: { contents: JSON.stringify({ action, ...fields }) } }));
  const login = (code = 'valid-code-for-teacher') => call('login', { code, verifier: 'a'.repeat(43) });
  return { call, settings, login, reads: () => reads };
}

test('API denies anonymous access, rejects unlisted accounts and revokes sessions', () => {
  const { call, login, settings, reads } = server();
  for (const action of ['groups','group','saveLesson','deleteLesson','saveTopic','deleteTopic','schedule']) {
    assert.equal(call(action, { groupId: 'group' }).code, 'AUTH');
  }
  assert.equal(reads(), 0);
  assert.equal(login('valid-code-for-visitor').code, 'FORBIDDEN');
  assert.equal(login('unverified-code').code, 'FORBIDDEN');
  const { token } = login().data;
  assert.equal(call('group', { token, groupId: 'group' }).data.students.length, 2);
  settings.ALLOWED_GOOGLE_EMAILS = 'someone@example.test';
  assert.equal(call('groups', { token }).code, 'FORBIDDEN');
  settings.ALLOWED_GOOGLE_EMAILS = 'teacher@example.test';
  assert.equal(call('logout', { token }).ok, true);
  assert.equal(call('groups', { token }).code, 'AUTH');
});

test('lesson and topic mutations preserve records and reject conflicting edits', () => {
  const { call, login } = server();
  const common = { groupId: 'group', token: login().data.token };
  const send = (action, fields = {}) => call(action, { ...common, ...fields });
  const topicId = crypto.randomUUID();
  const topicFields = { newId: topicId, kind: 'practice', title: '=Учебная тема' };
  assert.equal(send('saveTopic', topicFields).data.title, topicFields.title);
  assert.equal(send('saveTopic', topicFields).code, 'CONFLICT');
  const lessonId = crypto.randomUUID();
  const lessonFields = { newId: lessonId, type: 'П1', date: '2026-11-20', topicId, note: 'Общий комментарий', changes: [] };
  assert.equal(send('saveLesson', { ...lessonFields, date: '2026-02-30' }).code, 'INPUT');
  assert.equal(send('saveLesson', { ...lessonFields, changes: [{ studentId: 's2', value: '5', note: '' }] }).code, 'INPUT');
  const created = send('saveLesson', { ...lessonFields, changes: [{ studentId: 's1', value: '5', note: 'Первая\nвторая строка' }] });
  assert.equal(created.data.id, lessonId);
  assert.equal(send('saveLesson', lessonFields).code, 'CONFLICT');
  assert.equal(send('saveLesson', { ...lessonFields, id: lessonId, version: 0 }).code, 'CONFLICT');
  assert.equal(send('saveTopic', { id: topicId, version: 1, kind: 'practice', title: 'Новое название' }).ok, true);
  assert.equal(send('deleteTopic', { id: topicId, version: 2 }).ok, true);
  const { lessons, topics } = send('group').data;
  assert.equal(lessons[0].marks.s1.note, 'Первая\nвторая строка');
  assert.equal(lessons[0].marks.s1.value, '5');
  assert.equal(lessons[0].topicId, topicId);
  assert.equal(topics[0].archived, true);
  assert.equal(send('saveLesson', { ...lessonFields, newId: crypto.randomUUID() }).code, 'INPUT');
  assert.equal(send('deleteLesson', { id: lessonId, version: 1 }).ok, true);
  assert.equal(send('group').data.lessons.length, 0);
  const schedule = send('schedule').data.items[0];
  assert.equal(schedule.week, -1);
  assert.equal(schedule.group, '2ТИТО-25');
});
