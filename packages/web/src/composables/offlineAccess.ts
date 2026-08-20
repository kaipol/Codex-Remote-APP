import { deleteMeta, getMeta, setMeta } from '../db';

const SALT_KEY = 'offline_access_salt';
const HASH_KEY = 'offline_access_hash';
const ITERATIONS = 150_000;
const KEY_BITS = 256;
const MIN_PASSWORD_LENGTH = 8;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const pwBytes = new Uint8Array(enc.encode(password));
  const key = await crypto.subtle.importKey('raw', pwBytes.buffer as ArrayBuffer, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: ITERATIONS, hash: 'SHA-256' }, key, KEY_BITS);
  return new Uint8Array(bits);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function offlinePasswordIsValid(password: string): boolean {
  return password.trim().length >= MIN_PASSWORD_LENGTH;
}

export async function hasOfflinePassword(): Promise<boolean> {
  return Boolean(await getMeta(SALT_KEY) && await getMeta(HASH_KEY));
}

export async function setOfflinePassword(password: string): Promise<void> {
  if (!offlinePasswordIsValid(password)) throw new Error(`本地离线密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);
  await setMeta(SALT_KEY, bytesToBase64(salt));
  await setMeta(HASH_KEY, bytesToBase64(hash));
}

export async function verifyOfflinePassword(password: string): Promise<boolean> {
  if (!password) return false;
  const saltValue = await getMeta(SALT_KEY);
  const hashValue = await getMeta(HASH_KEY);
  if (!saltValue || !hashValue) return false;
  try {
    const actual = await derive(password, base64ToBytes(saltValue));
    return sameBytes(actual, base64ToBytes(hashValue));
  } catch {
    return false;
  }
}

export async function clearOfflinePassword(): Promise<void> {
  await Promise.all([deleteMeta(SALT_KEY), deleteMeta(HASH_KEY)]);
}
