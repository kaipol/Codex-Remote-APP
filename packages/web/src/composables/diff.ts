export const INLINE_DIFF_LINES = 18;
export function diffText(value:unknown):string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item, null, 2)).join('\n');
  return value ? JSON.stringify(value, null, 2) : '';
}
export function truncateDiff(diff:string, limit=INLINE_DIFF_LINES){
  const lines=diff.split('\n');
  return { text:lines.slice(0,limit).join('\n'), truncated:lines.length>limit, lineCount:lines.length };
}
