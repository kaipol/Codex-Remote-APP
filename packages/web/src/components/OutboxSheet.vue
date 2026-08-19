<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Session } from '@remote/shared';
import type { Pending } from '../db';
import { isPendingCancellable } from '../composables/outbox';

const props=defineProps<{open:boolean;items:Pending[];sessions:Session[]}>();
defineEmits<{close:[];openConversation:[item:Pending];cancel:[item:Pending]}>();
const expanded=ref<string|null>(null);

const items=computed(()=>[...props.items].sort((a,b)=>a.created_at.localeCompare(b.created_at)));
const statusLabel:Record<Pending['status'],string>={
  pending:'等待发送',
  waiting:'等待当前回复结束',
  sending:'正在提交',
  failed:'发送失败',
  quarantined:'需要重新确认',
  sent:'已发送，等待对话同步',
};

function conversationTitle(item:Pending){
  return props.sessions.find(session=>session.session_id===item.session_id)?.title||'对应对话暂不可用';
}
function preview(item:Pending){
  const content=item.content.trim();
  return content||'包含附件、文件引用或技能';
}
</script>

<template>
  <div v-if="open" class="outbox-backdrop" @click.self="$emit('close')">
    <section class="outbox-sheet" role="dialog" aria-modal="true" aria-label="发送队列">
      <header>
        <div>
          <small>消息状态</small>
          <h2>发送队列</h2>
        </div>
        <button class="icon-button" aria-label="关闭发送队列" @click="$emit('close')">×</button>
      </header>
      <div v-if="!items.length" class="outbox-empty">没有待同步的消息。</div>
      <div v-else class="outbox-list">
        <article v-for="item in items" :key="item.id" class="outbox-item">
          <div class="outbox-item-head">
            <span class="outbox-status" :class="item.status">{{ statusLabel[item.status] }}</span>
            <time>{{ new Date(item.created_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) }}</time>
          </div>
          <div class="outbox-conversation">
            <small>所属对话</small>
            <button class="outbox-link" :disabled="!sessions.some(session=>session.session_id===item.session_id)" @click="$emit('openConversation',item)">{{ conversationTitle(item) }}</button>
          </div>
          <p class="outbox-preview">{{ preview(item) }}</p>
          <pre v-if="expanded===item.id" class="outbox-content">{{ preview(item) }}</pre>
          <footer>
            <button class="text-button" @click="expanded=expanded===item.id?null:item.id">{{ expanded===item.id?'收起内容':'查看内容' }}</button>
            <button class="text-button" :disabled="!sessions.some(session=>session.session_id===item.session_id)" @click="$emit('openConversation',item)">打开对话</button>
            <button v-if="isPendingCancellable(item)" class="text-button danger-text" @click="$emit('cancel',item)">取消发送</button>
          </footer>
        </article>
      </div>
    </section>
  </div>
</template>
