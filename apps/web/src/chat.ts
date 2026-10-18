import { defineStore } from "pinia";
import { ref } from "vue";
import {
  applyPiEvent,
  object,
  type Dialog,
  type Envelope,
  type FileInfo,
  type SessionItem,
  type Snapshot,
  type WeixinSnapshot,
} from "../../../packages/web-server/src/protocol.ts";

export interface ModelOption {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  input: string[];
}
export interface ProviderOption {
  id: string;
  name: string;
  configured: boolean;
  authType: string;
  configuration?: {
    baseUrl: string;
    api?: string;
    models: Array<{
      id: string;
      name?: string;
      reasoning?: boolean;
      vision?: boolean;
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
}

const errors: Record<string, string> = {
  unauthorized: "请先登录",
  invalid_credentials: "账号或密码错误",
  too_many_attempts: "尝试次数过多，请一分钟后再试",
  session_busy: "会话正在被其他入口使用，当前可查看历史",
  agent_running: "请等待任务结束后修改模型配置",
  model_does_not_support_images: "当前模型不支持图片，请切换模型",
  invalid_origin: "访问地址与服务端 PI_WEB_ORIGIN 不一致",
  file_too_large: "单个文件不能超过 20 MB",
  request_too_large: "上传内容过大",
  dialog_expired: "这个交互已经结束",
  empty_message: "请输入消息或添加附件",
  empty_configuration: "请填写密钥或自定义接口配置",
  invalid_url: "请填写有效的 API 地址，避免在地址中放入密钥",
  model_not_found: "这个模型配置已不存在，请刷新后重试",
  bridge_busy: "微信桥接正在被其他进程使用，请先停止该进程",
  configuration_invalid: "微信桥接配置无效，请检查服务端 config.json",
  model_unavailable: "请选择已配置凭据的可用模型",
  login_failed: "微信登录失败，请重新扫码",
  connection_failed: "微信连接失败，请重新连接",
  bridge_exited: "微信桥接进程已退出，请重新连接",
  pairing_timeout: "配对码等待超时，请重新扫码",
  pairing_expired: "配对码请求已过期，请按当前页面重新输入",
  invalid_pairing_code: "配对码只能包含数字",
  weixin_unavailable: "当前服务未启用微信连接",
  invalid_weixin_request: "微信连接请求无效",
};

export const useChat = defineStore("chat", () => {
  const loggedIn = ref(false);
  const ready = ref(false);
  const cwd = ref("");
  const sessions = ref<SessionItem[]>([]);
  const view = ref<Snapshot | null>(null);
  const error = ref("");
  const connection = ref("");
  const version = ref(0);
  const models = ref<ModelOption[]>([]);
  const providers = ref<ProviderOption[]>([]);
  const recoveredDraft = ref<{
    sessionId: string;
    message: string;
    files: FileInfo[];
  } | null>(null);
  const pendingInputs = new Map<
    string,
    { sessionId: string; message: string; files: FileInfo[] }
  >();
  let stream: EventSource | undefined;
  let activation = 0;

  async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = object(await response.json());
    if (!response.ok) {
      if (response.status === 401 && path !== "/auth/login") {
        loggedIn.value = false;
        stream?.close();
      }
      throw new Error(
        errors[String(data.error)] ??
          String(data.error ?? `HTTP ${response.status}`),
      );
    }
    return data as T;
  }
  async function refreshList() {
    sessions.value = (
      await api<{ sessions: SessionItem[] }>("/sessions")
    ).sessions;
  }
  async function loadModels() {
    const data = await api<{
      models: ModelOption[];
      providers: ProviderOption[];
    }>("/models");
    models.value = data.models;
    providers.value = data.providers;
  }
  async function boot() {
    try {
      const data = await api<{ cwd: string }>("/auth");
      cwd.value = data.cwd;
      loggedIn.value = true;
      await Promise.all([refreshList(), loadModels()]);
      if (sessions.value[0]) await activate(sessions.value[0].id);
    } catch (cause) {
      if (loggedIn.value)
        error.value = String(cause instanceof Error ? cause.message : cause);
    } finally {
      ready.value = true;
    }
  }
  async function login(username: string, password: string) {
    await api("/auth/login", "POST", { username, password });
    await boot();
  }
  async function logout() {
    await api("/auth/logout", "POST");
    stream?.close();
    loggedIn.value = false;
    view.value = null;
    sessions.value = [];
    models.value = [];
    providers.value = [];
    recoveredDraft.value = null;
    pendingInputs.clear();
  }
  function replace(snapshot: Snapshot) {
    if (view.value?.id !== snapshot.id) return;
    const current = view.value.cursor.split(".");
    const next = snapshot.cursor.split(".");
    if (current[0] === next[0] && Number(next[1]) < Number(current[1])) return;
    view.value = snapshot;
    version.value++;
  }
  async function refreshCurrent(id: string) {
    const snapshot = await api<Snapshot>(`/sessions/${id}`);
    replace(snapshot);
  }
  function connect(id: string, after: string) {
    stream?.close();
    stream = new EventSource(
      `/api/sessions/${id}/events?after=${encodeURIComponent(after)}`,
    );
    stream.onopen = () => {
      connection.value = "";
    };
    stream.onerror = () => {
      connection.value = "连接中断，正在重连";
      void api("/auth").catch(() => {});
    };
    stream.addEventListener("snapshot", (raw) => {
      replace(JSON.parse((raw as MessageEvent<string>).data) as Snapshot);
    });
    stream.onmessage = (raw: MessageEvent<string>) => {
      const envelope = JSON.parse(raw.data) as Envelope;
      const current = view.value;
      if (!current || current.id !== id) return;
      const cursor = current.cursor.split(".");
      const next = envelope.id.split(".");
      if (cursor[0] === next[0] && Number(next[1]) <= Number(cursor[1])) return;
      current.cursor = envelope.id;
      const event = object(envelope.event);
      applyPiEvent(current, event);
      if (event.type === "run_started") {
        current.running = true;
        current.runId = envelope.runId;
        current.status = "正在准备";
      }
      if (event.type === "dialog") current.dialogs.push(event.dialog as Dialog);
      if (event.type === "dialog_closed")
        current.dialogs = current.dialogs.filter(
          (item) => item.id !== event.id,
        );
      if (event.type === "file") {
        const file = event.file as FileInfo;
        if (!current.files.some((item) => item.id === file.id))
          current.files.push(file);
      }
      if (event.type === "notice") current.status = String(event.message);
      if (event.type === "run_error") {
        error.value = errors[String(event.message)] ?? String(event.message);
        recoveredDraft.value = pendingInputs.get(id) ?? null;
      }
      if (event.type === "run_finished") {
        pendingInputs.delete(id);
        current.running = false;
        current.runId = undefined;
        void Promise.all([refreshCurrent(id), refreshList()]).catch(
          (cause: unknown) => {
            error.value = String(cause);
          },
        );
      }
      version.value++;
    };
  }
  async function activate(id: string) {
    const ticket = ++activation;
    stream?.close();
    error.value = "";
    const snapshot = await api<Snapshot>(`/sessions/${id}`);
    if (ticket !== activation) return;
    view.value = snapshot;
    connect(id, snapshot.cursor);
  }
  async function create() {
    const snapshot = await api<Snapshot>("/sessions", "POST");
    await refreshList();
    await activate(snapshot.id);
  }
  async function rename(id: string, name: string) {
    await api(`/sessions/${id}`, "PATCH", { name });
    await refreshList();
    if (view.value?.id === id) view.value.name = name;
  }
  async function archive(id: string) {
    await api(`/sessions/${id}`, "DELETE");
    await refreshList();
    if (view.value?.id === id) {
      stream?.close();
      view.value = null;
      if (sessions.value[0]) await activate(sessions.value[0].id);
    }
  }
  async function send(
    message: string,
    attachments: FileInfo[],
    modelKey: string,
    thinkingLevel: string,
  ) {
    const current = view.value;
    if (!current) return;
    recoveredDraft.value = null;
    pendingInputs.set(current.id, {
      sessionId: current.id,
      message,
      files: attachments,
    });
    const selected = models.value.find(
      (model) => `${model.provider}:${model.id}` === modelKey,
    );
    current.running = true;
    try {
      await api(`/sessions/${current.id}/messages`, "POST", {
        message,
        attachments: attachments.map((file) => file.id),
        ...(selected
          ? { model: { provider: selected.provider, id: selected.id } }
          : {}),
        thinkingLevel,
      });
      await refreshCurrent(current.id);
    } catch (cause) {
      pendingInputs.delete(current.id);
      current.running = false;
      throw cause;
    }
  }
  async function stop() {
    if (view.value) await api(`/sessions/${view.value.id}/stop`, "POST");
  }
  async function answer(dialog: Dialog, value?: string | boolean) {
    if (view.value)
      await api(`/sessions/${view.value.id}/dialogs/${dialog.id}`, "POST", {
        value,
      });
  }
  async function upload(file: File): Promise<FileInfo> {
    if (file.size > 20 * 1024 * 1024) throw new Error("单个文件不能超过 20 MB");
    if (!view.value) await create();
    const response = await fetch(`/api/sessions/${view.value!.id}/uploads`, {
      method: "POST",
      headers: { "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    const data: unknown = await response.json();
    if (!response.ok)
      throw new Error(errors[String(object(data).error)] ?? "上传失败");
    return data as FileInfo;
  }
  async function saveProvider(id: string, body: unknown) {
    await api(`/providers/${encodeURIComponent(id)}`, "PUT", body);
    await loadModels();
  }
  async function removeKey(id: string) {
    await api(`/providers/${encodeURIComponent(id)}`, "DELETE");
    await loadModels();
  }
  async function removeModel(providerId: string, modelId: string) {
    await api(`/providers/${encodeURIComponent(providerId)}/models`, "DELETE", {
      modelId,
    });
    await loadModels();
  }
  return {
    loggedIn,
    ready,
    cwd,
    sessions,
    view,
    error,
    connection,
    version,
    models,
    providers,
    recoveredDraft,
    boot,
    login,
    logout,
    create,
    activate,
    rename,
    archive,
    send,
    stop,
    answer,
    upload,
    saveProvider,
    removeKey,
    removeModel,
    weixinStatus: () => api<WeixinSnapshot>("/weixin"),
    connectWeixin: (body: { force?: boolean; provider?: string; model?: string }) => api<WeixinSnapshot>("/weixin/connect", "POST", body),
    disconnectWeixin: () => api<WeixinSnapshot>("/weixin/disconnect", "POST"),
    verifyWeixinCode: (attemptId: string, challengeId: string, code: string) => api<WeixinSnapshot>("/weixin/verify-code", "POST", { attemptId, challengeId, code }),
    weixinError: (code: string) => errors[code] ?? "微信连接失败，请重试",
  };
});
