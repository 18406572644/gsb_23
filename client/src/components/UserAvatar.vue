<script setup lang="ts">
import type { UserInfo } from '../../../shared/protocol'

defineProps<{ user: UserInfo }>()
</script>

<template>
  <span class="user-avatar" :style="{ background: user.color }">
    {{ (user.name || '?').slice(0, 1).toUpperCase() }}
  </span>
</template>

<style scoped>
.user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: #fff;
  font-size: 12px;
  border: 2px solid #fff;
  margin-left: -6px;
  user-select: none;
}
</style>
