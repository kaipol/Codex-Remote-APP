<script setup lang="ts">
import {reactive} from 'vue';
import type{ApprovalDecision,PendingApproval}from'@remote/shared';
import CopyButton from'./CopyButton.vue';
const props=defineProps<{approvals:PendingApproval[];open:boolean;busyId?:string}>();
const emit=defineEmits<{close:[];decide:[approval:PendingApproval,decision:ApprovalDecision,answers?:Record<string,string[]>]}>();
const answers=reactive<Record<string,string>>({});
function payload(approval:PendingApproval){return approval.payload&&typeof approval.payload==='object'?approval.payload as Record<string,unknown>:{} }
function questions(approval:PendingApproval){const value=payload(approval).questions;return Array.isArray(value)?value as Array<{id:string;header?:string;question:string;isSecret?:boolean}>:[]}
function title(approval:PendingApproval){return approval.kind.includes('file')||approval.kind==='applyPatchApproval'?'文件修改':approval.kind.includes('requestUserInput')?'问题':approval.kind.includes('permissions')?'权限提升':'命令请求'}
function submitAnswers(approval:PendingApproval){const result=Object.fromEntries(questions(approval).map(question=>[question.id,[answers[question.id]?.trim()||'']]));emit('decide',approval,'accept',result)}
</script>
<template>
  <div v-if="open" class="approval-backdrop" @click.self="$emit('close')">
    <section class="approval-sheet" role="dialog" aria-label="待处理审批">
      <header><div><small>需要操作</small><h2>Codex 请求确认</h2></div><button class="icon-button" @click="$emit('close')">×</button></header>
      <p v-if="!approvals.length" class="approval-note">当前没有待处理请求。</p>
      <div v-for="approval in approvals" :key="approval.request_id" class="approval-request">
        <strong>{{title(approval)}}</strong>
        <template v-if="questions(approval).length">
          <label v-for="question in questions(approval)" :key="question.id">
            <span>{{question.header||question.question}}</span>
            <input v-model="answers[question.id]" :type="question.isSecret?'password':'text'" :placeholder="question.question" :disabled="busyId===approval.request_id">
          </label>
          <div class="approval-actions"><button class="primary" :disabled="busyId===approval.request_id||questions(approval).some(question=>!answers[question.id]?.trim())" @click="submitAnswers(approval)">提交回答</button></div>
        </template>
        <template v-else>
          <div class="copy-surface"><CopyButton :text="JSON.stringify(approval.payload,null,2)" label="复制请求"/><pre>{{JSON.stringify(approval.payload,null,2)}}</pre></div>
          <p v-if="approval.kind.includes('permissions')" class="approval-note">额外权限只能拒绝；如需授予，请在 Codex 主机上处理。</p>
          <div class="approval-actions">
            <button :disabled="busyId===approval.request_id" @click="$emit('decide',approval,'decline')">拒绝</button>
            <button class="primary" :disabled="busyId===approval.request_id||approval.kind.includes('permissions')" @click="$emit('decide',approval,'accept')">批准</button>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
