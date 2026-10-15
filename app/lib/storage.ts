export type SavedVoice = {
  id: string;
  name: string;
  createdAt: number;
  duration: number;
  audio: ArrayBuffer;
  learnedAt?: number;
  source?: "built-in" | "uploaded" | "recorded";
  referenceText?: string;
};

export type Generation = {
  id: string;
  text: string;
  voiceName: string;
  createdAt: number;
  duration: number;
  expression: number;
  pace?: "relaxed" | "natural" | "brisk";
  speed: number;
  pitch: number;
  audio: ArrayBuffer;
  voiceId?: string;
  samplingProfile?: "balanced" | "steady" | "expressive";
  kind?: "full" | "audition";
  sourceText?: string;
  engine?: "chatterbox" | "fish";
  sampleRate?: number;
  instruction?: string;
};

const DATABASE_NAME = "voice-studio-local";
const DATABASE_VERSION = 2;
const VOICE_STORE = "voices";
const HISTORY_STORE = "history";

export async function listVoices() {
  const voices = await getAll<SavedVoice>(VOICE_STORE);
  return voices.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveVoice(voice: SavedVoice) {
  await put(VOICE_STORE, voice);
}

export async function deleteVoice(id: string) {
  await remove(VOICE_STORE, id);
}

export async function listHistory() {
  const history = await getAll<Generation>(HISTORY_STORE);
  return history.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveGeneration(generation: Generation) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(HISTORY_STORE, "readwrite");
    const store = transaction.objectStore(HISTORY_STORE);
    store.put(generation);
    // Prune using index keys only. Reading every old waveform can copy gigabytes
    // and freeze the page just as a long recording finishes.
    let count = 0;
    const request = store.index("createdAt").openKeyCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (++count > 24) store.delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("无法保存音频。")); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("无法保存音频。")); };
  });
}

export async function deleteGeneration(id: string) {
  await remove(HISTORY_STORE, id);
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VOICE_STORE)) {
        database.createObjectStore(VOICE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(HISTORY_STORE)) {
        database.createObjectStore(HISTORY_STORE, { keyPath: "id" });
      }
      const history = request.transaction!.objectStore(HISTORY_STORE);
      if (!history.indexNames.contains("createdAt")) history.createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => reject(new Error("请关闭其他声音工作室标签页后刷新，完成本地记录升级。"));
    request.onerror = () => reject(request.error ?? new Error("Could not open local storage."));
  });
}

async function getAll<T>(storeName: string) {
  const database = await openDatabase();
  return new Promise<T[]>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error("Could not read local storage."));
    transaction.oncomplete = () => database.close();
  });
}

async function put(storeName: string, value: SavedVoice | Generation) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save locally."));
  });
}

async function remove(storeName: string, id: string) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(id);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete local item."));
  });
}
