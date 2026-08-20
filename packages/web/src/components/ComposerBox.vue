<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AppOption, CodexDefaults, FileSearchResult, ModelOption, ReasoningEffort, RuntimeConfig, SkillOption, UserInput } from '@remote/shared';
import { api } from '../api';

const props = defineProps<{ disabled: boolean; activeTurn: boolean; occupied?: boolean; online: boolean; queued: number; sending: boolean; models: ModelOption[]; skills: SkillOption[]; apps: AppOption[]; defaults: CodexDefaults; capabilitiesLoading: boolean; offlineMode?: boolean; cwd: string }>();
const emit = defineEmits<{ send: [payload: { text: string; input: UserInput[]; runtime: RuntimeConfig }]; cancel: []; loadCapabilities: [] }>();
const root = ref<HTMLElement>();
const text = ref('');
const input = ref<HTMLTextAreaElement>();
const fileInput = ref<HTMLInputElement>();
const menu = ref<'add' | 'access' | 'model' | null>(null);
const modelSection = ref<'root' | 'models' | 'effort'>('root');
const modelQuery = ref('');
const selectedSkill = ref<SkillOption>();
const attachments = ref<Array<{ name: string; bytes: number; input: UserInput }>>([]);
const attachmentError = ref('');
const mentions = ref<Array<{ name: string; path: string }>>([]);
const model = ref('');
const effort = ref<RuntimeConfig['effort']>('medium');
const approvalPolicy = ref<RuntimeConfig['approvalPolicy']>('on-request');
const sandbox = ref<RuntimeConfig['sandbox']>('workspace-write');
const runtimeTouched = { model: false, effort: false, approvalPolicy: false, sandbox: false };

// Slash command + mention picker state
type SlashCommand = { kind: 'skill'; item: SkillOption } | { kind: 'app'; item: AppOption };
const slashOpen = ref(false);
const slashItems = ref<SlashCommand[]>([]);
const slashIndex = ref(0);
const slashQuery = ref('');
const mentionOpen = ref(false);
const mentionItems = ref<FileSearchResult[]>([]);
const mentionIndex = ref(0);
const mentionQuery = ref('');
let searchAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

watch(() => props.models, items => {
  if (!items.length) return;
  if (!model.value) model.value = (items.find(item => item.isDefault) || items[0]).model;
  normalizeSelectedEffort(items.find(item => item.model === model.value));
}, { immediate: true });
watch(model, value => normalizeSelectedEffort(props.models.find(item => item.model === value)));
watch(() => props.defaults, value => {
  if (value.model && !runtimeTouched.model) model.value = value.model;
  if (value.effort && !runtimeTouched.effort) effort.value = value.effort;
  if (value.approvalPolicy && !runtimeTouched.approvalPolicy) approvalPolicy.value = value.approvalPolicy;
  if (value.sandbox && !runtimeTouched.sandbox) sandbox.value = value.sandbox === 'danger-full-access' && !value.allowDangerFullAccess ? 'workspace-write' : value.sandbox;
}, { immediate: true });
const effortOptions = computed(() => props.models.find(x => x.model === model.value)?.supportedReasoningEfforts.length ? props.models.find(x => x.model === model.value)!.supportedReasoningEfforts : ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const);
const selectedModel = computed(() => props.models.find(x => x.model === model.value));
const filteredModels = computed(() => {
  const query = modelQuery.value.trim().toLowerCase();
  return [...props.models]
    .filter(item => !query || [item.model, item.displayName, item.description].some(value => value?.toLowerCase().includes(query)))
    .sort((a, b) => Number(b.model === model.value) - Number(a.model === model.value));
});
const configuredModelVisible = computed(() => props.defaults.model && !props.models.some(item => item.model === props.defaults.model) && (!modelQuery.value.trim() || props.defaults.model.toLowerCase().includes(modelQuery.value.trim().toLowerCase())));
const accessPreset = computed(() => sandbox.value === 'danger-full-access' && approvalPolicy.value === 'never' ? 'full' : approvalPolicy.value === 'untrusted' ? 'guarded' : 'request');
const accessLabel = computed(() => accessPreset.value === 'full' ? '完全访问' : accessPreset.value === 'guarded' ? '帮我批准' : '请求批准');
function toggle(value: 'add' | 'access' | 'model') { menu.value = menu.value === value ? null : value; if (value === 'model') { modelSection.value = 'root'; modelQuery.value = ''; } if (menu.value) emit('loadCapabilities'); }
function openModelList() { modelSection.value = 'models'; modelQuery.value = ''; }
function normalizeSelectedEffort(selected:ModelOption|undefined){const options=selected?.supportedReasoningEfforts??[];if(!options.length||options.includes(effort.value as ReasoningEffort))return;effort.value=selected?.defaultReasoningEffort??options[0]}
function chooseModel(value: string) { runtimeTouched.model = true; model.value = value; modelSection.value = 'root'; modelQuery.value = ''; }
function chooseEffort(value: RuntimeConfig['effort']) { runtimeTouched.effort = true; effort.value = value; modelSection.value = 'root'; }
function setAccessPreset(value: 'request' | 'guarded' | 'full') { runtimeTouched.sandbox = true; runtimeTouched.approvalPolicy = true; if (value === 'full'&&props.defaults.allowDangerFullAccess) { sandbox.value = 'danger-full-access'; approvalPolicy.value = 'never'; } else if (value === 'guarded') { sandbox.value = 'workspace-write'; approvalPolicy.value = 'untrusted'; } else { sandbox.value = 'workspace-write'; approvalPolicy.value = 'on-request'; } menu.value = null; }
function closeMenu() { menu.value = null; modelSection.value = 'root'; modelQuery.value = ''; }
function outside(event: PointerEvent) { if (root.value && !root.value.contains(event.target as Node)) closeMenu(); }
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));

// Slash command list builder
function buildSlashItems(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const skills = props.skills.filter(x => x.enabled && (!q || x.name.toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q)));
  const apps = props.apps.filter(x => x.isAccessible && x.isEnabled && (!q || x.name.toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q)));
  return [...skills.map(item => ({ kind: 'skill' as const, item })), ...apps.map(item => ({ kind: 'app' as const, item }))];
}

// File search for @ mentions
function searchFiles(query: string) {
  if (searchTimer) clearTimeout(searchTimer);
  if (searchAbort) { searchAbort.abort(); searchAbort = null; }
  if (!query.trim() || !props.cwd) { mentionItems.value = []; return; }
  searchTimer = setTimeout(async () => {
    try {
      const results = await api.fileSearch(query, props.cwd);
      mentionItems.value = results.slice(0, 20);
      mentionIndex.value = 0;
    } catch { mentionItems.value = []; }
  }, 200);
}

function closePickers() { slashOpen.value = false; mentionOpen.value = false; if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; } }

function selectSlashCommand(cmd: SlashCommand) {
  if (cmd.kind === 'skill') { selectedSkill.value = cmd.item; }
  else { text.value += (text.value && !text.value.endsWith(' ') ? ' ' : '') + '[@' + cmd.item.name + '] '; }
  // Remove the slash query from text
  text.value = text.value.replace(/\/\S*$/, '');
  closePickers();
  nextTick(() => input.value?.focus());
}

function selectMention(item: FileSearchResult) {
  const name = item.file_name;
  mentions.value.push({ name, path: item.path });
  // Remove the @query from text
  text.value = text.value.replace(/@\S*$/, '');
  closePickers();
  nextTick(() => input.value?.focus());
}

function removeMention(index: number) { mentions.value.splice(index, 1); }

function keydown(event: KeyboardEvent) {
  // Slash command navigation
  if (slashOpen.value && slashItems.value.length) {
    if (event.key === 'ArrowDown') { event.preventDefault(); slashIndex.value = (slashIndex.value + 1) % slashItems.value.length; return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); slashIndex.value = (slashIndex.value - 1 + slashItems.value.length) % slashItems.value.length; return; }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); selectSlashCommand(slashItems.value[slashIndex.value]); return; }
    if (event.key === 'Escape') { event.preventDefault(); closePickers(); return; }
  }
  // Mention navigation
  if (mentionOpen.value && mentionItems.value.length) {
    if (event.key === 'ArrowDown') { event.preventDefault(); mentionIndex.value = (mentionIndex.value + 1) % mentionItems.value.length; return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); mentionIndex.value = (mentionIndex.value - 1 + mentionItems.value.length) % mentionItems.value.length; return; }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); selectMention(mentionItems.value[mentionIndex.value]); return; }
    if (event.key === 'Escape') { event.preventDefault(); closePickers(); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
}

function onInput() {
  resize();
  detectPicker();
}

// Detect / or @ at cursor position
function detectPicker() {
  const value = text.value;
  const caret = input.value?.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  // Check for / at start of line or after space
  const slashMatch = before.match(/(?:^|\s)\/(\S*)$/);
  if (slashMatch) {
    slashQuery.value = slashMatch[1];
    slashItems.value = buildSlashItems(slashQuery.value);
    slashIndex.value = 0;
    slashOpen.value = true;
    mentionOpen.value = false;
    return;
  }
  // Check for @ followed by search text
  const mentionMatch = before.match(/(?:^|\s)@(\S*)$/);
  if (mentionMatch) {
    mentionQuery.value = mentionMatch[1];
    mentionOpen.value = true;
    slashOpen.value = false;
    searchFiles(mentionQuery.value);
    return;
  }
  closePickers();
}

function submit() {
  const value = text.value.trim();
  if ((!value && !attachments.value.length && !selectedSkill.value && !mentions.value.length) || props.disabled || props.occupied) return;
  closePickers();
  const items: UserInput[] = [];
  // Mentions are sent as mention inputs
  items.push(...mentions.value.map(m => ({ type: 'mention' as const, name: m.name, path: m.path })));
  if (value) items.push({ type: 'text', text: value });
  if (selectedSkill.value) items.push({ type: 'skill', name: selectedSkill.value.name, path: selectedSkill.value.path });
  items.push(...attachments.value.map(x => x.input));
  emit('send', { text: value || [...mentions.value.map(m => '@' + m.name), ...attachments.value.map(x => x.name)].join(', '), input: items, runtime: { model: model.value || undefined, effort: effort.value, approvalPolicy: approvalPolicy.value, sandbox: sandbox.value } });
  text.value = ''; attachments.value = []; attachmentError.value = ''; selectedSkill.value = undefined; mentions.value = [];
  nextTick(resize);
}
function resize() { if (!input.value) return; input.value.style.height = 'auto'; input.value.style.height = Math.min(input.value.scrollHeight, 220) + 'px'; }
async function onPaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items;
  if (!items) return;
  const fileList: File[] = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) fileList.push(file);
    }
  }
  if (fileList.length) {
    event.preventDefault();
    await addFiles(fileList);
  }
}
const dragOver = ref(false);
function onDragOver(event: DragEvent) { event.preventDefault(); if (event.dataTransfer?.types.includes('Files')) dragOver.value = true; }
function onDragLeave(event: DragEvent) { if (event.relatedTarget === null || !(root.value?.contains(event.relatedTarget as Node))) dragOver.value = false; }
async function onDrop(event: DragEvent) {
  event.preventDefault();
  dragOver.value = false;
  const fileList = [...(event.dataTransfer?.files || [])];
  if (fileList.length) await addFiles(fileList);
}
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 6_500_000;
const MAX_IMAGE_BYTES = 5_900_000;
async function addFiles(list: File[]) {
  attachmentError.value = '';
  let total = attachments.value.reduce((sum, item) => sum + item.bytes, 0);
  let skipped = 0;
  for (const file of list) {
    if (attachments.value.length >= MAX_ATTACHMENTS || total + file.size > MAX_ATTACHMENT_BYTES || (file.type.startsWith('image/') && file.size > MAX_IMAGE_BYTES)) {
      skipped++;
      continue;
    }
    try {
      const input = file.type.startsWith('image/')
        ? { type: 'image' as const, url: await dataUrl(file), name: file.name || '粘贴图片' }
        : { type: 'text' as const, text: 'File: ' + file.name + '\n\n' + await file.text() };
      attachments.value.push({ name: input.type === 'image' ? input.name || '粘贴图片' : file.name, bytes: file.size, input });
      total += file.size;
    } catch {
      skipped++;
    }
  }
  if (skipped) attachmentError.value = `部分文件未添加：最多 ${MAX_ATTACHMENTS} 个文件、合计 ${Math.floor(MAX_ATTACHMENT_BYTES / 1_000_000)} MB；单张图片不超过 ${Math.floor(MAX_IMAGE_BYTES / 1_000_000)} MB。`;
}
async function files(event: Event) {
  const list = [...((event.target as HTMLInputElement).files || [])];
  await addFiles(list);
  if (fileInput.value) fileInput.value.value = '';
}
function dataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }); }
function openAttachmentImage(url: string) {
  if (!url.startsWith('data:image/')) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}
function chooseSkill(skill: SkillOption) { selectedSkill.value = skill; menu.value = null; }
function chooseApp(app: AppOption) { text.value += (text.value ? ' ' : '') + '[@' + app.name + '] '; menu.value = null; nextTick(() => input.value?.focus()); }
function slashIcon(cmd: SlashCommand) { return cmd.kind === 'skill' ? '◇' : '▦'; }
function fileIcon(item: FileSearchResult) { return item.match_type === 'directory' ? '▤' : '≗'; }
function slashLabel(cmd: SlashCommand) { return cmd.kind === 'skill' ? cmd.item.name : cmd.item.name; }
function slashDesc(cmd: SlashCommand) { return cmd.kind === 'skill' ? (cmd.item.description || 'Codex 技能') : (cmd.item.description || '已安装插件'); }
</script>

<template>
  <footer class="composer-wrap">
    <div v-if="menu || slashOpen || mentionOpen" class="composer-backdrop" @pointerdown="closeMenu(); closePickers()"></div>
    <div v-if="queued" class="queue-label">{{ queued }} 条消息{{ online ? '正在等待发送' : '已保存在此设备' }}</div>
    <div ref="root" class="composer-box composer-enhanced" :class="{ 'drag-active': dragOver }" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">

      <div v-if="attachments.length || selectedSkill || mentions.length" class="composer-chips">
        <span v-if="selectedSkill" class="composer-chip skill-chip">技能：{{ selectedSkill.name }}<button title="移除技能" @click="selectedSkill = undefined">×</button></span>
        <span v-for="(m, index) in mentions" :key="m.path + index" class="composer-chip mention-chip">@{{ m.name }}<button title="移除引用" @click="removeMention(index)">×</button></span>
        <span v-for="(item, index) in attachments" :key="item.name + index" class="composer-attachment" :class="{ 'composer-image-attachment': item.input.type === 'image' }">
          <img v-if="item.input.type === 'image'" class="composer-image-preview" :src="item.input.url" :alt="item.name" @click="openAttachmentImage(item.input.url)">
          <span class="composer-attachment-name">{{ item.name }}</span>
          <button title="移除附件" @click="attachments.splice(index, 1)">×</button>
        </span>
      </div>
      <p v-if="attachmentError" class="composer-upload-error" role="alert">{{ attachmentError }}</p>

      <!-- Slash command popover -->
      <div v-if="slashOpen && slashItems.length" class="composer-popover slash-popover acrylic-panel">
        <h3>命令</h3>
        <button v-for="(cmd, i) in slashItems" :key="i" class="menu-row" :class="{ selected: i === slashIndex }" @click="selectSlashCommand(cmd)" @mouseenter="slashIndex = i">
          <span class="menu-icon" :class="cmd.kind === 'skill' ? 'skill-menu-icon' : 'plugin-menu-icon'">{{ slashIcon(cmd) }}</span>
          <span><b>{{ slashLabel(cmd) }}</b><small>{{ slashDesc(cmd) }}</small></span>
        </button>
      </div>

      <!-- Mention file search popover -->
      <div v-if="mentionOpen" class="composer-popover mention-popover acrylic-panel">
        <h3>文件{{ mentionQuery ? '：' + mentionQuery : '' }}</h3>
        <button v-for="(item, i) in mentionItems" :key="item.path" class="menu-row" :class="{ selected: i === mentionIndex }" @click="selectMention(item)" @mouseenter="mentionIndex = i">
          <span class="menu-icon file-menu-icon">{{ fileIcon(item) }}</span>
          <span><b>{{ item.file_name }}</b><small>{{ item.path }}</small></span>
        </button>
        <p v-if="!mentionItems.length && mentionQuery">{{ mentionQuery ? '搜索中…' : '输入文件名搜索' }}</p>
        <p v-if="!mentionQuery">输入 @ 后跟文件名搜索当前项目文件</p>
      </div>

      <textarea ref="input" v-model="text" rows="1" :disabled="disabled" :placeholder="offlineMode ? '离线模式 · 历史只读' : disabled ? '选择会话后输入' : occupied ? '正被本机 Codex 占用，等待回复结束后即可发送…' : '给 Codex 发送消息…  / 命令  @ 引用文件'" aria-label="消息" @keydown="keydown" @input="onInput" @paste="onPaste"></textarea>
      <input ref="fileInput" type="file" multiple hidden @change="files">
      <div class="composer-tools">
        <div class="composer-anchor composer-add-anchor">
          <button class="composer-plus" title="添加" :disabled="disabled" @click="toggle('add')">+</button>
          <div v-if="menu === 'add'" class="composer-popover add-popover acrylic-panel"><h3>添加到对话</h3><button class="menu-row" @click="fileInput?.click(); menu = null"><span class="menu-icon file-menu-icon">+</span><span><b>文件和文件夹</b><small>上传图片或文本文件</small></span></button><div class="menu-label">技能</div><button v-for="skill in skills.filter(x => x.enabled)" :key="skill.path" class="menu-row" @click="chooseSkill(skill)"><span class="menu-icon skill-menu-icon">◇</span><span><b>{{ skill.name }}</b><small>{{ skill.description || 'Codex 技能' }}</small></span></button><div class="menu-label">插件</div><button v-for="app in apps.filter(x => x.isAccessible && x.isEnabled)" :key="app.id" class="menu-row" @click="chooseApp(app)"><span class="menu-icon plugin-menu-icon">▦</span><span><b>{{ app.name }}</b><small>{{ app.description || '已安装插件' }}</small></span></button><p v-if="capabilitiesLoading">正在读取能力…</p><p v-else-if="!skills.length && !apps.length">当前没有可用技能或插件</p></div>
        </div>
        <div class="composer-anchor composer-access-anchor">
          <button class="runtime-summary access combined-access" title="调整访问与批准方式" @click="toggle('access')"><span class="access-badge"><svg v-if="accessPreset === 'request'" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><svg v-else-if="accessPreset === 'guarded'" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg><svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg></span>{{ accessLabel }}</button>
          <div v-if="menu === 'access'" class="composer-popover access-popover acrylic-panel"><h3>应如何批准 Codex 操作？</h3><button class="access-option" :class="{ selected: accessPreset === 'request' }" @click="setAccessPreset('request')"><span class="access-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span><span><b>请求批准</b><small>编辑外部文件和使用互联网时始终询问</small></span><i>✓</i></button><button class="access-option" :class="{ selected: accessPreset === 'guarded' }" @click="setAccessPreset('guarded')"><span class="access-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 4v6c0 5-3.5 8.5-9 10-5.5-1.5-9-5-9-10V6z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg></span><span><b>帮我批准</b><small>仅对检测到的风险操作请求批准</small></span><i>✓</i></button><button v-if="props.defaults.allowDangerFullAccess" class="access-option danger" :class="{ selected: accessPreset === 'full' }" @click="setAccessPreset('full')"><span class="access-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg></span><span><b>完全访问权限</b><small>可不受限制地访问互联网和此电脑上的文件</small></span><i>✓</i></button></div>
        </div>
        <div class="composer-spacer"></div>
        <div class="composer-anchor composer-model-anchor">
          <button class="runtime-pill" title="模型和推理强度" @click="toggle('model')"><strong>{{ selectedModel?.displayName || model || '模型' }}</strong><span>{{ effort }}</span></button>
          <div v-if="menu === 'model'" class="composer-popover model-settings-popover acrylic-panel"><section v-if="modelSection === 'root'" class="model-settings-root"><button @click="openModelList"><b>模型</b><span>{{ selectedModel?.displayName || model || '默认' }}</span><i>›</i></button><button class="selected" @click="modelSection = 'effort'"><b>推理强度</b><span>{{ effort }}</span><i>›</i></button><div class="model-settings-divider"></div></section><section v-else-if="modelSection === 'models'" class="model-choice-panel"><h3><button class="back-button" @click="modelSection = 'root'">‹</button>模型</h3><label class="model-search"><span>⌕</span><input v-model="modelQuery" type="search" placeholder="搜索模型" aria-label="搜索模型"></label><p v-if="capabilitiesLoading && !models.length">正在读取模型…</p><button v-if="configuredModelVisible" :class="{ selected: model === defaults.model }" @click="chooseModel(defaults.model!)"><span><b>{{ defaults.model }}</b><small>当前配置模型</small></span><i v-if="model === defaults.model">✓</i></button><button v-for="item in filteredModels" :key="item.id" :class="{ selected: model === item.model }" @click="chooseModel(item.model)"><span><b>{{ item.displayName }}</b><small>{{ item.description || item.model }}</small></span><i v-if="model === item.model">✓</i></button><p v-if="!capabilitiesLoading && !models.length && !configuredModelVisible">没有读取到可用模型</p><p v-else-if="!capabilitiesLoading && !filteredModels.length && !configuredModelVisible">没有匹配的模型</p></section><section v-else class="effort-choice-panel"><h3><button class="back-button" @click="modelSection = 'root'">‹</button>推理强度</h3><button v-for="item in effortOptions" :key="item" :class="{ selected: effort === item }" @click="chooseEffort(item)"><b>{{ item }}</b><i v-if="effort === item">✓</i></button></section></div>
        </div>
        <button v-if="activeTurn" class="stop-button" :class="{ occupied: occupied }" :title="occupied ? '正被本机 Codex 占用' : '停止'" :disabled="occupied" @click="occupied ? undefined : $emit('cancel')">■</button><button v-else class="send-button" title="发送" :disabled="disabled || occupied || (!text.trim() && !attachments.length && !selectedSkill && !mentions.length)" @click="submit">↑</button>
      </div>
    </div>
  </footer>
</template>
