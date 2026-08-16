<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { renderMarkdown, renderUserMarkdown } from '../render';
import { copyText } from '../composables/clipboard';
import { api } from '../api';

const props = defineProps<{ content: string; streaming?: boolean; user?: boolean }>();
const root = ref<HTMLElement>();
const html = ref('');

// Throttle re-rendering during streaming to avoid jank on every delta.
// Codex Desktop batches token deltas ~60fps; we mirror that with a 50ms floor.
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let lastRenderTime = 0;

async function render() {
  lastRenderTime = Date.now();
  html.value = props.user ? renderUserMarkdown(props.content) : renderMarkdown(props.content);
  await nextTick();
  attachCodeCopyButtons();
  attachLocalPathLinks();
}

function scheduleRender() {
  if (!props.streaming) { render(); return; }
  // During streaming, throttle to avoid re-parsing markdown on every token
  if (renderTimer) return;
  const elapsed = Date.now() - lastRenderTime;
  const delay = Math.max(0, 50 - elapsed);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, delay);
}

function attachCodeCopyButtons() {
  for (const pre of root.value?.querySelectorAll('pre') || []) {
    if (pre.querySelector(':scope > .code-copy-button')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy-button';
    button.textContent = '⧉';
    button.title = '复制代码';
    button.setAttribute('aria-label', '复制代码');
    button.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent || '';
      if (await copyText(code)) { button.textContent = '✓'; window.setTimeout(() => { button.textContent = '⧉'; }, 1400); }
    });
    pre.prepend(button);
  }
}

function attachLocalPathLinks() {
  for (const link of root.value?.querySelectorAll('a.local-path-link') || []) {
    if (link.getAttribute('data-local-path-bound') === 'true') continue;
    link.setAttribute('data-local-path-bound', 'true');
    link.addEventListener('click', async event => {
      event.preventDefault();
      const path = link.getAttribute('data-local-path');
      if (!path) return;
      try {
        await api.openPath(path);
      } catch {
        await copyText(path).catch(() => {});
      }
    });
  }
}

onMounted(render);
watch(() => props.content, () => {
  if (props.streaming) scheduleRender();
  else render();
});
watch(() => props.streaming, (streaming, wasStreaming) => {
  // When streaming ends, flush pending throttle and do a final clean render
  if (wasStreaming && !streaming) { if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; } render(); }
});
onBeforeUnmount(() => { if (renderTimer) clearTimeout(renderTimer); });
</script>
<template>
  <div ref="root" class="markdown" :class="{ 'markdown-streaming': streaming }" v-html="html"></div>
</template>
