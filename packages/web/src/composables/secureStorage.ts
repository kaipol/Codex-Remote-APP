import type { AuthTokens } from '@remote/shared';

const DB_NAME = 'codex-secure';
const STORE_NAME = 'tokens';
const KEY_NAME = 'auth-key';

let keyCache: CryptoKey | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function getItem(key: string): Promise<unknown | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function setItem(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteItem(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getOrCreateKey(): Promise<CryptoKey> {
  if (keyCache) return keyCache;
  const existing = await getItem(KEY_NAME);
  if (existing && typeof existing === 'object' && 'algorithm' in existing && 'usages' in existing) {
    keyCache = existing as CryptoKey;
  } else if (existing) {
    const raw = existing instanceof ArrayBuffer
      ? existing
      : (() => {
          const view = existing as ArrayBufferView;
          const bytes = new Uint8Array(view.byteLength);
          bytes.set(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
          return bytes.buffer;
        })();
    keyCache = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    await setItem(KEY_NAME, keyCache);
  } else {
    keyCache = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
    await setItem(KEY_NAME, keyCache);
  }
  return keyCache;
}

const IV_LENGTH = 12;

export async function secureStore(tokens: AuthTokens): Promise<void> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const data = new TextEncoder().encode(JSON.stringify(tokens));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  await setItem('tokens', combined.buffer);
}

export async function secureRetrieve(): Promise<AuthTokens | null> {
  try {
    const combined = await getItem('tokens');
    if (!combined) return null;
    const key = await getOrCreateKey();
    const data = new Uint8Array(combined as ArrayBuffer);
    const iv = data.slice(0, IV_LENGTH);
    const encrypted = data.slice(IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    return JSON.parse(new TextDecoder().decode(decrypted)) as AuthTokens;
  } catch {
    return null;
  }
}

export async function secureClear(): Promise<void> {
  keyCache = null;
  await deleteItem('tokens');
  // Keep the key for future use; only clear tokens
}
