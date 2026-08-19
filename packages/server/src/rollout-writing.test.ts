import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { rolloutActivelyWriting } from './service.js';

async function makeRollout(name: string, lastLine: string, prefixLines: string[] = []) {
  const dir = join(tmpdir(), `rollout-write-${name}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  const body = [...prefixLines, lastLine].join('\n') + '\n';
  await writeFile(path, body, 'utf8');
  return path;
}

describe('rolloutActivelyWriting', () => {
  let dirs: string[] = [];
  async function cleanup(path: string) {
    const dir = path.replace(/[/\\][^/\\]+$/, '');
    dirs.push(dir);
  }
  it('reports NOT writing when the last record is a turn-completion event', async () => {
    const path = await makeRollout('idle', JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }), [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
    ]);
    try { await expect(rolloutActivelyWriting(path)).resolves.toBe(false); }
    finally { await rm(path, { force: true }); }
  });
  it('reports IS writing when the last record is a function_call response_item', async () => {
    const path = await makeRollout('active', JSON.stringify({ type: 'response_item', payload: { type: 'function_call' } }), [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    ]);
    try { await expect(rolloutActivelyWriting(path)).resolves.toBe(true); }
    finally { await rm(path, { force: true }); }
  });
  it('reports IS writing when the last record is task_started', async () => {
    const path = await makeRollout('started', JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }));
    try { await expect(rolloutActivelyWriting(path)).resolves.toBe(true); }
    finally { await rm(path, { force: true }); }
  });
  it('reports NOT writing when the last record is thread lifecycle / session metadata', async () => {
    const path = await makeRollout('fresh', JSON.stringify({ payload: { type: 'thread_settings_applied' } }));
    try { await expect(rolloutActivelyWriting(path)).resolves.toBe(false); }
    finally { await rm(path, { force: true }); }
  });
  it('returns false for a missing or unreadable rollout file', async () => {
    await expect(rolloutActivelyWriting(join(tmpdir(), `missing-${crypto.randomUUID()}.jsonl`))).resolves.toBe(false);
  });
  it('returns false for an empty rollout file', async () => {
    const path = await makeRollout('empty', '');
    try { await expect(rolloutActivelyWriting(path)).resolves.toBe(false); }
    finally { await rm(path, { force: true }); }
  });
});
