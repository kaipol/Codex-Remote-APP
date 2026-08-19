<script setup lang="ts">
import { computed } from 'vue';
import { isSuppressedRuntimeNotice, type BridgeEvent } from '@remote/shared';

const props = defineProps<{
  activeTurn: boolean;
  events: BridgeEvent[];
}>();

// Find the most recent in-progress tool/command event to show what Codex is doing
const currentActivity = computed<string | undefined>(() => {
  if (!props.activeTurn) return undefined;
  const reversed = [...props.events].reverse();
  for (const e of reversed) {
    const status = String(e.metadata?.status || '');
    if (['inprogress', 'running', 'started'].includes(status.toLowerCase()) || String(e.metadata?.phase || '').toLowerCase() === 'started') {
      if (e.type === 'command_execution' && e.metadata?.command) {
        return `运行命令：${String(e.metadata.command)}`;
      }
      if (e.type === 'tool_call' && e.metadata?.tool) {
        return `调用工具：${String(e.metadata.tool)}`;
      }
      if (e.type === 'web_search' && e.metadata?.action) {
        return `搜索网页：${String(e.metadata.action)}`;
      }
      if (e.type === 'file_change') {
        return '编辑文件';
      }
      if (e.type === 'reasoning_status') {
        return '思考中';
      }
    }
  }
  return undefined;
});

// Check if there's an active streaming assistant message (stream: msg exists
// but no final assistant_message has replaced it yet)
const isStreaming = computed(() => {
  if (!props.activeTurn) return false;
  const reversed = [...props.events].reverse();
  let hasDelta = false;
  let hasFinal = false;
  for (const e of reversed) {
    if (e.type === 'assistant_delta') hasDelta = true;
    if (e.type === 'assistant_message') { hasFinal = true; break; }
    if (e.type === 'turn_started') break;
  }
  return hasDelta && !hasFinal;
});

// Show provider errors as a status message while the turn is active
const providerError = computed<string | undefined>(() => {
  if (!props.activeTurn) return undefined;
  const reversed = [...props.events].reverse();
  for (const e of reversed) {
    if (e.type === 'turn_started') break;
    if (e.type === 'provider_error' && e.content && !isSuppressedRuntimeNotice(e.content)) return e.content;
  }
  return undefined;
});

const label = computed(() => {
  if (providerError.value) return providerError.value;
  if (currentActivity.value) return currentActivity.value;
  if (isStreaming.value) return '正在回复';
  return '正在回复';
});
</script>

<template>
  <div v-if="activeTurn" class="typing-indicator" :class="{ 'typing-error': providerError }">
    <span class="typing-avatar">
      <img src="/icon.svg" alt="" class="typing-avatar-img">
    </span>
    <span class="typing-dots">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </span>
    <span class="typing-label">{{ label }}</span>
  </div>
</template>
