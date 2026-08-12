<script setup lang="ts">
import { nextTick, ref, watch, computed } from 'vue';
import { api } from '../api';

const p = defineProps<{ open: boolean; initial: string; busy: boolean; error?: string }>();
const emit = defineEmits<{ close: []; create: [cwd: string] }>();

const cwd = ref('');
const input = ref<HTMLInputElement>();
const roots = ref<string[]>([]);
const loadingRoots = ref(false);
const browsePath = ref<string | null>(null);
const entries = ref<{ fileName: string; isDirectory: boolean; isFile: boolean }[]>([]);
const loadingEntries = ref(false);
const view = ref<'picker' | 'manual'>('picker');

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const parentPath = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  const parts = trimmed.split(sep);
  parts.pop();
  return parts.length ? parts.join(sep) : trimmed;
};
const canGoUp = computed(() => {
  if (!browsePath.value || !roots.value.length) return false;
  return roots.value.some(root => browsePath.value !== root && (browsePath.value!.startsWith(root + '\\') || browsePath.value!.startsWith(root + '/')));
});

watch(() => p.open, async value => {
  if (value) {
    cwd.value = p.initial;
    view.value = 'picker';
    browsePath.value = null;
    entries.value = [];
    await loadRoots();
    nextTick(() => input.value?.focus());
  }
}, { immediate: true });

async function loadRoots() {
  loadingRoots.value = true;
  try {
    roots.value = await api.cwdRoots();
    if (!roots.value.length) view.value = 'manual';
  } catch {
    view.value = 'manual';
  } finally {
    loadingRoots.value = false;
  }
}

async function browse(path: string) {
  browsePath.value = path;
  cwd.value = path;
  loadingEntries.value = true;
  entries.value = [];
  try {
    entries.value = await api.readDirectory(path);
  } catch {
    entries.value = [];
  } finally {
    loadingEntries.value = false;
  }
}

async function enterDir(name: string) {
  if (!browsePath.value) return;
  const sep = browsePath.value.includes('\\') ? '\\' : '/';
  const next = browsePath.value.replace(/[\\/]+$/, '') + sep + name;
  await browse(next);
}

async function goUp() {
  if (!browsePath.value || !canGoUp.value) return;
  await browse(parentPath(browsePath.value));
}

function selectRoot(path: string) {
  cwd.value = path;
  emit('create', path);
}

function submit() { const value = cwd.value.trim(); if (value && !p.busy) emit('create', value); }
</script>

<template>
  <div v-if="open" class="modal-scrim" @click.self="$emit('close')">
    <section class="new-thread-dialog acrylic-panel">
      <header>
        <div><strong>新建会话</strong><small>选择项目目录</small></div>
        <div class="dialog-tabs">
          <button type="button" :class="{ active: view === 'picker' }" @click="view = 'picker'">浏览</button>
          <button type="button" :class="{ active: view === 'manual' }" @click="view = 'manual'">手动输入</button>
        </div>
        <button type="button" class="icon-button" title="关闭" @click="$emit('close')">×</button>
      </header>

      <!-- Picker view: show roots and browse subdirectories -->
      <div v-if="view === 'picker'" class="cwd-picker">
        <div v-if="loadingRoots" class="picker-state">正在加载可用目录…</div>
        <template v-else-if="roots.length">
          <!-- Root list -->
          <div v-if="!browsePath" class="root-list">
            <button
              v-for="root in roots"
              :key="root"
              type="button"
              class="root-card"
              :title="root"
              @click="browse(root)"
            >
              <svg class="root-folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v10h-17z"/></svg>
              <div class="root-info">
                <strong>{{ folderName(root) }}</strong>
                <small>{{ root }}</small>
              </div>
              <svg class="root-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            </button>
          </div>

          <!-- Directory browser -->
          <div v-else class="dir-browser">
            <div class="browser-path">
              <button v-if="canGoUp" type="button" class="browser-up" title="上级目录" @click="goUp">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l-8 8h5v8h6v-8h5z" transform="rotate(-90 12 12)"/></svg>
              </button>
              <span class="browser-cwd" :title="browsePath">{{ folderName(browsePath) }}</span>
              <small class="browser-full">{{ browsePath }}</small>
            </div>
            <div v-if="loadingEntries" class="picker-state">正在读取目录…</div>
            <div v-else-if="!entries.filter(e => e.isDirectory).length" class="picker-state empty">此目录没有子文件夹</div>
            <div v-else class="entry-list">
              <button
                v-for="entry in entries.filter(e => e.isDirectory)"
                :key="entry.fileName"
                type="button"
                class="entry-item"
                @click="enterDir(entry.fileName)"
              >
                <svg class="entry-folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v10h-17z"/></svg>
                <span>{{ entry.fileName }}</span>
              </button>
            </div>
            <footer class="browser-footer">
              <button type="button" class="primary" :disabled="busy" @click="selectRoot(browsePath!)">
                在此目录创建会话
              </button>
            </footer>
          </div>
        </template>
        <div v-else class="picker-state">未配置可用目录，请使用手动输入</div>
      </div>

      <!-- Manual input view -->
      <div v-else class="manual-input">
        <label>工作目录
          <input ref="input" v-model="cwd" placeholder="E:\project" @keyup.enter="submit">
        </label>
        <p v-if="error" class="new-thread-error">{{ error }}</p>
      </div>

      <footer v-if="view === 'manual' || browsePath">
        <button type="button" class="text-button" @click="$emit('close')">取消</button>
        <button v-if="view === 'manual'" type="button" class="primary" :disabled="busy || !cwd.trim()" @click="submit">
          {{ busy ? '正在创建…' : '创建会话' }}
        </button>
      </footer>
    </section>
  </div>
</template>
