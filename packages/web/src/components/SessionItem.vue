<script setup lang="ts">
import { ref } from 'vue';
import type { Session } from '@remote/shared';

defineProps<{
  session: Session;
  selected: boolean;
}>();

defineEmits<{ select: []; pin: []; archive: []; rename: [] }>();

const menu = ref(false);
</script>

<template>
  <div class="session-item-wrap">
    <div class="session-item-row">
      <button class="session-item" :class="{ selected }" @click="$emit('select')">
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
