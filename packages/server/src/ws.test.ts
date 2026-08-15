import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import type { BridgeEvent, WsEnvelope } from '@remote/shared';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { AuthService } from './auth.js';
import { SessionService } from './service.js';
import { createApp } from './app.js';
import { attachWs } from './ws.js';

let server: Server | undefined;
let store: Store | undefined;
let sessions: SessionService | undefined;
let sockets: WebSocket[] = [];
let streams: Array<{ close: () => void }> = [];

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets = [];
  for (const stream of streams) stream.close();
  streams = [];
  await sessions?.manager.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
  store?.close();
  server = undefined;
  store = undefined;
  sessions = undefined;
});

describe('WebSocket origin validation', () => {
  it('rejects cross-origin upgrade with a non-allowed Origin header', async () => {
    const root = process.cwd();
    const config = loadConfig({
      databasePath: ':memory:', secret: 'x'.repeat(32),
      codexCommand: process.execPath,
      codexArgs: [join(root, 'src/test-fixtures/fake-app-server.mjs')],
      appServerCwd: root, codexCwdAllowlist: [root], codexRequestTimeoutMs: 1000,
      corsOrigins: ['http://127.0.0.1:5173'],
    });
    store = new Store(':memory:');
    const auth = new AuthService(store, config);
    sessions = new SessionService(store, config);
    server = createServer(createApp(store, auth, sessions, config));
    streams.push(attachWs(server, auth, store, config.corsOrigins));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const tokens = auth.pair(auth.createPairCode().code, 'origin-test')!;
    const wsBase = 'ws://127.0.0.1:' + port + '/ws?token=' + encodeURIComponent(tokens.access_token);
    const blocked = new WebSocket(wsBase, { headers: { Origin: 'http://evil.example.com' } });
    await new Promise<void>(resolve => { blocked.on('error', () => resolve()); blocked.on('close', () => resolve()); });
    expect(blocked.readyState).toBe(WebSocket.CLOSED);
  });

  it('allows same-origin upgrade without an explicit Origin header', async () => {
    const root = process.cwd();
    const config = loadConfig({
      databasePath: ':memory:', secret: 'x'.repeat(32),
      codexCommand: process.execPath,
      codexArgs: [join(root, 'src/test-fixtures/fake-app-server.mjs')],
      appServerCwd: root, codexCwdAllowlist: [root], codexRequestTimeoutMs: 1000,
    });
    store = new Store(':memory:');
    const auth = new AuthService(store, config);
    sessions = new SessionService(store, config);
    server = createServer(createApp(store, auth, sessions, config));
    streams.push(attachWs(server, auth, store, config.corsOrigins));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const tokens = auth.pair(auth.createPairCode().code, 'same-origin-test')!;
    const wsBase = 'ws://127.0.0.1:' + port + '/ws?token=' + encodeURIComponent(tokens.access_token);
    const socket = new WebSocket(wsBase);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('remote message stream', () => {
  it('broadcasts one web turn to both remote and host clients', async () => {
    const root = process.cwd();
    const config = loadConfig({
      databasePath: ':memory:',
      secret: 'x'.repeat(32),
      codexCommand: process.execPath,
      codexArgs: [join(root, 'src/test-fixtures/fake-app-server.mjs')],
      appServerCwd: root,
      codexCwdAllowlist: [root],
      codexRequestTimeoutMs: 1000,
    });
    store = new Store(':memory:');
    const auth = new AuthService(store, config);
    sessions = new SessionService(store, config);
    server = createServer(createApp(store, auth, sessions, config));
    const stream = attachWs(server, auth, store, config.corsOrigins);
    streams.push(stream);
    sessions.manager.on('event', event => stream.publish(event));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));

    const pairCode = auth.createPairCode();
    const tokens = auth.pair(pairCode.code, 'integration-test');
    expect(tokens).toBeTruthy();
    const address = server.address() as AddressInfo;
    const httpBase = `http://127.0.0.1:${address.port}`;
    const wsBase = `ws://127.0.0.1:${address.port}/ws?token=${encodeURIComponent(tokens!.access_token)}`;

    const remoteEvents: BridgeEvent[] = [];
    const hostEvents: BridgeEvent[] = [];
    sockets = [await connectClient(wsBase, remoteEvents), await connectClient(wsBase, hostEvents)];

    const created = await json(httpBase + '/api/sessions', tokens!.access_token, {
      method: 'POST',
      body: JSON.stringify({ cwd: root }),
    }) as { session_id: string };
    const accepted = await json(httpBase + `/api/sessions/${created.session_id}/messages`, tokens!.access_token, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: 'hello from web', client_id: 'web-client-1' }),
    }) as { turn_id: string };

    await Promise.all([
      waitFor(() => remoteEvents.some(event => event.type === 'assistant_delta')),
      waitFor(() => hostEvents.some(event => event.type === 'assistant_delta')),
    ]);

    for (const events of [remoteEvents, hostEvents]) {
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'turn_started', session: created.session_id }),
        expect.objectContaining({ type: 'user_message', metadata: expect.objectContaining({ client_id: 'web-client-1' }) }),
        expect.objectContaining({ type: 'assistant_delta', content: 'hello', metadata: expect.objectContaining({ turn_id: accepted.turn_id }) }),
      ]));
    }
    const closed = Promise.all(sockets.map(socket => new Promise<void>(resolve => socket.once('close', () => resolve()))));
    expect(auth.revoke(tokens!.device_id)).toBe(true);
    await closed;
  });
});

async function connectClient(url: string, events: BridgeEvent[]): Promise<WebSocket> {
  const socket = new WebSocket(url);
  socket.on('message', data => {
    const envelope = JSON.parse(String(data)) as WsEnvelope;
    if (envelope.type === 'event' && envelope.event) events.push(envelope.event);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function json(url: string, token: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for streamed event');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
