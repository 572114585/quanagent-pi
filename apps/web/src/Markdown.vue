<script setup lang="ts">
import { computed } from "vue";
import { Marked } from "marked";
import DOMPurify from "dompurify";

const props = defineProps<{ source: string }>();
const marked = new Marked({ gfm: true, breaks: true });
const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.source, { async: false }) as string),
);
</script>
<template><div class="markdown" v-html="html"></div></template>
