import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.js';

let root = '';
const previousSecret = process.env.TOKEN_SECRET;

afterEach(async () => {
  if (previousSecret === undefined) delete process.env.TOKEN_SECRET;
  else process.env.TOKEN_SECRET = previousSecret;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('default authentication secret', () => {
  it('persists across config reloads when TOKEN_SECRET is omitted', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-remote-config-'));
    delete process.env.TOKEN_SECRET;
    const databasePath = join(root, 'remote.db');
    const first = loadConfig({ databasePath });
    const second = loadConfig({ databasePath });
    expect(first.secret).toBe(second.secret);
    expect(first.secret).toHaveLength(64);
  });
});
