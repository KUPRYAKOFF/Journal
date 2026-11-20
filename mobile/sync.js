'use strict';

window.MobileJournalSync = (() => {
  const cellKey = (groupId, lessonId, studentId) => JSON.stringify([groupId, lessonId, studentId]);
  const allows = (student, lesson) => !(lesson.type === 'П1' && student.subgroup === '2') &&
    !(lesson.type === 'П2' && student.subgroup === '1');
  const mark = (lesson, studentId) => String(lesson.marks[studentId]?.value ?? '');
  const grades = ['2', '3', '4', '5'];
  const normalGrade = value => ['н', 'нб'].includes(String(value ?? '').trim().toLowerCase()) ? 'Н' : value;

  function nextBatch(queue) {
    const seen = new Set();
    const batch = [];
    for (const operation of queue) {
      if (seen.has(operation.key)) continue;
      seen.add(operation.key);
      if (operation.status === 'queued' && (!batch.length || operation.groupId === batch[0].groupId)) batch.push(operation);
      if (batch.length >= 30) break;
    }
    return batch;
  }

  function issue(operation, status, error, currentValue) {
    return { ...operation, status, error, currentValue };
  }

  async function sendBatch(operations, data, save, resolve) {
    const byLesson = new Map();
    const students = new Map(data.students.map(student => [student.id, student]));
    for (const operation of operations) {
      if (!byLesson.has(operation.lessonId)) byLesson.set(operation.lessonId, []);
      byLesson.get(operation.lessonId).push(operation);
    }
    for (const [id, batch] of byLesson) {
      const index = data.lessons.findIndex(lesson => lesson.id === id);
      const lesson = data.lessons[index];
      const confirmed = [];
      const rejected = [];
      const changes = [];
      const pending = [];
      for (const op of batch) {
        const student = students.get(op.studentId);
        if (!lesson || !student || !allows(student, lesson) || lesson.date !== op.lessonDate || lesson.type !== op.lessonType) {
          rejected.push(issue(op, 'invalid', 'Занятие или состав подгруппы изменились.'));
          continue;
        }
        const current = mark(lesson, op.studentId);
        if (current === op.value) confirmed.push(op);
        else if (current !== op.expectedValue) rejected.push(issue(op, 'conflict', 'Оценку уже изменили в журнале.', current));
        else {
          pending.push(op);
          changes.push({ studentId: student.id, value: op.value, note: lesson.marks[student.id]?.note || '' });
        }
      }
      if (confirmed.length || rejected.length) await resolve(confirmed, rejected);
      if (!pending.length) continue;
      try {
        data.lessons[index] = await save({
          groupId: batch[0].groupId, id, version: lesson.version, date: lesson.date, type: lesson.type,
          topicId: lesson.topicId || '', note: lesson.note || '', changes
        });
      } catch (error) {
        if (!['INPUT', 'NOT_FOUND'].includes(error.code)) throw error;
        await resolve([], pending.map(op => issue(op, 'invalid', error.message)));
        continue;
      }
      await resolve(pending, []);
    }
  }

  return { cellKey, allows, mark, grades, normalGrade, nextBatch, sendBatch };
})();
