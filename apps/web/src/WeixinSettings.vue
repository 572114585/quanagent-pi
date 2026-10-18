<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import QRCode from "qrcode";
import type { WeixinPhase, WeixinSnapshot } from "../../../packages/web-server/src/protocol.ts";
import { useChat } from "./chat.ts";

const chat = useChat();
const status = ref<WeixinSnapshot>();
const selectedModel = ref("");
const code = ref("");
const qrImage = ref("");
const error = ref("");
const busy = ref(false);
let disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
const labels: Record<WeixinPhase, string> = {
  disconnected: "未连接", starting: "正在连接", qr: "请用微信扫描二维码",
  scanned: "已扫码，请在微信中确认", expired: "二维码已过期，正在刷新",
  verify_code: "请输入微信中显示的配对码", connected: "微信已连接",
  stopping: "正在断开并保存会话", error: "连接失败",
};
const active = computed(() => status.value && !["disconnected", "error"].includes(status.value.phase));
watch(() => status.value?.challengeId, () => { code.value = ""; });
watch(() => status.value?.qrContent, async (content) => {
  qrImage.value = "";
  if (!content) return;
  try {
    const image = await QRCode.toDataURL(content, { width: 256, margin: 4, color: { dark: "#000000", light: "#ffffff" } });
    if (!disposed && status.value?.qrContent === content) qrImage.value = image;
  } catch { error.value = "二维码生成失败，请重新扫码"; }
});
async function poll() {
  const ticket = revision;
  try {
    const next = await chat.weixinStatus();
    if (!disposed && !busy.value && ticket === revision) {
      status.value = next;
      error.value = "";
    }
  } catch (cause) {
    if (!disposed && ticket === revision) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!disposed && chat.loggedIn) timer = setTimeout(poll, 2000);
  }
}
async function act(action: "connect" | "force" | "disconnect" | "verify") {
  if (busy.value) return;
  busy.value = true;
  revision++;
  error.value = "";
  try {
    if (action === "disconnect") status.value = await chat.disconnectWeixin();
    else if (action === "verify") {
      const current = status.value;
      if (!current?.attemptId || !current.challengeId) return;
      status.value = await chat.verifyWeixinCode(current.attemptId, current.challengeId, code.value);
      code.value = "";
    } else {
      const model = chat.models.find((item) => JSON.stringify([item.provider, item.id]) === selectedModel.value);
      status.value = await chat.connectWeixin({ force: action === "force", ...(model ? { provider: model.provider, model: model.id } : {}) });
    }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
onMounted(() => { void poll(); });
onUnmounted(() => { disposed = true; if (timer) clearTimeout(timer); code.value = ""; });
</script>

<template>
  <div class="form weixin-settings">
    <p class="muted">微信使用独立的会话和工作目录。关闭网页后仍可继续收发消息。</p>
    <p role="status" aria-live="polite">{{ status ? labels[status.phase] : "正在读取连接状态" }}</p>
    <template v-if="status">
      <label v-if="!status.configured">微信使用的模型
        <select v-model="selectedModel" :disabled="busy || active">
          <option value="" disabled>请选择已配置的模型</option>
          <option v-for="model in chat.models" :key="JSON.stringify([model.provider, model.id])" :value="JSON.stringify([model.provider, model.id])">{{ model.provider }} / {{ model.name || model.id }}</option>
        </select>
      </label>
      <p v-else-if="status.provider" class="muted">模型：{{ status.provider }} / {{ status.model }}</p>
      <p v-if="!status.configured" class="muted">首次扫码账号将成为 owner，其他微信用户默认无权使用。</p>
      <img v-if="qrImage" class="weixin-qr" :src="qrImage" alt="微信连接二维码，请使用微信扫一扫" width="256" height="256" />
      <form v-if="status.phase === 'verify_code'" class="form" @submit.prevent="act('verify')">
        <p v-if="status.codeRetry" class="danger">配对码不匹配，请重新输入。</p>
        <label>配对码<input v-model="code" inputmode="numeric" pattern="[0-9]{1,32}" maxlength="32" autocomplete="off" required :disabled="busy" /></label>
        <button class="primary" :disabled="busy || !code">提交配对码</button>
      </form>
      <p v-if="status.accountId" class="muted weixin-account">账号：{{ status.accountId }}</p>
      <p v-if="status.phase === 'connected'" class="muted">可以从微信向 Pi 发送消息。服务重启后将自动恢复连接。</p>
      <p v-if="status.error" role="alert" class="danger">{{ chat.weixinError(status.error) }}</p>
      <div class="row weixin-actions">
        <button v-if="!active" class="primary" :disabled="busy || (!status.configured && !selectedModel)" @click="act('connect')">连接微信</button>
        <button v-if="active" :disabled="busy || status.phase === 'stopping'" @click="act('disconnect')">{{ status.phase === 'connected' ? "断开连接" : "取消连接" }}</button>
        <button v-if="status.configured || active" :disabled="busy || status.phase === 'stopping'" @click="act('force')">重新扫码</button>
      </div>
    </template>
    <p v-if="error" role="alert" class="danger">{{ error }}</p>
  </div>
</template>

<style scoped>
.weixin-settings { margin-top: 20px; }
.weixin-qr { align-self: center; max-width: 100%; height: auto; border-radius: 8px; background: white; }
.weixin-account { overflow-wrap: anywhere; }
.weixin-actions { flex-wrap: wrap; }
</style>
