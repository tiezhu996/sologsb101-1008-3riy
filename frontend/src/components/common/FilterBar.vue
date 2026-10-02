<script setup lang="ts">
/**
 * <FilterBar> 换热站 / 供热方式 / 调节单状态多条件过滤并同步 URL query
 * 被阀位登记、实测录入、调节单页消费。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'

export interface FilterSelectOption {
  label: string
  value: string
}

export interface FilterSelectConfig {
  /** query key，同时作为组件内唯一标识 */
  key: string
  label: string
  options: FilterSelectOption[]
  placeholder?: string
  /** 多选（默认）或单选 */
  multiple?: boolean
}

export interface FilterModel {
  keyword: string
  [key: string]: string | string[] | boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: FilterModel
    selects?: FilterSelectConfig[]
    keywordPlaceholder?: string
    /** 附加开关文案，如「仅看失衡」 */
    switchLabel?: string
    switchValue?: boolean
    hasSwitch?: boolean
    syncQuery?: boolean
    showReset?: boolean
  }>(),
  {
    selects: () => [],
    keywordPlaceholder: '搜索阀门编号 / 楼栋 / 换热站…',
    switchLabel: '',
    switchValue: false,
    hasSwitch: false,
    syncQuery: true,
    showReset: true
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: FilterModel): void
  (event: 'update:switchValue', value: boolean): void
  (event: 'change', value: FilterModel): void
  (event: 'reset'): void
}>()

const route = useRoute()
const router = useRouter()
const keyword = ref(props.modelValue.keyword ?? '')

watch(
  () => props.modelValue,
  (value) => {
    keyword.value = value.keyword ?? ''
  },
  { deep: true }
)

const activeCount = computed(() => {
  const entries = Object.entries(props.modelValue).filter(([key]) => key !== 'keyword')
  return entries.reduce((sum, [, value]) => {
    if (Array.isArray(value)) return sum + value.length
    if (typeof value === 'string' && value.length > 0) return sum + 1
    if (typeof value === 'boolean' && value) return sum + 1
    return sum
  }, 0)
})

function readQuery(): FilterModel {
  const query = route.query
  const model: FilterModel = { keyword: typeof query.kw === 'string' ? query.kw : '' }
  props.selects.forEach((select) => {
    const raw = query[select.key]
    const values = typeof raw === 'string' ? raw.split(',').filter((item) => item.length > 0) : []
    model[select.key] = select.multiple === false ? values[0] ?? '' : values
  })
  return model
}

function pushQuery(model: FilterModel): void {
  if (!props.syncQuery) return
  const query: LocationQueryRaw = {}
  Object.entries(model).forEach(([key, value]) => {
    const target = key === 'keyword' ? 'kw' : key
    if (Array.isArray(value)) {
      if (value.length > 0) query[target] = value.join(',')
    } else if (typeof value === 'string') {
      if (value.length > 0) query[target] = value
    }
  })
  void router.replace({ query })
}

function emitChange(next: FilterModel): void {
  emit('update:modelValue', next)
  emit('change', next)
  pushQuery(next)
}

function onKeywordInput(value: unknown): void {
  const text = typeof value === 'string' ? value : String(value ?? '')
  keyword.value = text
  emitChange({ ...props.modelValue, keyword: text })
}

function onSelectChange(key: string, value: unknown): void {
  const next = Array.isArray(value) ? value.map((item) => String(item)) : typeof value === 'string' ? value : ''
  emitChange({ ...props.modelValue, [key]: next })
}

function onSwitchChange(value: unknown): void {
  const flag = value === true
  emit('update:switchValue', flag)
  emitChange({ ...props.modelValue, [props.switchLabel || 'switch']: flag })
}

function onReset(): void {
  const cleared: FilterModel = { keyword: '' }
  props.selects.forEach((select) => {
    cleared[select.key] = select.multiple === false ? '' : []
  })
  keyword.value = ''
  emit('update:modelValue', cleared)
  if (props.syncQuery) void router.replace({ query: {} })
  emit('change', cleared)
  if (props.hasSwitch) emit('update:switchValue', false)
  emit('reset')
}

function valueOf(key: string): string | string[] {
  const value = props.modelValue[key]
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? value : ''
}

// 首次挂载：URL 上已有条件时回填给父级，保证筛选状态与地址栏一致
if (props.syncQuery && Object.keys(route.query).length > 0) {
  const restored = readQuery()
  keyword.value = restored.keyword
  emit('update:modelValue', restored)
  emit('change', restored)
}
</script>

<template>
  <div class="filter-bar">
    <div class="filter-bar__main">
      <t-input
        :value="keyword"
        class="filter-bar__keyword"
        :placeholder="keywordPlaceholder"
        clearable
        @input="onKeywordInput"
      />

      <div v-for="select in selects" :key="select.key" class="filter-bar__select">
        <span class="filter-bar__label">{{ select.label }}</span>
        <t-select
          :value="valueOf(select.key)"
          :options="select.options"
          :multiple="select.multiple !== false"
          :clearable="true"
          :placeholder="select.placeholder ?? `选择${select.label}`"
          class="filter-bar__control"
          @change="onSelectChange(select.key, $event)"
        />
      </div>

      <div v-if="hasSwitch" class="filter-bar__switch">
        <t-switch :value="switchValue" @change="onSwitchChange" />
        <span class="filter-bar__label">{{ switchLabel }}</span>
      </div>

      <slot name="extra" />
    </div>

    <div class="filter-bar__side">
      <slot name="actions" />
      <t-tag v-if="activeCount > 0" theme="warning" variant="light">{{ activeCount }} 项条件</t-tag>
      <t-button v-if="showReset" variant="text" theme="primary" @click="onReset">重置</t-button>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid var(--hg-line);
  border-radius: 10px;
}

.filter-bar__main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  flex: 1 1 520px;
}

.filter-bar__side {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-bar__keyword {
  width: 220px;
}

.filter-bar__label {
  margin-right: 6px;
  font-size: 13px;
  color: var(--hg-ink-soft);
  white-space: nowrap;
}

.filter-bar__select,
.filter-bar__switch {
  display: flex;
  align-items: center;
}

.filter-bar__control {
  width: 186px;
}
</style>
