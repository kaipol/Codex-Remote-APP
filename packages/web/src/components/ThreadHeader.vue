<script setup lang="ts">
import type { Session } from '@remote/shared';
defineProps<{ session: Session | null; activeTurn: boolean }>();
defineEmits<{ menu: []; rename: []; review: [] }>();
</script>

<template>
  <header class="thread-header">
    <button class="icon-button mobile-only" aria-label="打开会话" @click="$emit('menu')">☰</button>
    <div class="thread-title">
      <strong>{{ session?.title || '选择一个会话' }}</strong>
      <small v-if="session"><span class="status-dot" :class="{ online: session.status === 'active' }"></span>{{ activeTurn ? 'Codex 正在工作' : session.cwd }}</small>
    </div>
    <div v-if="session" class="header-actions"><button class="text-button" @click="$emit('review')">审阅</button></div>
  </header>
</template>
