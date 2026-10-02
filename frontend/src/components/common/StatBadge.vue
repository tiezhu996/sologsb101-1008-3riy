<script setup lang="ts">
/**
 * <StatBadge> 阀门计数与失衡占比徽标
 * 被换热站台账、失衡度计算页消费。
 */
import { computed } from 'vue'

type BadgeTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

const props = withDefaults(
  defineProps<{
    label: string
    value: number | string
    suffix?: string
    /** 占比 0-100，传入后渲染进度条并以百分比展示 */
    percent?: number
    tone?: BadgeTone
    size?: 'default' | 'small'
  }>(),
  { suffix: '', percent: undefined, tone: 'default', size: 'default' }
)

const toneColor: Record<BadgeTone, string> = {
  default: '#6b6257',
  primary: '#c1440e',
  success: '#1e8449',
  warning: '#d68910',
  danger: '#c0392b',
  info: '#2b6cb0'
}

const color = computed(() => toneColor[props.tone])
const displayValue = computed(() => (props.percent !== undefined ? `${props.percent}%` : props.value))
</script>

<template>
  <div class="stat-badge" :class="[`is-${size}`]" :style="{ '--badge-color': color }">
    <div class="stat-badge__head">
      <span class="stat-badge__dot" />
      <span class="stat-badge__label">{{ label }}</span>
    </div>
    <div class="stat-badge__body">
      <span class="stat-badge__value">{{ displayValue }}</span>
      <span v-if="suffix" class="stat-badge__suffix">{{ suffix }}</span>
    </div>
    <div v-if="percent !== undefined" class="stat-badge__track">
      <div class="stat-badge__bar" :style="{ width: `${Math.min(100, Math.max(0, percent))}%` }" />
    </div>
  </div>
</template>

<style scoped>
.stat-badge {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 136px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--hg-line);
  border-left: 4px solid var(--badge-color);
  border-radius: 10px;
}

.stat-badge.is-small {
  min-width: 108px;
  padding: 8px 10px;
}

.stat-badge__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--hg-ink-soft);
  font-size: 13px;
}

.stat-badge__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--badge-color);
}

.stat-badge__body {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.stat-badge__value {
  font-size: 22px;
  font-weight: 700;
  color: var(--hg-ink);
  font-variant-numeric: tabular-nums;
}

.stat-badge.is-small .stat-badge__value {
  font-size: 18px;
}

.stat-badge__suffix {
  font-size: 12px;
  color: var(--hg-ink-soft);
}

.stat-badge__track {
  height: 6px;
  border-radius: 4px;
  background: #f0ece6;
  overflow: hidden;
}

.stat-badge__bar {
  height: 100%;
  border-radius: 4px;
  background: var(--badge-color);
}
</style>
