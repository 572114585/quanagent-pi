<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  Moon,
  LogOut,
  Menu,
  Send,
  Square,
  Paperclip,
  X,
  Terminal,
  ChevronRight,
  FileCode2,
} from "lucide-vue-next";
import { useChat } from "./chat.ts";
import Markdown from "./Markdown.vue";
import FileCard from "./FileCard.vue";
import Settings from "./Settings.vue";
import type {
  Dialog,
  FileInfo,
} from "../../../packages/web-server/src/protocol.ts";

const chat = useChat();
const username = ref("admin");
const password = ref("");
const loginBusy = ref(false);
const search = ref("");
const sidebar = ref(false);
const settings = ref(false);
const draft = ref("");
const attachments = ref<FileInfo[]>([]);
const uploading = ref(false);
const selectedModel = ref("");
const thinking = ref("medium");
const fileInput = ref<HTMLInputElement>();
const scroll = ref<HTMLElement>();
const dark = ref(
  localStorage.getItem("pi-web-theme") === "dark" ||
    (!localStorage.getItem("pi-web-theme") &&
      matchMedia("(prefers-color-scheme: dark)").matches),
);
const answers = ref<Record<string, string>>({});
const operation = ref<{
  kind: "rename" | "archive";
  id: string;
  value: string;
} | null>(null);
const sessionList = computed(() =>
  chat.sessions.filter((item) =>
    item.name.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const messages = computed(
  () =>
    chat.view?.messages.filter(
      (item) => item.role === "user" || item.role === "assistant",
    ) ?? [],
);
const running = computed(() => !!chat.view?.runId || !!chat.view?.running);
const occupied = computed(() => !!chat.view?.busy && !running.value);
const artifacts = computed(
  () => chat.view?.files.filter((file) => file.kind === "artifact") ?? [],
);
watch(
  dark,
  (value) => {
    document.documentElement.classList.toggle("dark", value);
    localStorage.setItem("pi-web-theme", value ? "dark" : "light");
  },
  { immediate: true },
);
watch(
  () => chat.view?.id,
  () => {
    draft.value = "";
    attachments.value = [];
    sidebar.value = false;
    selectedModel.value = chat.view?.model
      ? `${chat.view.model.provider}:${chat.view.model.id}`
      : "";
    thinking.value = chat.view?.model ? chat.view.thinkingLevel : "medium";
  },
);
watch(
  () => chat.version,
  () => {
    const el = scroll.value;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 180)
      void nextTick(() => {
        el.scrollTop = el.scrollHeight;
      });
  },
);
watch(
  () => chat.recoveredDraft,
  (input) => {
    if (input && input.sessionId === chat.view?.id && !draft.value) {
      draft.value = input.message;
      attachments.value = input.files;
    }
  },
  { flush: "sync" },
);
async function attempt(action: () => Promise<unknown>) {
  try {
    chat.error = "";
    await action();
  } catch (error) {
    chat.error = error instanceof Error ? error.message : String(error);
  }
}
async function login() {
  loginBusy.value = true;
  await attempt(() => chat.login(username.value, password.value));
  password.value = "";
  loginBusy.value = false;
}
async function send() {
  if (
    running.value ||
    uploading.value ||
    occupied.value ||
    (!draft.value.trim() && !attachments.value.length)
  )
    return;
  const text = draft.value;
  const files = [...attachments.value];
  const model = selectedModel.value;
  const level = thinking.value;
  try {
    if (!chat.view) await chat.create();
    draft.value = "";
    attachments.value = [];
    chat.error = "";
    await chat.send(text, files, model, level);
  } catch (error) {
    if (!draft.value) {
      draft.value = text;
      attachments.value = files;
    }
    chat.error = error instanceof Error ? error.message : String(error);
  }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  uploading.value = true;
  try {
    for (const file of Array.from(input.files ?? [])) {
      if (attachments.value.length >= 8) throw new Error("最多添加 8 个附件");
      attachments.value.push(await chat.upload(file));
    }
  } catch (error) {
    chat.error = String(error);
  } finally {
    uploading.value = false;
    input.value = "";
  }
}
function rename(id: string, name: string) {
  operation.value = { kind: "rename", id, value: name };
}
function archive(id: string) {
  operation.value = { kind: "archive", id, value: "" };
}
async function confirmOperation() {
  const current = operation.value;
  if (!current) return;
  await attempt(() =>
    current.kind === "rename"
      ? chat.rename(current.id, current.value)
      : chat.archive(current.id),
  );
  operation.value = null;
}
async function answer(dialog: Dialog, value?: string | boolean) {
  await attempt(() => chat.answer(dialog, value));
}
function onEnter(event: KeyboardEvent) {
  if (!event.isComposing && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}
onMounted(() => {
  void chat.boot();
});
</script>

<template>
  <div v-if="!chat.ready" class="center muted">正在连接工作空间…</div>
  <div v-else-if="!chat.loggedIn" class="login-page">
    <form class="login panel form" @submit.prevent="login">
      <div class="brand-mark">π</div>
      <span class="eyebrow">你的智能工作空间</span>
      <h1>登录 pi</h1>
      <p class="muted">连接工作目录，继续你的任务。</p>
      <label
        >账号<input v-model="username" autocomplete="username" required
      /></label>
      <label
        >密码<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
      /></label>
      <p v-if="chat.error" class="danger" role="alert">{{ chat.error }}</p>
      <button class="primary" :disabled="loginBusy">
        {{ loginBusy ? "正在登录" : "登录" }}<ChevronRight :size="16" />
      </button>
    </form>
  </div>
  <div v-else class="shell">
    <div v-if="sidebar" class="sidebar-backdrop" @click="sidebar = false"></div>
    <aside :class="{ open: sidebar }">
      <div class="sidebar-brand">
        <span class="brand-mark small">π</span><strong>pi</strong
        ><span class="eyebrow">工作空间</span>
      </div>
      <button class="new-chat primary" @click="attempt(chat.create)">
        <Plus :size="17" />新建对话
      </button>
      <label class="search"
        ><Search :size="15" /><input
          v-model="search"
          placeholder="搜索会话"
          aria-label="搜索会话"
      /></label>
      <span class="sidebar-label">历史会话</span>
      <nav aria-label="历史会话">
        <div
          v-for="session in sessionList"
          :key="session.id"
          class="session"
          :class="{ active: session.id === chat.view?.id }"
        >
          <button
            class="session-open"
            @click="attempt(() => chat.activate(session.id))"
          >
            <span>{{ session.name || "新对话" }}</span
            ><small>{{
              session.busy
                ? "使用中"
                : new Date(session.updatedAt).toLocaleDateString()
            }}</small>
          </button>
          <div class="session-actions">
            <button
              class="text-button"
              title="重命名"
              @click="rename(session.id, session.name)"
            >
              改名</button
            ><button
              class="text-button"
              title="归档"
              @click="archive(session.id)"
            >
              <X :size="12" />
            </button>
          </div>
        </div>
        <p v-if="!sessionList.length" class="muted empty-list">
          {{ search ? "没有匹配的会话" : "还没有会话" }}
        </p>
      </nav>
      <footer>
        <button
          class="icon"
          :aria-label="dark ? '切换浅色' : '切换深色'"
          @click="dark = !dark"
        >
          <Sun v-if="dark" :size="18" /><Moon v-else :size="18" /></button
        ><button class="icon" aria-label="模型设置" @click="settings = true">
          <SettingsIcon :size="18" /></button
        ><button
          class="icon"
          aria-label="退出登录"
          @click="attempt(chat.logout)"
        >
          <LogOut :size="17" />
        </button>
      </footer>
    </aside>
    <main>
      <header class="workspace-header">
        <button
          class="icon mobile-menu"
          aria-label="展开会话"
          :aria-expanded="sidebar"
          @click="sidebar = !sidebar"
        >
          <Menu :size="20" />
        </button>
        <div>
          <strong>{{ chat.view?.name || "新对话" }}</strong>
        </div>
        <span class="connection">{{
          chat.connection ||
          (running ? chat.view?.status || "运行中" : "已连接")
        }}</span>
      </header>
      <div v-if="chat.error" class="error-banner" role="alert">
        {{ chat.error
        }}<button class="icon" aria-label="关闭错误" @click="chat.error = ''">
          <X :size="16" />
        </button>
      </div>
      <div v-if="occupied" class="info-banner">
        此会话正在被终端或其他客户端占用。释放后可在这里继续。
      </div>
      <div ref="scroll" class="conversation">
        <div v-if="!messages.length" class="welcome">
          <div class="brand-mark">π</div>
          <span class="eyebrow">从一个想法开始</span>
          <h1>有什么可以帮你？</h1>
          <p class="muted">阅读代码、处理文件，或完成一个新的任务。</p>
          <div class="suggestions">
            <button @click="draft = '介绍一下当前项目的结构和运行方式'">
              介绍当前项目<FileCode2 :size="17" /></button
            ><button @click="draft = '帮我检查最近的代码改动，找出潜在问题'">
              检查代码改动<ChevronRight :size="17" />
            </button>
          </div>
        </div>
        <div v-else class="message-list">
          <article
            v-for="message in messages"
            :key="message.id"
            class="message"
            :class="message.role"
          >
            <div class="message-role">
              {{ message.role === "user" ? "你" : "pi"
              }}<span v-if="message.status === 'pending'" class="pulse"></span>
            </div>
            <div class="message-body">
              <template v-for="(block, index) in message.content" :key="index">
                <Markdown
                  v-if="block.type === 'text'"
                  :source="block.text || ''"
                />
                <details v-else-if="block.type === 'thinking'" class="thinking">
                  <summary>思考过程</summary>
                  <Markdown :source="block.thinking || ''" />
                </details>
                <details v-else-if="block.type === 'toolCall'" class="tool">
                  <summary>
                    <Terminal :size="14" />{{ block.name
                    }}<span>{{
                      block.id ? chat.view?.tools[block.id]?.status : ""
                    }}</span>
                  </summary>
                  <pre>{{ JSON.stringify(block.arguments, null, 2) }}</pre>
                  <pre v-if="block.id && chat.view?.tools[block.id]?.output">{{
                    chat.view.tools[block.id].output
                  }}</pre>
                </details>
                <img
                  v-else-if="
                    block.type === 'image' &&
                    block.data &&
                    /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType || '')
                  "
                  class="message-image"
                  :src="`data:${block.mimeType};base64,${block.data}`"
                  alt="图片附件"
                />
              </template>
              <p v-if="message.error" class="danger">{{ message.error }}</p>
            </div>
          </article>
          <div v-if="artifacts.length" class="artifacts">
            <span class="eyebrow">交付文件</span
            ><FileCard v-for="file in artifacts" :key="file.id" :file="file" />
          </div>
        </div>
      </div>
      <div class="composer-area">
        <div class="composer-wrap">
          <section
            v-for="dialog in chat.view?.dialogs || []"
            :key="dialog.id"
            class="interaction panel"
          >
            <strong>{{ dialog.title }}</strong>
            <p v-if="dialog.message">{{ dialog.message }}</p>
            <div v-if="dialog.method === 'confirm'" class="row">
              <button class="primary" @click="answer(dialog, true)">确认</button
              ><button @click="answer(dialog, false)">拒绝</button>
            </div>
            <template v-else
              ><select
                v-if="dialog.method === 'select'"
                v-model="answers[dialog.id]"
              >
                <option v-for="option in dialog.options" :key="option">
                  {{ option }}
                </option></select
              ><textarea
                v-else
                :value="answers[dialog.id] ?? dialog.prefill ?? ''"
                :rows="dialog.method === 'editor' ? 5 : 2"
                @input="
                  answers[dialog.id] = (
                    $event.target as HTMLTextAreaElement
                  ).value
                "
              ></textarea>
              <div class="row">
                <button
                  class="primary"
                  @click="
                    answer(dialog, answers[dialog.id] ?? dialog.prefill ?? '')
                  "
                >
                  提交</button
                ><button @click="answer(dialog)">取消</button>
              </div></template
            >
          </section>
          <div v-if="attachments.length" class="pending-files">
            <div v-for="file in attachments" :key="file.id">
              <span>{{ file.name }}</span
              ><button
                class="icon"
                aria-label="移除附件"
                @click="
                  attachments = attachments.filter(
                    (item) => item.id !== file.id,
                  )
                "
              >
                <X :size="13" />
              </button>
            </div>
          </div>
          <form class="composer" @submit.prevent="send">
            <textarea
              v-model="draft"
              rows="3"
              :disabled="occupied"
              placeholder="发送消息，或添加文件…"
              aria-label="消息"
              @keydown.enter="onEnter"
            ></textarea>
            <div class="composer-toolbar">
              <button
                class="icon"
                type="button"
                aria-label="添加附件"
                :disabled="uploading || running || occupied"
                @click="fileInput?.click()"
              >
                <Paperclip :size="19" /></button
              ><input
                ref="fileInput"
                type="file"
                multiple
                hidden
                @change="upload"
              /><select
                v-model="selectedModel"
                aria-label="选择模型"
                :disabled="running"
              >
                <option value="">会话默认模型</option>
                <option
                  v-for="model in chat.models"
                  :key="`${model.provider}:${model.id}`"
                  :value="`${model.provider}:${model.id}`"
                >
                  {{ model.name }} · {{ model.provider }}
                </option></select
              ><select
                v-model="thinking"
                aria-label="思考强度"
                :disabled="running"
              >
                <option value="off">关闭思考</option>
                <option value="minimal">极低</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="xhigh">很高</option>
                <option value="max">最高</option></select
              ><button
                v-if="running"
                class="send-button"
                type="button"
                aria-label="停止"
                @click="attempt(chat.stop)"
              >
                <Square :size="17" /></button
              ><button
                v-else
                class="send-button"
                type="submit"
                aria-label="发送"
                :disabled="
                  uploading ||
                  occupied ||
                  (!draft.trim() && !attachments.length)
                "
              >
                <Send :size="18" />
              </button>
            </div>
          </form>
          <p class="composer-hint">
            {{
              uploading ? "正在上传附件…" : "Enter 发送 · Shift + Enter 换行"
            }}
          </p>
        </div>
      </div>
    </main>
    <Settings v-if="settings" @close="settings = false" />
    <div v-if="operation" class="modal-backdrop" @click.self="operation = null">
      <section
        class="panel operation form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-title"
        @keydown.esc="operation = null"
      >
        <h2 id="operation-title">
          {{ operation.kind === "rename" ? "重命名会话" : "归档会话" }}
        </h2>
        <label v-if="operation.kind === 'rename'"
          >会话名称<input
            v-model="operation.value"
            @keydown.enter="confirmOperation"
        /></label>
        <p v-else class="muted">
          归档后，终端列表中也会同步移除。会话文件保留在归档目录中。
        </p>
        <div class="row">
          <button @click="operation = null">取消</button
          ><button class="primary" @click="confirmOperation">
            {{ operation.kind === "rename" ? "保存" : "确认归档" }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
