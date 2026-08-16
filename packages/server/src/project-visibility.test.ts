import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { SessionService } from './service.js';

let root = '';
let outside = '';
let store: Store | undefined;
let sessions: SessionService | undefined;

afterEach(async () => {
  await sessions?.manager.close();
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
});

async function rollout(base: string, id: string, cwd: string) {
  const dir = join(base, 'sessions', '2026', '08', '15');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-${id}.jsonl`), JSON.stringify({ timestamp: '2026-08-15T00:00:00Z', type: 'session_meta', payload: { id, cwd, timestamp: '2026-08-15T00:00:00Z' } }) + '\n');
}

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

  it('lists a Desktop project session whose cwd is outside the static allowlist', async () => {
    root = join(tmpdir(), 'codex-remote-project-' + crypto.randomUUID());
    outside = join(tmpdir(), 'codex-remote-outside-' + crypto.randomUUID());
    await Promise.all([mkdir(root, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({
      'local-projects': {
        project: { id: 'project', name: 'External', rootPaths: [outside] },
      },
      'project-order': ['project'],
      'thread-project-assignments': {
        '11111111-1111-4111-8111-111111111111': { projectId: 'project' },
      },
      'sidebar-project-thread-orders': {},
    }));
    await rollout(root, '11111111-1111-4111-8111-111111111111', outside);

    const config = loadConfig({
      databasePath: ':memory:',
      secret: 'x'.repeat(32),
      codexHome: root,
      codexSessionsDir: join(root, 'sessions'),
      codexCommand: join(root, 'missing-codex.exe'),
      codexCwdAllowlist: [root],
      codexRequestTimeoutMs: 50,
    });
    store = new Store(':memory:');
    sessions = new SessionService(store, config);

    await expect(sessions.list()).resolves.toEqual([
      expect.objectContaining({
        session_id: '11111111-1111-4111-8111-111111111111',
        project_id: 'project',
        project_name: 'External',
        cwd: outside,
      }),
    ]);
  });

  it('resolves a project-id cwd to the project root so the session stays visible', async () => {
    root = join(tmpdir(), 'codex-remote-project-' + crypto.randomUUID());
    outside = join(tmpdir(), 'codex-remote-outside-' + crypto.randomUUID());
    await Promise.all([mkdir(root, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({
      'local-projects': {
        project: { id: 'project', name: 'External', rootPaths: [outside] },
      },
      'project-order': ['project'],
      'thread-project-assignments': {
        '22222222-2222-4222-8222-222222222222': { projectId: 'project' },
      },
      'sidebar-project-thread-orders': {},
    }));
    await rollout(root, '22222222-2222-4222-8222-222222222222', 'project');

    const config = loadConfig({
      databasePath: ':memory:',
      secret: 'x'.repeat(32),
      codexHome: root,
      codexSessionsDir: join(root, 'sessions'),
      codexCommand: join(root, 'missing-codex.exe'),
      codexCwdAllowlist: [root],
      codexRequestTimeoutMs: 50,
    });
    store = new Store(':memory:');
    sessions = new SessionService(store, config);

    await expect(sessions.list()).resolves.toEqual([
      expect.objectContaining({
        session_id: '22222222-2222-4222-8222-222222222222',
        project_id: 'project',
        project_name: 'External',
        cwd: outside,
      }),
    ]);
  });

  it('assigns a project by cwd match for an unassigned thread', async () => {
    root = join(tmpdir(), 'codex-remote-project-' + crypto.randomUUID());
    outside = join(tmpdir(), 'codex-remote-outside-' + crypto.randomUUID());
    await Promise.all([mkdir(root, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({
      'local-projects': {
        project: { id: 'project', name: 'External', rootPaths: [outside] },
      },
      'project-order': ['project'],
      'thread-project-assignments': {},
      'sidebar-project-thread-orders': {},
    }));
    await rollout(root, '33333333-3333-4333-8333-333333333333', outside);

    const config = loadConfig({
      databasePath: ':memory:',
      secret: 'x'.repeat(32),
      codexHome: root,
      codexSessionsDir: join(root, 'sessions'),
      codexCommand: join(root, 'missing-codex.exe'),
      codexCwdAllowlist: [root],
      codexRequestTimeoutMs: 50,
    });
    store = new Store(':memory:');
    sessions = new SessionService(store, config);

    const listed = await sessions.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      session_id: '33333333-3333-4333-8333-333333333333',
      cwd: outside,
    });
    expect(listed[0].project_id).toBe('project');
    expect(listed[0].project_name).toBe('External');
  });

  it('excludes archived and deleted threads from the list', async () => {
    root = join(tmpdir(), 'codex-remote-filter-' + crypto.randomUUID());
    const codexHome = join(root, '.codex');
    const inside = join(root, 'workspace');
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(inside, { recursive: true }),
      mkdir(join(root, '.codex-session-delete', 'backups'), { recursive: true }),
    ]);

    const activeId = '44444444-4444-4444-8444-444444444444';
    const archivedId = '55555555-5555-4555-8555-555555555555';
    const deletedId = '66666666-6666-4666-8666-666666666666';
    await Promise.all([
      rollout(codexHome, activeId, inside),
      rollout(codexHome, archivedId, inside),
      rollout(codexHome, deletedId, inside),
    ]);

    const db = new Database(join(codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER)');
    const insert = db.prepare('INSERT INTO threads (id, cwd, title, name, archived, created_at_ms, updated_at_ms, recency_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(activeId, inside, 'active', null, 0, 1, 1, 1);
    insert.run(archivedId, inside, 'archived', null, 1, 1, 1, 1);
    insert.run(deletedId, inside, 'deleted', null, 0, 1, 1, 1);
    db.close();

    await writeFile(join(root, '.codex-session-delete', 'backups', 'deleted.json'), JSON.stringify({ session_id: deletedId }));

    const config = loadConfig({
      databasePath: ':memory:',
      secret: 'x'.repeat(32),
      codexHome,
      codexSessionsDir: join(codexHome, 'sessions'),
      codexCommand: join(root, 'missing-codex.exe'),
      codexCwdAllowlist: [inside],
      codexRequestTimeoutMs: 50,
    });
    store = new Store(':memory:');
    sessions = new SessionService(store, config);

    const listed = await sessions.list();
    const ids = listed.map(s => s.session_id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(archivedId);
    expect(ids).not.toContain(deletedId);
  });

  it('excludes stale sidebar-only threads that are missing from the SQLite index', async () => {
    root = join(tmpdir(), 'codex-remote-ghost-' + crypto.randomUUID());
    const codexHome = join(root, '.codex');
    const inside = join(root, 'workspace');
    await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(inside, { recursive: true })]);

    const realId = '77777777-7777-4777-8777-777777777777';
    const ghostId = '88888888-8888-4888-8888-888888888888';

    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'local-projects': {
        project: { id: 'project', name: 'Ghost Project', rootPaths: [inside] },
      },
      'project-order': ['project'],
      'thread-project-assignments': {
        [ghostId]: { projectKind: 'local', projectId: 'project' },
        [realId]: { projectKind: 'local', projectId: 'project' },
      },
      'sidebar-project-thread-orders': {
        project: { threadIds: [ghostId, realId] },
      },
    }));

    const db = new Database(join(codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER)');
    const insert = db.prepare('INSERT INTO threads (id, cwd, title, name, archived, created_at_ms, updated_at_ms, recency_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(realId, inside, 'real', null, 0, 1, 1, 1);
    db.close();

    const config = loadConfig({
      databasePath: ':memory:',
      secret: 'x'.repeat(32),
      codexHome,
      codexSessionsDir: join(codexHome, 'sessions'),
      codexCommand: join(root, 'missing-codex.exe'),
      codexCwdAllowlist: [inside],
      codexRequestTimeoutMs: 50,
    });
    store = new Store(':memory:');
    sessions = new SessionService(store, config);

    const listed = await sessions.list();
    const ids = listed.map(s => s.session_id);
    expect(ids).toContain(realId);
    expect(ids).not.toContain(ghostId);
    expect(listed.some(s => s.title.includes(ghostId))).toBe(false);
  });
});
