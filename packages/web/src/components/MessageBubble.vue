<script setup lang="ts">
import { computed } from 'vue';
import type { BridgeEvent, Message } from '@remote/shared';
import CopyButton from './CopyButton.vue';
import MarkdownContent from './MarkdownContent.vue';
import ToolCallGroup from './ToolCallGroup.vue';

type ToolSegment = { kind: 'tools'; group: BridgeEvent[] };
type MessageSegment = { kind: 'message'; message: Message };
type Segment = ToolSegment | MessageSegment;

// Single-message mode (user) or multi-message mode (assistant turn)
const props = defineProps<{
  message?: Message;
  messages?: Message[];
  segments?: Segment[];
  state?: string;
}>();

defineEmits<{ openDiff: [diff: string, title: string] }>();

const time = (value: string) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

const renderMessages = computed(() => props.messages ?? (props.message ? [props.message] : []));
const isAssistant = computed(() => renderMessages.value[0]?.role === 'assistant');
const combinedContent = computed(() => renderMessages.value.map(m => m.content).filter(Boolean).join('\n\n'));
const allReferences = computed(() => renderMessages.value.flatMap(m => m.references ?? []));
</script>

<template>
  <article class="message-row" :class="isAssistant ? 'assistant' : 'user'">
    <div v-if="isAssistant" class="avatar avatar-openai"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg></div>
    <div class="message-stack">
      <div v-if="allReferences.length" class="message-references">
        <span v-for="(reference, i) in allReferences" :key="i" class="reference-chip" :class="reference.type" :title="reference.path">
          <i class="reference-icon" aria-hidden="true"><span v-if="reference.type === 'annotation'" class="notebook-icon"></span><template v-else>{{ reference.type === 'file' ? '⌘' : '◇' }}</template></i><b>{{ reference.label }}</b>
          <span v-if="reference.detail" class="reference-preview"><CopyButton :text="reference.detail" label="复制批注"/><MarkdownContent :content="reference.detail"/></span>
        </span>
      </div>

      <template v-if="isAssistant">
        <div class="assistant-turn-content">
          <!-- Render segments in timeline order: tool groups interleaved with messages -->
          <template v-for="(segment, si) in segments" :key="`seg-${si}`">
            <ToolCallGroup
              v-if="segment.kind === 'tools'"
              :events="segment.group"
              @open-diff="(d, t) => $emit('openDiff', d, t)"
            />
            <div v-else-if="segment.message.content" class="message-bubble assistant">
              <MarkdownContent :content="segment.message.content"/>
            </div>
          </template>
        </div>

        <div class="assistant-footer">
          <CopyButton class="assistant-copy" :text="combinedContent" label="复制回复"/>
          <small class="message-meta">{{ time(renderMessages[renderMessages.length - 1].timestamp) }}<span v-if="state"> · {{ state }}</span></small>
        </div>
      </template>

      <template v-else>
        <div v-if="renderMessages[0]?.content" class="message-bubble user">
          <div class="plain-message">{{ renderMessages[0].content }}</div>
        </div>
        <div class="user-footer">
          <CopyButton class="user-copy" :text="renderMessages[0].content" label="复制回复"/>
          <small class="message-meta">{{ time(renderMessages[0].timestamp) }}<span v-if="state"> · {{ state }}</span></small>
        </div>
      </template>
    </div>
  </article>
</template>
