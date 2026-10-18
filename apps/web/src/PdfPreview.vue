<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps<{ url: string; name: string }>();
const container = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const pageNumber = ref(1);
const pageCount = ref(0);
const loading = ref(true);
const error = ref("");
const controller = new AbortController();
let document: PDFDocumentProxy | undefined;
let loadingTask: PDFDocumentLoadingTask | undefined;
let renderTask: RenderTask | undefined;
let observer: ResizeObserver | undefined;
let generation = 0;
let observedWidth = 0;
let resizeFrame = 0;

async function renderPage() {
  const current = ++generation;
  const previous = renderTask;
  previous?.cancel();
  await previous?.promise.catch(() => {});
  if (current !== generation || !document || !canvas.value || !container.value)
    return;
  loading.value = true;
  error.value = "";
  try {
    const page = await document.getPage(pageNumber.value);
    if (current !== generation || !canvas.value || !container.value) return;
    const scale = Math.min(
      2,
      (container.value.clientWidth - 32) / page.getViewport({ scale: 1 }).width,
    );
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale });
    canvas.value.width = Math.ceil(viewport.width * ratio);
    canvas.value.height = Math.ceil(viewport.height * ratio);
    canvas.value.style.width = `${viewport.width}px`;
    canvas.value.style.height = `${viewport.height}px`;
    renderTask = page.render({
      canvas: canvas.value,
      viewport,
      transform: [ratio, 0, 0, ratio, 0, 0],
    });
    await renderTask.promise;
  } catch (failure) {
    if (current === generation)
      error.value = failure instanceof Error ? failure.message : "PDF 渲染失败";
  } finally {
    if (current === generation) loading.value = false;
  }
}

watch(pageNumber, renderPage);
onMounted(async () => {
  try {
    const response = await fetch(props.url, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("无法读取 PDF，请重新登录后重试。");
    const data = new Uint8Array(await response.arrayBuffer());
    if (controller.signal.aborted) return;
    loadingTask = getDocument({
      data,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    document = await loadingTask.promise;
    if (controller.signal.aborted) return;
    pageCount.value = document.numPages;
    await renderPage();
    observer = new ResizeObserver(() => {
      const width = container.value?.clientWidth ?? 0;
      if (!width || width === observedWidth) return;
      observedWidth = width;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        void renderPage();
      });
    });
    if (container.value) {
      observedWidth = container.value.clientWidth;
      observer.observe(container.value);
    }
  } catch (failure) {
    if (!controller.signal.aborted) {
      error.value = failure instanceof Error ? failure.message : "PDF 加载失败";
      loading.value = false;
    }
  }
});
onBeforeUnmount(() => {
  ++generation;
  controller.abort();
  observer?.disconnect();
  cancelAnimationFrame(resizeFrame);
  renderTask?.cancel();
  void loadingTask?.destroy().catch(() => {});
});
</script>
<template>
  <div class="pdf-preview">
    <div class="pdf-toolbar">
      <button :disabled="pageNumber <= 1" @click="pageNumber--">上一页</button>
      <span>{{ pageNumber }} / {{ pageCount || "…" }}</span>
      <button :disabled="pageNumber >= pageCount" @click="pageNumber++">
        下一页
      </button>
    </div>
    <p v-if="loading" class="muted" role="status">正在加载 PDF…</p>
    <p v-if="error" class="danger" role="alert">{{ error }}</p>
    <div ref="container" class="pdf-pages">
      <canvas
        ref="canvas"
        role="img"
        :aria-label="`${name}，第 ${pageNumber} 页`"
      ></canvas>
    </div>
  </div>
</template>
