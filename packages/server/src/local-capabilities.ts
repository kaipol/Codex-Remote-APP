import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { AppOption, ModelOption, ReasoningEffort, SkillOption } from '@remote/shared';

export async function discoverModels(codexHome:string):Promise<ModelOption[]>{
  const configured=await configuredCatalog(codexHome);
  const candidates=[join(codexHome,'models_cache.json'),join(codexHome,'cc-switch-model-catalog.json'),configured??join(codexHome,'model-catalogs','default.json')];
  const models=new Map<string,ModelOption>();
  for(const path of candidates){
    try{
      const parsed=JSON.parse(await readFile(path,'utf8')) as {models?:any[]};
      for(const item of parsed.models??[]){
        const model=String(item.model??item.slug??item.id??'');if(!model)continue;
        const efforts=(item.supportedReasoningEfforts??item.supported_reasoning_levels??[]).map((x:any)=>String(x.reasoningEffort??x.effort??x)).filter(isEffort);
        models.set(model,{id:String(item.id??model),model,displayName:String(item.displayName??item.display_name??model),description:item.description?String(item.description):undefined,isDefault:Boolean(item.isDefault),defaultReasoningEffort:effort(item.defaultReasoningEffort??item.default_reasoning_level),supportedReasoningEfforts:efforts,inputModalities:(item.inputModalities??item.input_modalities??['text']).map(String)});
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
async function configuredCatalog(codexHome:string){try{return configuredCatalogPath(await readFile(join(codexHome,'config.toml'),'utf8'),codexHome)}catch{return undefined}}

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
  const found:string[]=[];
  async function walk(dir:string){
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
function isEffort(value:string):value is ReasoningEffort{return ['none','minimal','low','medium','high','xhigh'].includes(value)}
function effort(value:unknown):ReasoningEffort|undefined{const result=String(value??'');return isEffort(result)?result:undefined}
