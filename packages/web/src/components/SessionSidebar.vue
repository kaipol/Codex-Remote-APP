<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Session, ProjectInfo } from '@remote/shared';
import SessionItem from './SessionItem.vue';
const p = defineProps<{ sessions: Session[]; activeId?: string; loading: boolean; error: string; busy: boolean; projects: ProjectInfo[]; sidebarOrder: Record<string, string[]>; projectOrder: string[] }>();
defineEmits<{ select: [session: Session]; refresh: []; pin: [session: Session]; archive: [session: Session]; rename: [session: Session]; create: []; createInCwd: [cwd: string]; settings: [] }>();
const query = ref(''); const view = ref<'active' | 'archived'>('active'); const collapsed = ref(new Set<string>());

interface Group { key: string; label: string; sessions: Session[]; cwd: string; }

const RECENT_KEY = '__recent__';
const RECENT_LABEL = '最近';

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const filtered = p.sessions.filter(s => (view.value === 'archived' ? s.status === 'archived' : s.status !== 'archived') && (!q || `${s.title} ${s.cwd} ${s.project_name || ''}`.toLowerCase().includes(q)));

  // Build project name lookup
  const projectNameById = new Map<string, string>();
  const projectCwdById = new Map<string, string>();
  for (const proj of p.projects) {
    projectNameById.set(proj.id, proj.name);
    if (proj.rootPaths.length) projectCwdById.set(proj.id, proj.rootPaths[0]);
  }

  // Determine the project label for each session
  function sessionProject(session: Session): { label: string; projectId?: string; cwd: string } {
    if (session.project_id && session.project_name) {
      return { label: session.project_name, projectId: session.project_id, cwd: session.cwd || projectCwdById.get(session.project_id) || '' };
    }
    if (session.project_id) {
      const name = projectNameById.get(session.project_id);
      if (name) return { label: name, projectId: session.project_id, cwd: session.cwd || projectCwdById.get(session.project_id) || '' };
    }
    return { label: RECENT_LABEL, cwd: session.cwd || '' };
  }

  // Group sessions
  const map = new Map<string, Session[]>();
  const groupMeta = new Map<string, { label: string; cwd: string; projectId?: string }>();
  // Pre-create the "最近" group placeholder (only shown if it gets sessions)

  for (const session of filtered) {
    const info = sessionProject(session);
    const key = info.projectId || RECENT_KEY;
    if (!map.has(key)) {
      map.set(key, []);
      groupMeta.set(key, { label: info.label, cwd: info.cwd, projectId: info.projectId });
    }
    map.get(key)!.push(session);
  }

  // Sort sessions within each group using sidebar order
  const orderedGroups: Group[] = [];
  for (const [key, sessions] of map) {
    const meta = groupMeta.get(key)!;
    const orderList = meta.projectId ? (p.sidebarOrder[meta.projectId] || []) : [];
    const ordered = orderList.length
      ? [...sessions].sort((a, b) => {
          const ia = orderList.indexOf(a.session_id);
          const ib = orderList.indexOf(b.session_id);
          if (ia === -1 && ib === -1) return b.updated_at.localeCompare(a.updated_at);
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        })
      : [...sessions].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
    orderedGroups.push({ key, label: meta.label, sessions: ordered, cwd: meta.cwd || meta.label });
  }

  // Sort groups: by projectOrder first, then '最近' last
  const recentGroup = orderedGroups.find(g => g.key === RECENT_KEY);
  const otherGroups = orderedGroups.filter(g => g.key !== RECENT_KEY);
  const sorted = [...otherGroups].sort((a, b) => {
    const ia = a.key ? p.projectOrder.indexOf(a.key) : -1;
    const ib = b.key ? p.projectOrder.indexOf(b.key) : -1;
    if (ia === -1 && ib === -1) return a.label.localeCompare(b.label);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  // Only add "最近" group if it actually has sessions
  if (recentGroup && recentGroup.sessions.length > 0) sorted.push(recentGroup);
  return sorted;
});

const folder = (path: string) => path;
function toggle(path: string) { const next = new Set(collapsed.value); next.has(path) ? next.delete(path) : next.add(path); collapsed.value = next; }
</script>

<template>
  <div class="sidebar">
    <header class="brand"><img class="brand-mark" src="/icon.svg" alt=""><div><strong>Codex Remote</strong><small>个人工作区</small></div><button class="icon-button settings-btn" title="设置" @click="$emit('settings')"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button></header>
    <button type="button" class="new-thread" :disabled="busy" @click="$emit('create')"><span>+</span> 新建会话</button>
    <label class="search"><span>⌕</span><input v-model="query" placeholder="搜索会话或目录" aria-label="搜索会话"></label>
    <div class="session-tabs"><button :class="{ active: view === 'active' }" @click="view = 'active'">项目</button><button :class="{ active: view === 'archived' }" @click="view = 'archived'">已归档</button><button class="icon-button" :disabled="loading" title="刷新" @click="$emit('refresh')"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2 11.5a10 10 0 0 1 18.8-4.3"/><path d="M22 12.5a10 10 0 0 1-18.8 4.2"/></svg></button></div>
    <div v-if="loading && !sessions.length" class="sidebar-state">正在发现 Codex 会话…</div><div v-else-if="error && !sessions.length" class="sidebar-state error">{{ error }}<button @click="$emit('refresh')">重试</button></div><div v-else-if="!groups.length" class="sidebar-state">{{ query ? '没有匹配会话' : view === 'archived' ? '没有已归档会话' : '尚无会话' }}</div>
    <div v-else class="session-list grouped"><section v-for="group in groups" :key="group.key" class="session-group" :class="{ collapsed: collapsed.has(group.key) }"><div class="project-header-row"><button class="project-header" :title="group.cwd" @click="toggle(group.key)"><svg v-if="collapsed.has(group.key)" class="folder-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v10h-17z"/><path d="M3.5 8.5v-3h6l2 3"/></svg><svg v-else class="folder-svg open" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5v-2h6l2 3h9v2"/><path d="M4.5 10.5h17l-2.4 8H2.6z"/></svg><strong>{{ group.label }}</strong><small class="project-count">{{ group.sessions.length }}</small></button><button class="project-new-thread" :title="`在 ${group.label} 新建会话`" :disabled="busy" @click.stop="$emit('createInCwd', group.cwd)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></div><div v-show="!collapsed.has(group.key)" class="project-children"><SessionItem v-for="s in group.sessions" :key="s.session_id" :session="s" :selected="s.session_id === activeId" @select="$emit('select', s)" @pin="$emit('pin', s)" @archive="$emit('archive', s)" @rename="$emit('rename', s)"/></div></section></div>
    <footer class="sidebar-footer"><span class="status-dot online"></span><span>Codex</span><small>{{ sessions.length }} 个会话</small></footer>
  </div>
</template>
