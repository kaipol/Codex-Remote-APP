<script setup lang="ts">
defineProps<{ drawerOpen: boolean; sidebarHidden: boolean }>();
defineEmits<{ close: []; toggleSidebar: [] }>();
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-hidden': sidebarHidden }">
    <button class="icon-button app-sidebar-toggle" :aria-label="sidebarHidden ? '显示侧边栏' : '隐藏侧边栏'" :title="sidebarHidden ? '显示侧边栏' : '隐藏侧边栏'" @click="$emit('toggleSidebar')">
      <span class="sidebar-toggle-icon"></span>
    </button>
    <div v-if="drawerOpen" class="drawer-scrim" @click="$emit('close')"></div>
    <aside class="sidebar-panel" :class="{ open: drawerOpen }"><slot name="sidebar" /></aside>
    <main class="main-panel"><slot /></main>
    <slot name="overlay" />
  </div>
</template>
