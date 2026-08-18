<script setup lang="ts">
defineProps<{online:boolean;ws:string;appServer:string;pending:number;serverOffline:boolean}>();
</script>
<template>
  <div v-if="!online||ws!=='connected'||appServer==='error'||pending||serverOffline" class="connection-banner" :class="{warning:online,error:appServer==='error'}" role="status">
    <span class="status-dot"></span>
    <span v-if="!online">离线模式 · 历史仍可阅读，消息将在恢复后发送</span>
    <span v-else-if="serverOffline">服务器离线 · 正在显示缓存对话，恢复后自动重连</span>
    <span v-else-if="ws==='connecting'">连接中断 · 正在同步并重连…</span>
    <span v-else-if="ws==='offline'">无法连接 · 请检查网络</span>
    <span v-else-if="appServer==='error'">Codex app-server 暂不可用</span>
    <span v-else>{{pending}} 条消息等待发送</span>
  </div>
</template>
