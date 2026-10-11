<!--
  製品のロゴ。アプリの apps/web/src/components/ProductLogo.tsx と同じ、重なった3枚の層の印と
  「mado ML Tracking」（mado は通常の太さ、ML Tracking は太字）。
-->
<template>
  <span class="product-logo">
    <svg class="product-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path class="product-mark-layer" d="M3 12.25L12 16.75L21 12.25" />
      <path class="product-mark-layer" d="M3 16.75L12 21.25L21 16.75" />
      <path class="product-mark-top" d="M12 2.75L21 7.25L12 11.75L3 7.25Z" />
    </svg>
    <span><span class="product-prefix">mado</span> <strong>ML Tracking</strong></span>
  </span>
</template>
