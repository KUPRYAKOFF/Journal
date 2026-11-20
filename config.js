// Public identifiers only. Store the OAuth client secret in Apps Script properties.
window.JOURNAL_CONFIG = Object.freeze({
  apiUrl: "https://script.google.com/macros/s/AKfycbzvmCvMsPZWLZoM6bx1ISgGtHnoKWs1xXdOS4nM2PZFQbYO2wskUci1N5wVVvfeZ2NyQg/exec",
  googleClientId: "571080877264-e5grv7q34vq5dvd5cqbua1haj4l5ddbf.apps.googleusercontent.com",
  redirectUri: "https://kupryakoff.github.io/Journal/",
  timeZone: "Asia/Irkutsk",
  // Verified group names for the timetable's numeric-only response.
  // Some numbers are reused between courses, so the subject is part of the key.
  scheduleGroupAliases: {
    "2": { "информатика": "1КСК-26" },
    "4": { "информатика": "1ОП-26" },
    "5": { "информационные технологии": "2ТиТО-25", "конструктор карьеры": "2ТиТО-25" },
    "7": { "информатика": "1РЗ-26", "прикладные компьютерные программы в профессиональной деятельности": "2РЗ-25" },
    "8": { "информатика": "1ЭС2-26", "прикладные компьютерные программы в профессиональной деятельности": "2ЭС2-25" },
    "12": { "информатика": "1ТЭС2-26" }
  }
});
