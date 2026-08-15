<script setup lang="ts">
import { computed } from 'vue';
import type { BridgeEvent, Message } from '@remote/shared';
import CopyButton from './CopyButton.vue';
import MarkdownContent from './MarkdownContent.vue';
import ToolCallGroup from './ToolCallGroup.vue';
import ReasoningPanel from './ReasoningPanel.vue';
import CompactionBanner from './CompactionBanner.vue';

type ToolSegment = { kind: 'tools'; group: BridgeEvent[] };
type ToolClusterSegment = { kind: 'tool-cluster'; groups: BridgeEvent[][] };
type ReasoningSegment = { kind: 'reasoning'; events: BridgeEvent[] };
type CompactionSegment = { kind: 'compaction'; event: BridgeEvent };
type ErrorSegment = { kind: 'error'; event: BridgeEvent };
type MessageSegment = { kind: 'message'; message: Message };
type Segment = ToolSegment | ToolClusterSegment | ReasoningSegment | CompactionSegment | ErrorSegment | MessageSegment;

// Single-message mode (user) or multi-message mode (assistant turn)
const props = defineProps<{
  message?: Message;
  messages?: Message[];
  segments?: Segment[];
  state?: string;
}>();

defineEmits<{ openDiff: [diff: string, title: string]; editPending: [message: Message] }>();

const time = (value: string) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

const renderMessages = computed(() => props.messages ?? (props.message ? [props.message] : []));
const isAssistant = computed(() => renderMessages.value[0]?.role === 'assistant');
// A message with msg_id starting with 'stream:' is actively being streamed from the backend
const isStreaming = computed(() => renderMessages.value.some(m => m.msg_id.startsWith('stream:')));
const combinedContent = computed(() => renderMessages.value.map(m => m.content).filter(Boolean).join('\n\n'));
const allReferences = computed(() => renderMessages.value.flatMap(m => m.references ?? []));
const imageReferences = computed(() => allReferences.value.filter(r => r.type === 'file' && (r as any).url));
// References shown as chips; exclude all clipboard image refs (rendered as <img> above or no longer needed)
const chipReferences = computed(() => allReferences.value.filter(r => !(r.type === 'file' && (/codex-clipboard/i.test(r.label) || (r as any).url))));
const effectiveSegments = computed<Segment[]>(() => props.segments ?? (isAssistant.value ? renderMessages.value.filter(m => m.content).map(m => ({ kind: 'message' as const, message: m })) : []));

function openImage(url: string) {
  // Only allow data:image URLs to prevent XSS
  if (!url.startsWith('data:image/')) return;
  const win = window.open();
  if (win) {
    const img = win.document.createElement('img');
    img.src = url;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100vh';
    win.document.title = '图片';
    win.document.body.style.margin = '0';
    win.document.body.style.display = 'flex';
    win.document.body.style.alignItems = 'center';
    win.document.body.style.justifyContent = 'center';
    win.document.body.appendChild(img);
  }
}
</script>

<template>
  <article class="message-row" :class="isAssistant ? 'assistant' : 'user'">
    <img v-if="isAssistant" class="avatar avatar-openai" src="/icon.svg" alt="">
    <div class="message-stack">
      <div v-if="chipReferences.length" class="message-references">
        <span v-for="(reference, i) in chipReferences" :key="i" class="reference-chip" :class="reference.type" :title="reference.path">
          <i class="reference-icon" aria-hidden="true"><span v-if="reference.type === 'annotation'" class="notebook-icon"></span><template v-else>{{ reference.type === 'file' ? '⌘' : '◇' }}</template></i><b>{{ reference.label }}</b>
          <span v-if="reference.detail" class="reference-preview"><CopyButton :text="reference.detail" label="复制批注"/><MarkdownContent :content="reference.detail"/></span>
        </span>
      </div>

      <template v-if="isAssistant">
        <div class="assistant-turn-content">
          <!-- Render segments in timeline order: reasoning, tool groups, compaction, messages -->
          <template v-for="(segment, si) in effectiveSegments" :key="`seg-${si}`">
            <ReasoningPanel
              v-if="segment.kind === 'reasoning'"
              :events="segment.events"
            />
            <CompactionBanner
              v-else-if="segment.kind === 'compaction'"
              :event="segment.event"
            />
            <div v-else-if="segment.kind === 'error'" class="provider-error-banner">
              <span class="provider-error-icon" aria-hidden="true">⚠</span>
              <span class="provider-error-text">{{ segment.event.content || '服务暂时不可用' }}</span>
            </div>
            <ToolCallGroup
              v-else-if="segment.kind === 'tools'"
              :events="segment.group"
              @open-diff="(d, t) => $emit('openDiff', d, t)"
            />
            <ToolCallGroup
              v-else-if="segment.kind === 'tool-cluster'"
              :clusters="segment.groups"
              @open-diff="(d, t) => $emit('openDiff', d, t)"
            />
            <div v-else-if="segment.kind === 'message' && segment.message.content" class="message-bubble assistant" :class="{ 'message-streaming': isStreaming }">
              <MarkdownContent :content="segment.message.content" :streaming="isStreaming"/>
            </div>
          </template>
        </div>

        <div class="assistant-footer">
          <CopyButton class="assistant-copy" :text="combinedContent" label="复制回复"/>
          <small class="message-meta">{{ time(renderMessages[renderMessages.length - 1].timestamp) }}<span v-if="state"> · {{ state }}</span></small>
        </div>
      </template>

      <template v-else>
        <div v-if="imageReferences.length || renderMessages[0]?.content" class="message-bubble user">
          <div v-if="imageReferences.length" class="user-images-inline">
            <img v-for="(img, i) in imageReferences" :key="i" :src="(img as any).url" :alt="img.label" class="user-image" @click="(img as any).url && openImage((img as any).url)">
          </div>
          <div v-if="renderMessages[0]?.content" class="plain-message">{{ renderMessages[0].content }}</div>
        </div>
        <div class="user-footer">
          <CopyButton class="user-copy" :text="renderMessages[0].content" label="复制回复"/>
          <button v-if="state && renderMessages[0]?.client_id" class="message-edit" title="编辑待发送消息" aria-label="编辑待发送消息" @click="$emit('editPending', renderMessages[0])">✎</button>
          <small class="message-meta">{{ time(renderMessages[0].timestamp) }}<span v-if="state"> · {{ state }}</span></small>
        </div>
      </template>
    </div>
  </article>
</template>
