import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { SessionService } from './service.js';

let root = '';
let store: Store | undefined;
let sessions: SessionService | undefined;

afterEach(async () => {
  await sessions?.manager.close();
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('project session visibility', () => {
  it('keeps a project thread visible before Desktop writes its sidebar order', async () => {
    root = join(tmpdir(), 'codex-remote-project-' + crypto.randomUUID());
    const projectRoot = join(root, 'workspace', 'demo');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({
      'local-projects': {
        project: { id: 'project', name: 'Demo', rootPaths: [projectRoot] },
      },
      'project-order': ['project'],
      'thread-project-assignments': {
        '11111111-1111-4111-8111-111111111111': { projectId: 'project', cwd: projectRoot },
      },
      'sidebar-project-thread-orders': {},
    }));

    const config = loadConfig({
      databasePath: ':memory:',
      secret: 'x'.repeat(32),
      codexHome: root,
      codexSessionsDir: join(root, 'sessions'),
      codexCommand: process.execPath,
      codexArgs: [join(process.cwd(), 'src', 'test-fixtures', 'fake-app-server.mjs')],
      appServerCwd: process.cwd(),
      codexCwdAllowlist: [root, process.cwd()],
      codexRequestTimeoutMs: 1000,
    });
    store = new Store(':memory:');
    sessions = new SessionService(store, config);

    await expect(sessions.list()).resolves.toEqual([
      expect.objectContaining({
        session_id: '11111111-1111-4111-8111-111111111111',
        project_id: 'project',
        project_name: 'Demo',
      }),
    ]);
  });
});
