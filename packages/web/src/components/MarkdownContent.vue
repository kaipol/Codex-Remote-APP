<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { renderMarkdown } from '../render';
import { copyText } from '../composables/clipboard';
const props = defineProps<{ content: string }>();
const root = ref<HTMLElement>();
const html = ref('');
async function render() {
  html.value = renderMarkdown(props.content);
  await nextTick();
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
onMounted(render);
watch(() => props.content, render);
</script>
<template><div ref="root" class="markdown" v-html="html"></div></template>
