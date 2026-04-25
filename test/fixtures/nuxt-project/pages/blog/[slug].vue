<template>
  <article>
    <h1>{{ slug }}</h1>
    <p>Blog post content goes here.</p>
  </article>
</template>

<script setup lang="ts">
const route = useRoute();
const slug = computed(() => route.params['slug'] as string);
</script>
