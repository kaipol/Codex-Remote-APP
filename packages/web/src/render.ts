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
const md:MarkdownIt=new MarkdownIt({html:false,linkify:true,breaks:true,highlight(code:string,lang:string):string{const value:string=lang&&hljs.getLanguage(lang)?hljs.highlight(code,{language:lang}).value:escapeHtml(code);return `<pre><code class="hljs">${value}</code></pre>`}}).use(katex);
export function normalizeMath(text:string):string{
  let value=text
    .replace(/\\\(([\s\S]*?)\\\)/g,(_,g:string)=>`$${g}$`)
    .replace(/\\\[([\s\S]*?)\\\]/g,(_,g:string)=>`\n$$\n${g.trim()}\n$$\n`);
  value=value.replace(/(?:^|\n)\[\s*\n([\s\S]*?)\n\s*\](?=\n|$)/g,(all,body:string)=>looksLikeLatex(body)?`\n$$\n${body.trim()}\n$$`:all);
  return value;
}
function looksLikeLatex(value:string){return /\\(?:frac|mathrm|mathbf|text|quad|sum|int|begin|left|right)|[_^]\{?/.test(value)}
export const renderMarkdown=(text:string)=>DOMPurify.sanitize(md.render(normalizeMath(text)));
