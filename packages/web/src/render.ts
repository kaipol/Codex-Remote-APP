import MarkdownIt from 'markdown-it';
import { katex } from '@mdit/plugin-katex';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import python from 'highlight.js/lib/languages/python';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';

hljs.registerLanguage('javascript',javascript);hljs.registerLanguage('js',javascript);
hljs.registerLanguage('typescript',typescript);hljs.registerLanguage('ts',typescript);
hljs.registerLanguage('json',json);hljs.registerLanguage('bash',bash);hljs.registerLanguage('sh',bash);
hljs.registerLanguage('css',css);hljs.registerLanguage('html',xml);hljs.registerLanguage('xml',xml);hljs.registerLanguage('python',python);hljs.registerLanguage('py',python);
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]!));
function createMarkdown():MarkdownIt{return new MarkdownIt({html:false,linkify:true,breaks:true,highlight(code:string,lang:string):string{const value:string=lang&&hljs.getLanguage(lang)?hljs.highlight(code,{language:lang}).value:escapeHtml(code);return `<pre><code class="hljs">${value}</code></pre>`}}).use(katex,{delimiters:'brackets',strict:'ignore'});}
const md=createMarkdown();
const userMd=createMarkdown();
const resourceIcon='<svg class="resource-mark-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
function resourceName(value:string){return value.replace(/^[$@]/,'').trim().replace(/[-_]+/g,' ').replace(/\b\w/g,char=>char.toUpperCase())}
function resourceKind(value:string):'skill'|'plugin'|undefined{const marker=value.trim()[0];return marker==='$'?'skill':marker==='@'?'plugin':undefined}
function addClass(token:any,value:string){const current=token.attrGet('class')||'';token.attrSet('class',[current,value].filter(Boolean).join(' '))}
userMd.inline.ruler.before('text','codex_resource_reference',(state,silent)=>{
  const match=state.src.slice(state.pos).match(/^\[([@$])([^\]\n]{1,80})\](?!\()/);
  if(!match)return false;
  if(!silent){const token=state.push('codex_resource','span',0);token.content=resourceName(match[2]);token.meta={kind:match[1]==='$'?'skill':'plugin'}}
  state.pos+=match[0].length;
  return true;
});
userMd.renderer.rules.codex_resource=(tokens,idx)=>{const token=tokens[idx];const kind=token.meta?.kind==='skill'?'skill':'plugin';return `<span class="resource-link ${kind}-resource">${resourceIcon}<span>${escapeHtml(token.content)}</span></span>`};
userMd.renderer.rules.link_open=(tokens,idx,options,_env,self)=>{
  const href=tokens[idx].attrGet('href')||'';
  const path=localPathFromTarget(href);
  const labelToken=tokens[idx+1];
  const kind=labelToken?.type==='text'?resourceKind(labelToken.content):undefined;
  if(path){
    tokens[idx].attrSet('href','#');
    tokens[idx].attrSet('data-local-path',path);
    tokens[idx].attrSet('title',path);
    addClass(tokens[idx],'local-path-link');
  }
  if(kind&&labelToken?.type==='text'){
    labelToken.content=resourceName(labelToken.content);
    addClass(tokens[idx],`resource-link ${kind}-resource`);
  }
  return self.renderToken(tokens,idx,options)+(kind?resourceIcon:'');
};
const localLinkPattern=/\[([^\]\n]+)\]\((?:\s*<)?([^)\n]+?)(?:>\s*)?\)/g;
function localPathFromTarget(target:string):string|undefined{
  let value=target.trim();
  if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
  value=value.replace(/\\/g,'/');
  if(/^file:\/\/\//i.test(value)){
    try{
      const url=new URL(value);
      let path=decodeURIComponent(url.pathname);
      if(/^\/[A-Za-z]:\//.test(path))path=path.slice(1);
      value=path;
    }catch{return undefined}
  }
  try{value=decodeURIComponent(value)}catch{/* leave raw */}
  if(/^[A-Za-z]:\//.test(value)||/^\/\//.test(value)||/^\/(?!\/)/.test(value)||/^~(?:\/|$)/.test(value))return value;
  return undefined;
}
function normalizeLocalLinks(text:string):string{
  return text.replace(localLinkPattern,(whole,label,target)=>{
    const path=localPathFromTarget(target);
    if(!path)return whole;
    return `[${label}](<${path}>)`;
  });
}
export function normalizeMath(text:string):string{
  // `\(...\)` inline math is handled natively by the tex plugin in "brackets"
  // delimiter mode, so leave it untouched. `\[...\]` display math must start
  // its own line for markdown-it's block parser, so reflow it onto separate
  // lines. Bare `$...$` is intentionally not enabled: shell prompts (`$ cd`)
  // and variables (`$HOME`, `$PATH`) are far more common in chat than TeX and
  // previously produced noisy KaTeX false positives. The final normalization
  // recovers display-math brackets that lost their backslashes in rollout text.
  const value=text.replace(/\\\[([\s\S]*?)\\\]/g,(_,g:string)=>`\n\\[\n${g.trim()}\n\\]\n`);
  return value.replace(/(?:^|\n)\[\s*\n([\s\S]*?)\n\s*\](?=\n|$)/g,(all,body:string)=>looksLikeLatex(body)?`\n\\[\n${body.trim()}\n\\]\n`:all);
}
function looksLikeLatex(value:string){return /\\(?:frac|mathrm|mathbf|text|quad|sum|int|begin|left|right)|[_^]\{?/.test(value)}
export const renderMarkdown=(text:string)=>DOMPurify.sanitize(md.render(normalizeMath(text)));
export const renderUserMarkdown=(text:string)=>DOMPurify.sanitize(userMd.render(normalizeMath(normalizeLocalLinks(text))));
