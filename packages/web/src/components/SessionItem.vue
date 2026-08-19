<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Session } from '@remote/shared';

defineProps<{
  session: Session;
  selected: boolean;
}>();

defineEmits<{ select: []; pin: []; archive: []; rename: [] }>();

const menu = ref(false);
const root = ref<HTMLElement>();
function outside(event: PointerEvent) {
  if (!menu.value || !root.value) return;
  const target = event.target as Element | null;
  if (!target || !root.value.contains(target) || !target.closest('.session-more, .session-menu')) menu.value = false;
}
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>

<template>
  <div ref="root" class="session-item-wrap">
    <div class="session-item-row">
      <button class="session-item" :class="{ selected, occupied: session.occupied }" :title="session.occupied ? '此会话正被本机 Codex 占用' : session.title" @click="$emit('select')">
        <span v-if="session.occupied" class="session-occupied-badge" aria-label="正被本机 Codex 占用">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        </span>
        <span class="session-copy">
          <strong>{{ session.title }}</strong>
        </span>
      </button>
      <button class="session-more" title="会话操作" @click="menu = !menu">•••</button>
      <div v-if="menu" class="session-menu">
        <button @click="$emit('rename'); menu = false">重命名</button>
        <button @click="$emit('pin'); menu = false">{{ session.pinned ? '取消置顶' : '置顶' }}</button>
        <button @click="$emit('archive'); menu = false">{{ session.status === 'archived' ? '取消归档' : '归档' }}</button>
      </div>
    </div>
  </div>
</template>
