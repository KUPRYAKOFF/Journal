'use strict';

window.MobileJournalStorage = (() => {
  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function openDatabase() {
    const request = indexedDB.open('journal-mobile-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('drafts', { keyPath: ['owner', 'key'] }).createIndex('owner', 'owner');
      const outbox = db.createObjectStore('outbox', { keyPath: 'localId', autoIncrement: true });
      outbox.createIndex('owner', 'owner');
      outbox.createIndex('operation', ['owner', 'id'], { unique: true });
    };
    return requestResult(request);
  }

  async function open(owner) {
    const db = await openDatabase();
    db.onversionchange = () => db.close();

    function write(stores, operate) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('Запись в браузере прервана.'));
        try {
          operate(tx);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    }

    async function read() {
      const tx = db.transaction(['drafts', 'outbox'], 'readonly');
      const [drafts, queue] = await Promise.all(['drafts', 'outbox'].map(name =>
        requestResult(tx.objectStore(name).index('owner').getAll(owner))));
      return { drafts, queue };
    }

    function changeDraft(key, draft) {
      return write(['drafts'], tx => {
        const store = tx.objectStore('drafts');
        if (draft) store.put({ ...draft, owner, key });
        else store.delete([owner, key]);
      });
    }

    function enqueue(drafts) {
      return write(['drafts', 'outbox'], tx => {
        const source = tx.objectStore('drafts');
        const outbox = tx.objectStore('outbox');
        for (const draft of drafts) {
          const key = [owner, draft.key];
          const current = source.get(key);
          current.onsuccess = () => {
            if (current.result?.id !== draft.id) return;
            outbox.add({ ...draft, owner, status: 'queued' });
            source.delete(key);
          };
        }
      });
    }

    function resolveQueue(deletions, changes = [], draftKey = null) {
      return write(draftKey ? ['outbox', 'drafts'] : ['outbox'], tx => {
        if (draftKey) tx.objectStore('drafts').delete([owner, draftKey]);
        const outbox = tx.objectStore('outbox');
        for (const operation of deletions) {
          if (operation.owner === owner) outbox.delete(operation.localId);
        }
        for (const operation of changes) {
          if (operation.owner === owner) outbox.put(operation);
        }
      });
    }

    function restore(drafts, queue) {
      return write(['drafts', 'outbox'], tx => {
        const draftStore = tx.objectStore('drafts');
        const outbox = tx.objectStore('outbox');
        for (const draft of drafts) {
          const current = draftStore.get([owner, draft.key]);
          current.onsuccess = () => { if (!current.result) draftStore.put({ ...draft, owner }); };
        }
        for (const operation of queue) {
          const current = outbox.index('operation').get([owner, operation.id]);
          current.onsuccess = () => { if (!current.result) outbox.add({ ...operation, owner }); };
        }
      });
    }

    return { read, changeDraft, enqueue, resolveQueue, restore, close: () => db.close() };
  }

  return { open };
})();
