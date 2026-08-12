import { afterEach,describe,expect,it } from 'vitest';
import { mkdir,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { configuredCatalogPath,discoverModels } from './local-capabilities.js';
let root='';afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true})});
it('resolves catalog paths relative to the Codex home',()=>{const home='C:\\Users\\test\\.codex';expect(configuredCatalogPath('model_catalog_json = "model-catalogs/custom.json"',home)).toBe(join(home,'model-catalogs/custom.json'));expect(configuredCatalogPath('model_catalog_json = "custom.json"',home)).toBe(join(home,'model-catalogs','custom.json'))});
describe('local model catalogs',()=>{it('reads only the catalog selected by config.toml',async()=>{root=join(tmpdir(),`models-${randomUUID()}`);await mkdir(join(root,'model-catalogs'),{recursive:true});await writeFile(join(root,'config.toml'),'model_catalog_json = "selected.json"\n');await writeFile(join(root,'model-catalogs','default.json'),JSON.stringify({models:[{slug:'default-only'}]}));await writeFile(join(root,'model-catalogs','selected.json'),JSON.stringify({models:[{slug:'gpt-main',display_name:'GPT Main',supported_reasoning_levels:[{effort:'high'}]},{slug:'other'}]}));const models=await discoverModels(root);expect(models.map(item=>item.model)).toEqual(['gpt-main','other']);expect(models[0]).toMatchObject({displayName:'GPT Main',supportedReasoningEfforts:['high']})})});
