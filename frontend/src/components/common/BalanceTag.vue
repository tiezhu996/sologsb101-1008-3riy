<script setup lang="ts">
/**
 * <BalanceTag> 按 平衡 / 偏大 / 偏小 / 严重失衡 渲染底色
 * 被阀位登记、失衡度计算两页消费。
 */
import { computed } from 'vue'
import { BALANCE_BG, BALANCE_COLOR, BALANCE_THEME, type BalanceLevel } from '@/utils/balance'

const props = withDefaults(
  defineProps<{
    level: BalanceLevel
    /** 附加展示的失衡度（%） */
    imbalance?: number
    size?: 'small' | 'medium' | 'large'
  }>(),
  { imbalance: undefined, size: 'medium' }
)

const theme = computed(() => BALANCE_THEME[props.level])
const style = computed(() => ({
  color: BALANCE_COLOR[props.level],
  backgroundColor: BALANCE_BG[props.level],
  borderColor: BALANCE_COLOR[props.level]
}))
const text = computed(() =>
  props.imbalance === undefined ? props.level : `${props.level} · ${props.imbalance.toFixed(1)}%`
)
</script>

<template>
  <span class="balance-tag" :class="[`is-${size}`, `theme-${theme}`]" :style="style">
    <span class="balance-tag__dot" :style="{ backgroundColor: BALANCE_COLOR[level] }" />
    <span>{{ text }}</span>
  </span>
</template>

<style scoped>
.balance-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}

.balance-tag.is-small {
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.balance-tag.is-large {
  padding: 4px 14px;
  font-size: 15px;
  line-height: 24px;
}

.balance-tag__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
</style>
