<template>
  <div class="user-card">
    <h2>{{ user.name }}</h2>
    <p>{{ user.email }}</p>
    <button @click="emit('select', user)">Select</button>
  </div>
</template>

<script setup lang="ts">
interface User {
  name: string;
  email: string;
  id: number;
}

const props = defineProps<{ user: User }>();
const emit = defineEmits<{ (e: 'select', user: User): void }>();
</script>
