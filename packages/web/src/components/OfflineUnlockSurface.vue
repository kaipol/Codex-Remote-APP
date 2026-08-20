<script setup lang="ts">
import { ref, computed } from 'vue';
import { offlinePasswordIsValid } from '../composables/offlineAccess';

const props = defineProps<{ busy: boolean; error: string; hasPassword?: boolean }>();
const emit = defineEmits<{ unlock: [password: string]; exit: [] }>();

const password = ref('');
const confirm = ref('');
const showPassword = ref(false);

const firstValid = computed(() => offlinePasswordIsValid(password.value));
const canVerify = computed(() => firstValid.value);
const canSetup = computed(() => firstValid.value && password.value.trim() === confirm.value.trim());

function submit() {
  const value = password.value.trim();
  // Already-protected cache: verify the existing password.
  if (props.hasPassword) {
    if (!offlinePasswordIsValid(value)) return;
    emit('unlock', value);
    return;
  }
  // First-time setup: require matching confirmation before establishing the lock.
  if (!canSetup.value) return;
  emit('unlock', value);
}
</script>

<template>
  <main class="pairing">
    <section class="pair-card">
      <img class="pair-logo" src="/icon.svg" alt="Codex Remote">
      <p class="eyebrow">离线访问</p>
      <h1>{{ hasPassword ? '查看缓存对话' : '设置离线访问密码' }}</h1>
      <p v-if="hasPassword">本地端服务未运行。输入离线访问密码即可查看此设备上缓存的历史对话。</p>
      <p v-else>本地端服务未运行，但此设备已有缓存的历史对话。首次查看需设置一个离线访问密码，之后每次离线查看都需要此密码。</p>
      <label>离线访问密码
        <input v-model.trim="password" :type="showPassword ? 'text' : 'password'" inputmode="text" autocomplete="off" :placeholder="hasPassword ? '输入离线访问密码' : '设置新的离线访问密码（至少 8 位）'" @keyup.enter="submit">
        <span class="password-toggle" role="button" tabindex="0" @click="showPassword = !showPassword" @keyup.enter="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</span>
      </label>
      <label v-if="!hasPassword">确认离线访问密码
        <input v-model.trim="confirm" :type="showPassword ? 'text' : 'password'" inputmode="text" autocomplete="off" placeholder="再次输入相同的密码" @keyup.enter="submit">
      </label>
      <button class="primary wide" :disabled="busy || (hasPassword ? !canVerify : !canSetup)" @click="submit">{{ busy ? (hasPassword ? '正在验证…' : '正在设置…') : (hasPassword ? '查看缓存对话' : '设置并查看缓存对话') }}</button>
      <p v-if="!hasPassword && password && !firstValid" class="form-error">密码至少 8 位</p>
      <p v-else-if="!hasPassword && password && confirm && password !== confirm" class="form-error">两次输入不一致</p>
      <p v-if="error" class="form-error">{{ error }}</p>
      <button type="button" class="text-button wide exit-offline" @click="$emit('exit')">返回配对</button>
      <div class="pair-security">
        <span>◇</span>
        <div>
          <strong>仅本地验证</strong>
          <small>密码仅于此设备校验，不会发送到服务器或任何第三方。历史数据来自缓存，可能不是最新。</small>
        </div>
      </div>
    </section>
  </main>
</template>
