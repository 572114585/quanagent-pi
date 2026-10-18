<script setup lang="ts">
import { ref } from "vue";
import { Download, FileText, X, Eye } from "lucide-vue-next";
import type { FileInfo } from "../../../packages/web-server/src/protocol.ts";
import PdfPreview from "./PdfPreview.vue";
defineProps<{ file: FileInfo }>();
const preview = ref(false);
</script>
<template>
  <div class="file-card">
    <FileText :size="20" />
    <div class="file-label">
      <strong>{{ file.name }}</strong
      ><small>{{ (file.size / 1024).toFixed(1) }} KB</small>
    </div>
    <button
      v-if="file.mime.startsWith('image/') || file.mime === 'application/pdf'"
      class="icon"
      title="预览"
      @click="preview = true"
    >
      <Eye :size="16" />
    </button>
    <a
      class="icon"
      :href="`${file.url}?download=1`"
      :download="file.name"
      title="下载"
      ><Download :size="16"
    /></a>
  </div>
  <dialog :open="preview" class="preview" @keydown.esc="preview = false">
    <header>
      <strong>{{ file.name }}</strong
      ><button class="icon" aria-label="关闭预览" @click="preview = false">
        <X :size="20" />
      </button>
    </header>
    <img
      v-if="file.mime.startsWith('image/')"
      :src="file.url"
      :alt="file.name"
    />
    <PdfPreview v-else-if="preview" :url="file.url" :name="file.name" />
  </dialog>
</template>
