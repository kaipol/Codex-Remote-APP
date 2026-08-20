import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverModels } from './local-capabilities.js';

let root = '';

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.TEST_MODEL_TOKEN;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

it('merges the provider /v1/models list with the configured catalog', async () => {
  root = join(tmpdir(), 'codex-provider-models-' + Date.now() + '-' + Math.random());
  await mkdir(join(root, 'model-catalogs'), { recursive: true });
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ id: 'gpt-provider' }, { id: 'gpt-secondary', display_name: 'Secondary' }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  process.env.TEST_MODEL_TOKEN = 'token';

  await writeFile(join(root, 'model-catalogs', 'selected.json'), JSON.stringify({ models: [{ slug: 'catalog-only' }] }));
  await writeFile(join(root, 'config.toml'), [
    'model_catalog_json = "selected.json"',
    'model_provider = "relay"',
    '',
    '[model_providers.relay]',
    'base_url = "https://models.example/v1"',
    'env_key = "TEST_MODEL_TOKEN"',
  ].join('\n'));
  await expect(discoverModels(root)).resolves.toEqual([
    expect.objectContaining({ model: 'catalog-only' }),
    expect.objectContaining({ model: 'gpt-provider' }),
    expect.objectContaining({ model: 'gpt-secondary', displayName: 'Secondary' }),
  ]);
  expect(String(fetchMock.mock.calls[0][0])).toBe('https://models.example/v1/models');
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer token' } });

  fetchMock.mockClear();
  await writeFile(join(root, 'config.toml'), [
    'model = "gpt-provider"',
    'model_provider = "relay"',
    '',
    '[model_providers.relay]',
    'base_url = "https://models.example/v1"',
    'env_key = "TEST_MODEL_TOKEN"',
  ].join('\n'));
  await expect(discoverModels(root)).resolves.toEqual([
    expect.objectContaining({ model: 'gpt-provider', isDefault: true }),
    expect.objectContaining({ model: 'gpt-secondary', displayName: 'Secondary' }),
  ]);
  expect(String(fetchMock.mock.calls[0][0])).toBe('https://models.example/v1/models');
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer token' } });
});

it('falls back to the configured catalog when the provider list is empty', async () => {
  root = join(tmpdir(), 'codex-provider-models-' + Date.now() + '-' + Math.random());
  await mkdir(join(root, 'model-catalogs'), { recursive: true });
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  vi.stubGlobal('fetch', fetchMock);
  process.env.TEST_MODEL_TOKEN = 'token';

  await writeFile(join(root, 'model-catalogs', 'selected.json'), JSON.stringify({ models: [{ slug: 'catalog-only' }] }));
  await writeFile(join(root, 'config.toml'), [
    'model_catalog_json = "selected.json"',
    'model_provider = "relay"',
    '',
    '[model_providers.relay]',
    'base_url = "https://models.example/v1"',
    'env_key = "TEST_MODEL_TOKEN"',
  ].join('\n'));
  await expect(discoverModels(root)).resolves.toEqual([
    expect.objectContaining({ model: 'catalog-only' }),
  ]);
});
