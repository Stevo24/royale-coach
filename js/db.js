// Everything the app keeps lives in this phone's browser storage (IndexedDB),
// as a handful of named values.
const open = new Promise((resolve, reject) => {
  const request = indexedDB.open("royale-coach", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("kv");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const run = async (mode, action) => {
  const db = await open;
  return new Promise((resolve, reject) => {
    const request = action(db.transaction("kv", mode).objectStore("kv"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const load = (key) => run("readonly", (store) => store.get(key));
export const save = (key, value) => run("readwrite", (store) => store.put(value, key));
