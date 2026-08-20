import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { AppOption, ModelOption, ReasoningEffort, SkillOption } from '@remote/shared';

export async function discoverProviderModels(codexHome:string):Promise<ModelOption[]|undefined>{
  const source=await configSource(codexHome);
  return fetchProviderModels(source,tomlString(source,'model'));
}
export async function discoverModels(codexHome:string):Promise<ModelOption[]>{
  const source=await configSource(codexHome);
  const defaultModel=tomlString(source,'model');
  const configured=source?configuredCatalogPath(source,codexHome):undefined;
  const cacheCandidates=[join(codexHome,'models_cache.json'),join(codexHome,'cc-switch-model-catalog.json')];
  const [providerModels,selected,cached]=await Promise.all([
    discoverProviderModels(codexHome),
    configured?readModelCatalogs([configured],defaultModel):Promise.resolve([]),
    readModelCatalogs([...cacheCandidates,join(codexHome,'model-catalogs','default.json')],defaultModel),
  ]);
  // Provider discovery is best-effort: local/custom relays can be temporarily
  // unavailable while the configured catalog still describes valid models.
  // Keep the richer selected-catalog metadata first and use generic caches
  // only when no selected catalog is available. Provider discovery can add
  // models, but a stale global cache must not flood a configured picker.
  return mergeModels(selected.length?selected:cached,providerModels??[]);
}
async function readModelCatalogs(candidates:string[],defaultModel?:string):Promise<ModelOption[]>{
  const models=new Map<string,ModelOption>();
  for(const path of candidates){
    try{
      const parsed=JSON.parse(await readFile(path,'utf8')) as {models?:any[]};
      for(const item of parsed.models??[]){
        if(item.hidden===true||String(item.visibility??'').toLowerCase()==='hide')continue;
        const model=String(item.model??item.slug??item.id??'');if(!model)continue;
        const efforts=(item.supportedReasoningEfforts??item.supported_reasoning_levels??[]).map((x:any)=>String(x.reasoningEffort??x.effort??x)).filter(isEffort);
        if(!models.has(model))models.set(model,{id:String(item.id??model),model,displayName:String(item.displayName??item.display_name??model),description:item.description?String(item.description):undefined,isDefault:Boolean(item.isDefault)||model===defaultModel,defaultReasoningEffort:effort(item.defaultReasoningEffort??item.default_reasoning_level),supportedReasoningEfforts:efforts,inputModalities:(item.inputModalities??item.input_modalities??['text']).map(String)});
      }
    }catch{/* optional local cache */}
  }
  return [...models.values()];
}
export function configuredCatalogPath(source:string,codexHome:string){
  const match=source.match(/^\s*model_catalog_json\s*=\s*("(?:\\.|[^"])*")/m);
  if(!match)return undefined;
  let decoded:string;
  try{decoded=JSON.parse(match[1])}catch{decoded=match[1].slice(1,-1).replace(/\\\\/g,'\\')}
  const value=normalize(decoded);
  if(isAbsolute(value)||/^[A-Za-z]:[\\/]/.test(value))return value;
  return dirname(value)==='.'?join(codexHome,'model-catalogs',value):join(codexHome,value);
}
async function configSource(codexHome:string){try{return await readFile(join(codexHome,'config.toml'),'utf8')}catch{return ''}}
function tomlString(source:string,key:string){const match=source.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:\\\\.|[^"])*")`,'m'));if(!match)return undefined;try{return JSON.parse(match[1]) as string}catch{return match[1].slice(1,-1)}}
function providerSettings(source:string){
  const provider=tomlString(source,'model_provider');
  if(!provider)return {baseUrl:tomlString(source,'openai_base_url'),environmentKey:tomlString(source,'openai_api_key_env')};
  const header=new RegExp('(?:^|\\n)\\s*\\[model_providers\\.'+escapeRegExp(provider)+'\\]\\s*(?:\\r?\\n|$)','m').exec(source);
  const start=header?header.index+header[0].length:0;
  const rest=header?source.slice(start):'';
  const end=rest.search(/^\s*\[/m);
  const section=header?(end<0?rest:rest.slice(0,end)):undefined;
  const baseUrl=section?tomlString(section,'base_url'):tomlString(source,'openai_base_url');
  const environmentKey=section?tomlString(section,'env_key'):tomlString(source,'openai_api_key_env');
  return {baseUrl,environmentKey};
}
function escapeRegExp(value:string){return value.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}
async function fetchProviderModels(source:string,defaultModel?:string):Promise<ModelOption[]|undefined>{
  const {baseUrl:base,environmentKey}=providerSettings(source);if(!base)return undefined;
  try{
    const target=new URL('models',base.endsWith('/')?base:base+'/');
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    const token=environmentKey?process.env[environmentKey]:undefined;
    const response=await fetch(target,{signal:controller.signal,...(token?{headers:{authorization:'Bearer '+token}}:{})});clearTimeout(timer);
    if(!response.ok)return [];
    const body=await response.json() as {data?:unknown[]};
    if(!Array.isArray(body.data))return [];
    return body.data.flatMap((item:any)=>{const model=String(item?.id??item?.model??'');return model?[{id:model,model,displayName:String(item.display_name??item.displayName??model),description:item.description?String(item.description):undefined,isDefault:model===defaultModel,supportedReasoningEfforts:[],inputModalities:['text']} satisfies ModelOption]:[]});
  }catch{return []}
}

export async function discoverSkills(codexHome:string):Promise<SkillOption[]>{
  const home=process.env.USERPROFILE||process.env.HOME||'';
  const roots=[join(codexHome,'skills'),join(codexHome,'plugins','cache'),home?join(home,'.agents','skills'):''].filter(Boolean);
  const paths=(await Promise.all(roots.map(root=>findNamed(root,'SKILL.md')))).flat();
  const skills=new Map<string,SkillOption>();
  for(const path of paths){
    try{
      const source=await readFile(path,'utf8'),meta=frontmatter(source);
      const name=meta.name||basename(dirname(path));
      const item={name,description:meta.description||'',path,scope:path.includes('plugins\cache')||path.includes('plugins/cache')?'plugin':'user',enabled:true};
      if(!skills.has(name))skills.set(name,item);
    }catch{/* isolate malformed skills */}
  }
  return [...skills.values()].sort((a,b)=>a.name.localeCompare(b.name));
}

export async function discoverApps(codexHome:string):Promise<AppOption[]>{
  const manifests=await findNamed(join(codexHome,'plugins','cache'),'plugin.json');
  const apps=new Map<string,AppOption>();
  for(const path of manifests){
    if(!path.replace(/\\/g,'/').includes('/.codex-plugin/'))continue;
    try{
      const data=JSON.parse(await readFile(path,'utf8')) as any,id=String(data.name??'');if(!id)continue;
      const ui=data.interface??{};
      apps.set(id,{id,name:String(ui.displayName??id),description:String(ui.shortDescription??data.description??''),logoUrl:undefined,isAccessible:true,isEnabled:true});
    }catch{/* isolate malformed manifests */}
  }
  return [...apps.values()].sort((a,b)=>a.name.localeCompare(b.name));
}

async function findNamed(root:string,name:string):Promise<string[]>{
  const found:string[]=[];const visited=new Set<string>();
  async function walk(dir:string){
    let canonical:string;try{canonical=await realpath(dir)}catch{return}if(visited.has(canonical))return;visited.add(canonical);
    let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch{return}
    await Promise.all(entries.map(async entry=>{
      const path=join(dir,entry.name);
      // On Windows, symlinks to directories report isDirectory()=false.
      // Use stat() to correctly identify symlinked directories.
      if(entry.isSymbolicLink()){try{const s=await stat(path);if(s.isDirectory())await walk(path);else if(s.isFile()&&entry.name===name)found.push(path)}catch{/* broken symlink */}return}
      if(entry.isDirectory())await walk(path);
      else if(entry.isFile()&&entry.name===name)found.push(path);
    }));
  }
  await walk(root);return found;
}
function frontmatter(source:string){const block=source.match(/^---\r?\n([\s\S]*?)\r?\n---/);const out:Record<string,string>={};if(!block)return out;for(const line of block[1].split(/\r?\n/)){const match=line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);if(match)out[match[1]]=match[2].trim().replace(/^['"]|['"]$/g,'')}return out}
function mergeModels(primary:ModelOption[],extras:ModelOption[]):ModelOption[]{const merged=new Map(primary.map(item=>[item.model,item]));for(const item of extras)if(!merged.has(item.model))merged.set(item.model,item);return [...merged.values()]}
function isEffort(value:string):value is ReasoningEffort{return ['none','minimal','low','medium','high','xhigh','max','ultra'].includes(value)}
function effort(value:unknown):ReasoningEffort|undefined{const result=String(value??'');return isEffort(result)?result:undefined}
