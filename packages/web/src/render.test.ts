// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderUserMarkdown } from './render';

describe('markdown renderer', () => {
  it('renders code and strips unsafe html', () => {
    const out = renderMarkdown('```js\nconst x=1\n```\n<img src=x onerror=alert(1)>');
    expect(out).toContain('hljs');
    expect(out).not.toContain('<img');
  });

  it('renders katex from bracket delimiters', () => {
    expect(renderMarkdown('\\(x^2\\)')).toContain('katex');
  });

  it('keeps shell dollars literal', () => {
    const out = renderMarkdown('export PATH=$HOME/.local/bin:$PATH');
    expect(out).not.toContain('katex');
    expect(out).toContain('$HOME');
  });

  it('normalizes display math delimiters lost in rollout text', () => {
    const out = renderMarkdown('[\nE_{\\mathrm{vac}},\\quad E_C,\\quad E_F,\\quad E_V\n]');
    expect(out).toContain('katex-display');
    expect(out).toContain('E');
  });

  it('renders backslash-paren inline math delimiters', () => {
    const out = renderMarkdown('The value \\(x^2 + y^2\\) is squared');
    expect(out).toContain('katex');
    expect(out).not.toContain('\\(');
    expect(out).not.toContain('$1$');
  });

  it('renders backslash-bracket display math delimiters', () => {
    const out = renderMarkdown('Display: \\[E = mc^2\\]');
    expect(out).toContain('katex-display');
    expect(out).toContain('mc');
  });

  it('renders markdown tables', () => {
    const out = renderMarkdown('| Col A | Col B |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<th');
  });

  it('turns local markdown links into local-path links', () => {
    const out = renderUserMarkdown('请阅读 [SKILL.md](E:\\Codex Remote APP\\SKILL.md)');
    expect(out).toContain('class="local-path-link"');
    expect(out).toContain('data-local-path="E:/Codex Remote APP/SKILL.md"');
    expect(out).not.toContain('href="file:');
  });
});
