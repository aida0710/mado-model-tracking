<script setup lang="ts">
import { computed, ref } from 'vue'
import { useData, withBase } from 'vitepress'

// public/images/ の画面はすべて 1440×900 で撮っている。
const SCREENSHOT_WIDTH = 1440
const SCREENSHOT_HEIGHT = 900

const props = defineProps({
  src: { type: String, required: true },
  alt: { type: String, required: true },
  caption: { type: String, required: true },
  eager: { type: Boolean, default: false },
  width: { type: Number, default: SCREENSHOT_WIDTH },
  height: { type: Number, default: SCREENSHOT_HEIGHT },
})

const { lang } = useData()
const labels = computed(() =>
  lang.value === 'en'
    ? { enlarge: `Enlarge: ${props.alt}`, close: 'Close the image' }
    : { enlarge: `${props.alt}を拡大`, close: '画像を閉じる' },
)
const dialog = ref<HTMLDialogElement | null>(null)

function closeOnBackdrop(event: MouseEvent) {
  if (event.target === dialog.value) dialog.value?.close()
}
</script>

<template>
  <figure class="screenshot">
    <button class="screenshot-open" :aria-label="labels.enlarge" @click="dialog?.showModal()">
      <img :src="withBase(src)" :alt="alt" :width="width" :height="height" :loading="eager ? 'eager' : 'lazy'">
      <span class="screenshot-enlarge" aria-hidden="true">↗</span>
    </button>
    <figcaption>{{ caption }}</figcaption>
    <dialog ref="dialog" class="screenshot-dialog" :aria-label="alt" @click="closeOnBackdrop">
      <button class="screenshot-close" :aria-label="labels.close" @click="dialog?.close()">✕</button>
      <img :src="withBase(src)" :alt="alt" :width="width" :height="height">
      <p>{{ caption }}</p>
    </dialog>
  </figure>
</template>
