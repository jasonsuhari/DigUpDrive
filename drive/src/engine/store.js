const DB_NAME = "digup";

let opened;

export function db() {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      const items = database.createObjectStore("items", { keyPath: "id" });
      items.createIndex("state", "state");
      items.createIndex("source", "source");
      const segments = database.createObjectStore("segments", { keyPath: "id", autoIncrement: true });
      segments.createIndex("item", "item");
      database.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opened;
}

const done = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const finished = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

export async function getMeta(key) {
  return done((await db()).transaction("meta").objectStore("meta").get(key));
}

export async function setMeta(key, value) {
  const transaction = (await db()).transaction("meta", "readwrite");
  transaction.objectStore("meta").put(value, key);
  return finished(transaction);
}

export async function getItem(id) {
  return done((await db()).transaction("items").objectStore("items").get(id));
}

export async function allItems() {
  return done((await db()).transaction("items").objectStore("items").getAll());
}

export async function itemsInState(state) {
  return done((await db()).transaction("items").objectStore("items").index("state").getAll(state));
}

export async function putItems(items) {
  const transaction = (await db()).transaction("items", "readwrite");
  for (const item of items) transaction.objectStore("items").put(item);
  return finished(transaction);
}

export async function removeItems(ids) {
  const transaction = (await db()).transaction(["items", "segments"], "readwrite");
  const segments = transaction.objectStore("segments");
  const removed = new Map();
  for (const id of ids) {
    transaction.objectStore("items").delete(id);
    segments.index("item").getAllKeys(IDBKeyRange.only(id)).onsuccess = function () {
      removed.set(id, this.result);
      for (const key of this.result) segments.delete(key);
    };
  }
  await finished(transaction);
  return removed;
}

export async function replaceSegments(item, segments) {
  const transaction = (await db()).transaction(["items", "segments"], "readwrite");
  const store = transaction.objectStore("segments");
  const ids = await done(store.index("item").getAllKeys(IDBKeyRange.only(item.id)));
  for (const id of ids) store.delete(id);
  const written = [];
  for (const segment of segments) {
    const request = store.add({ ...segment, item: item.id });
    request.onsuccess = () => written.push({ ...segment, item: item.id, id: request.result });
  }
  transaction.objectStore("items").put(item);
  await finished(transaction);
  return { removed: ids, written };
}

export async function eachSegment(visit) {
  const transaction = (await db()).transaction("segments");
  await new Promise((resolve, reject) => {
    const request = transaction.objectStore("segments").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      visit(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getSegments(ids) {
  const store = (await db()).transaction("segments").objectStore("segments");
  return Promise.all(ids.map((id) => done(store.get(id))));
}

export async function segmentsOf(itemId) {
  return done((await db()).transaction("segments").objectStore("segments").index("item").getAll(IDBKeyRange.only(itemId)));
}

export async function wipe() {
  const transaction = (await db()).transaction(["items", "segments", "meta"], "readwrite");
  for (const name of ["items", "segments", "meta"]) transaction.objectStore(name).clear();
  return finished(transaction);
}
