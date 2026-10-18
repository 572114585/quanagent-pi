<script setup lang="ts">
import { ref, watch } from "vue";
import { X, KeyRound } from "lucide-vue-next";
import { useChat, type ProviderOption } from "./chat.ts";
import WeixinSettings from "./WeixinSettings.vue";
defineEmits<{ close: [] }>();
const chat = useChat();
const tab = ref("models");
const providerId = ref("");
const apiKey = ref("");
const baseUrl = ref("");
const api = ref("openai-completions");
const modelId = ref("");
const modelName = ref("");
type ConfiguredModel = NonNullable<
  ProviderOption["configuration"]
>["models"][number];
const configuredModels = ref<ConfiguredModel[]>([]);
const reasoning = ref(false);
const vision = ref(false);
const contextWindow = ref(128000);
const maxTokens = ref(4096);
const saving = ref(false);
const message = ref("");
const keyToRemove = ref("");
const modelToRemove = ref("");

function editModel(model?: ConfiguredModel) {
  modelId.value = model?.id ?? "";
  modelName.value = model?.name ?? "";
  reasoning.value = model?.reasoning ?? false;
  vision.value = model?.vision ?? false;
  contextWindow.value = model?.contextWindow ?? 128000;
  maxTokens.value = model?.maxTokens ?? 4096;
}

function refreshConfiguredModels(preferredId?: string) {
  const config = chat.providers.find(
    (provider) => provider.id === providerId.value,
  )?.configuration;
  configuredModels.value = config?.models ?? [];
  editModel(
    configuredModels.value.find((model) => model.id === preferredId) ??
      configuredModels.value[0],
  );
}

watch(providerId, (value) => {
  apiKey.value = "";
  const config = chat.providers.find(
    (provider) => provider.id === value,
  )?.configuration;
  baseUrl.value = config?.baseUrl ?? "";
  api.value = config?.api ?? "openai-completions";
  configuredModels.value = config?.models ?? [];
  editModel(configuredModels.value[0]);
  modelToRemove.value = "";
});
async function save() {
  saving.value = true;
  message.value = "";
  try {
    await chat.saveProvider(providerId.value.trim(), {
      ...(apiKey.value ? { apiKey: apiKey.value } : {}),
      ...(baseUrl.value
        ? {
            baseUrl: baseUrl.value.trim(),
            api: api.value,
            modelId: modelId.value.trim(),
            modelName: modelName.value.trim(),
            reasoning: reasoning.value,
            vision: vision.value,
            contextWindow: contextWindow.value,
            maxTokens: maxTokens.value,
          }
        : {}),
    });
    apiKey.value = "";
    refreshConfiguredModels(modelId.value.trim());
    message.value = "配置已保存";
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}
function addModel() {
  modelToRemove.value = "";
  editModel();
}
async function removeModel(id: string) {
  saving.value = true;
  message.value = "";
  try {
    await chat.removeModel(providerId.value, id);
    modelToRemove.value = "";
    refreshConfiguredModels();
    message.value = "模型已删除";
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}
async function removeKey(id: string) {
  try {
    await chat.removeKey(id);
    keyToRemove.value = "";
  } catch (error) {
    message.value = String(error);
  }
}
</script>
<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <section
      class="settings panel"
      role="dialog"
      aria-modal="true"
      aria-label="工作空间设置"
      @keydown.esc="$emit('close')"
    >
      <header>
        <div>
          <span class="eyebrow">工作空间设置</span>
          <h2>{{ tab === "models" ? "模型与凭据" : "微信连接" }}</h2>
        </div>
        <button class="icon" aria-label="关闭设置" @click="$emit('close')">
          <X :size="20" />
        </button>
      </header>
      <div class="settings-tabs" role="tablist" aria-label="设置分类">
        <button id="models-tab" role="tab" :aria-selected="tab === 'models'" aria-controls="models-panel" @click="tab = 'models'">模型配置</button>
        <button id="weixin-tab" role="tab" :aria-selected="tab === 'weixin'" aria-controls="weixin-panel" @click="tab = 'weixin'">微信连接</button>
      </div>
      <WeixinSettings v-if="tab === 'weixin'" id="weixin-panel" role="tabpanel" aria-labelledby="weixin-tab" />
      <div v-else id="models-panel" role="tabpanel" aria-labelledby="models-tab">
      <p class="muted">密钥保存在服务端 pi 配置中。留空即可保留现有密钥。</p>
      <div class="provider-list">
        <div
          v-for="provider in chat.providers.filter((p) => p.configured)"
          :key="provider.id"
        >
          <button @click="providerId = provider.id">
            <KeyRound :size="14" />{{ provider.name || provider.id }}
            <small>{{
              provider.authType === "oauth" ? "OAuth" : "已配置"
            }}</small></button
          ><template v-if="keyToRemove === provider.id"
            ><button class="text-button" @click="keyToRemove = ''">取消</button
            ><button class="text-button danger" @click="removeKey(provider.id)">
              确认清除
            </button></template
          ><button
            v-else
            class="text-button danger"
            @click="keyToRemove = provider.id"
          >
            清除凭据
          </button>
        </div>
      </div>
      <form class="form" @submit.prevent="save">
        <label
          >Provider ID<input
            v-model="providerId"
            list="providers"
            required
            placeholder="例如 openai、anthropic 或 my-provider"
            pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
        /></label>
        <datalist id="providers">
          <option
            v-for="provider in chat.providers"
            :key="provider.id"
            :value="provider.id"
          >
            {{ provider.name }}
          </option>
        </datalist>
        <label
          >API Key<input
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
            placeholder="添加或替换密钥"
        /></label>
        <details>
          <summary>自定义 OpenAI 兼容接口</summary>
          <div class="form">
            <label
              >API 地址<input
                v-model="baseUrl"
                type="url"
                placeholder="https://api.example.com/v1"
            /></label>
            <label
              >协议<select v-model="api">
                <option value="openai-completions">Chat Completions</option>
                <option value="openai-responses">Responses</option>
              </select></label
            >
            <div class="configured-models">
              <div class="configured-models-header">
                <span>已配置模型</span>
                <button type="button" class="text-button" @click="addModel">
                  添加模型
                </button>
              </div>
              <p v-if="!configuredModels.length" class="muted model-empty">
                尚未添加模型。添加后可在聊天输入框中切换。
              </p>
              <div
                v-for="model in configuredModels"
                :key="model.id"
                class="configured-model"
              >
                <button
                  type="button"
                  class="configured-model-select"
                  :class="{ selected: model.id === modelId }"
                  :aria-pressed="model.id === modelId"
                  @click="editModel(model)"
                >
                  <strong>{{ model.name || model.id }}</strong>
                  <small>{{ model.id }}</small>
                </button>
                <template v-if="modelToRemove === model.id">
                  <button
                    type="button"
                    class="text-button"
                    @click="modelToRemove = ''"
                  >取消</button>
                  <button
                    type="button"
                    class="text-button danger"
                    :disabled="saving"
                    @click="removeModel(model.id)"
                  >删除</button>
                </template>
                <button
                  v-else
                  type="button"
                  class="text-button danger"
                  :disabled="saving"
                  @click="modelToRemove = model.id"
                >删除</button>
              </div>
            </div>
            <p class="muted model-editor-title">
              {{
                configuredModels.some((model) => model.id === modelId)
                  ? "编辑模型"
                  : "添加模型"
              }}
            </p>
            <label
              >模型 ID<input
                v-model="modelId"
                :required="!!baseUrl"
                placeholder="服务端模型名称"
            /></label>
            <label
              >显示名称<input v-model="modelName" placeholder="可选"
            /></label>
            <div class="row">
              <label class="check"
                ><input v-model="reasoning" type="checkbox" />支持思考</label
              ><label class="check"
                ><input v-model="vision" type="checkbox" />支持图片</label
              >
            </div>
            <div class="row">
              <label
                >上下文长度<input
                  v-model.number="contextWindow"
                  type="number"
                  min="1" /></label
              ><label
                >最大输出<input
                  v-model.number="maxTokens"
                  type="number"
                  min="1"
              /></label>
            </div>
          </div>
        </details>
        <p v-if="message" role="status">{{ message }}</p>
        <button class="primary" :disabled="saving || !!chat.view?.runId">
          {{ saving ? "正在保存" : baseUrl ? "保存接口和模型" : "保存凭据" }}
        </button>
      </form>
      </div>
    </section>
  </div>
</template>
