<script setup lang="ts">
/**
 * <EmptyPanel> 空数据引导与新建入口
 * 被全部列表页消费。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    actionText?: string
    secondaryText?: string
    showSeed?: boolean
    compact?: boolean
  }>(),
  {
    title: '暂无数据',
    description: '当前筛选条件下没有记录，可调整条件或新建一条。',
    actionText: '',
    secondaryText: '',
    showSeed: false,
    compact: false
  }
)

const emit = defineEmits<{
  (event: 'action'): void
  (event: 'secondary'): void
  (event: 'seed'): void
}>()

const mark = computed(() => (props.showSeed ? '示' : props.actionText ? '＋' : '空'))
</script>

<template>
  <div class="empty-panel" :class="{ 'is-compact': compact }">
    <div class="empty-panel__mark">{{ mark }}</div>
    <h3 class="empty-panel__title">{{ title }}</h3>
    <p class="empty-panel__desc">{{ description }}</p>
    <div class="empty-panel__actions">
      <t-button v-if="actionText" theme="primary" @click="emit('action')">{{ actionText }}</t-button>
      <t-button v-if="secondaryText" variant="outline" @click="emit('secondary')">{{ secondaryText }}</t-button>
      <t-button v-if="showSeed" theme="success" variant="outline" @click="emit('seed')">生成样例数据</t-button>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.empty-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 44px 24px;
  background: #fdfaf6;
  border: 1px dashed var(--hg-line);
  border-radius: 12px;
  text-align: center;
}

.empty-panel.is-compact {
  padding: 22px 16px;
}

.empty-panel__mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: #f7ece2;
  color: #c1440e;
  font-weight: 700;
}

.empty-panel__title {
  margin: 4px 0 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--hg-ink);
}

.empty-panel__desc {
  margin: 0;
  max-width: 460px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--hg-ink-soft);
}

.empty-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  justify-content: center;
}
</style>
