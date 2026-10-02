<script setup lang="ts">
/**
 * /adjusts 调节单下发与复核
 * 生成目标开度、执行回填、复核确认并导出全量 JSON。
 * 消费 Adjust、Valve、Measure；复用 <FilterBar>、<EmptyPanel>、<StatBadge>、<BalanceTag>。
 */
import { computed, reactive, ref, watchEffect } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import BalanceTag from '@/components/common/BalanceTag.vue'
import { useAdjustStore, type AdjustEnriched } from '@/stores/adjustStore'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import {
  ADJUST_STATES,
  ADJUST_STATE_FLOW,
  EMPTY_ADJUST_DRAFT,
  type Adjust,
  type AdjustDraft,
  type AdjustState
} from '@/types/adjust'
import { basisText, formatOpening } from '@/utils/balance'
import { exportAdjustCsv } from '@/utils/export'
import {
  DB_VERSION,
  clearAllTables,
  countAll,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const adjustStore = useAdjustStore()
const valveStore = useValveStore()
const stationStore = useStationStore()
const rank = useImbalanceRank()

// 把最新实测快照灌入调节单 store，用于重算失衡度
watchEffect(() => {
  adjustStore.syncLatestMeasures(
    rank.rows.value.map((row) => ({
      valve: row.valve,
      measured: row.measured,
      latest: row.latest ? { roomTempC: row.latest.roomTempC, date: row.latest.date } : null
    }))
  )
})

const counts = ref<Record<string, number>>({})
const lastBackupAt = ref<string | null>(readLastBackupAt())
const stampedVersion = ref<number>(readStampedDbVersion())
const fileInput = ref<HTMLInputElement | null>(null)

void refreshCounts()

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: adjustStore.keyword,
  state: adjustStore.stateFilter
}))

const filterSelects = computed(() => [
  { key: 'state', label: '调节单状态', options: ADJUST_STATES.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  adjustStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    stateFilter: (Array.isArray(model.state) ? model.state : []) as AdjustState[]
  })
}

const rows = computed(() => adjustStore.filtered)

const columns = [
  { colKey: 'valve', title: '阀门 / 楼栋', width: 200, cell: 'valveCell' },
  { colKey: 'imbalance', title: '失衡度', width: 150, cell: 'imbalanceCell' },
  { colKey: 'opening', title: '当前 → 目标开度', width: 170, cell: 'openingCell' },
  { colKey: 'basis', title: '调节依据', minWidth: 260, cell: 'basisCell' },
  { colKey: 'executor', title: '执行人', width: 110 },
  { colKey: 'state', title: '状态', width: 110, cell: 'stateCell' },
  { colKey: 'note', title: '复核意见', width: 180, cell: 'noteCell' },
  { colKey: 'op', title: '操作', width: 250, cell: 'opCell' }
]

function rowKey(row: AdjustEnriched): string {
  return row.adjust.id
}

/* ------------------------------ 编辑 ------------------------------ */

const dialogVisible = ref(false)
const dialogTitle = ref('调节单')
const form = reactive<AdjustDraft>({ ...EMPTY_ADJUST_DRAFT })
const formRef = ref()
let editingId: string | null = null

const rules = {
  valveId: [{ required: true, message: '请选择阀门', type: 'error' as const }],
  basis: [{ required: true, message: '请填写调节依据', type: 'error' as const }]
}

const valveOptions = computed(() =>
  valveStore.enriched.map((item) => ({
    label: `${item.valve.code} · ${item.building ? item.building.name : '未知楼栋'}（现 ${item.valve.currentOpening}%）`,
    value: item.valve.id
  }))
)

function openCreate(): void {
  editingId = null
  dialogTitle.value = '新建调节单'
  const first = rank.rows.value.find((row) => row.level !== '平衡')
  Object.assign(form, {
    ...EMPTY_ADJUST_DRAFT,
    valveId: first ? first.valve.id : valveOptions.value[0]?.value ?? '',
    targetOpening: first ? first.suggestOpening : 50,
    basis: first ? describeRow(first.valve.id) : ''
  })
  dialogVisible.value = true
}

function openEdit(row: AdjustEnriched): void {
  editingId = row.adjust.id
  dialogTitle.value = `编辑调节单 · ${row.valve ? row.valve.code : ''}`
  Object.assign(form, {
    valveId: row.adjust.valveId,
    targetOpening: row.adjust.targetOpening,
    basis: row.adjust.basis,
    executor: row.adjust.executor,
    state: row.adjust.state,
    reviewNote: row.adjust.reviewNote
  })
  dialogVisible.value = true
}

function describeRow(valveId: string): string {
  const row = rank.rowOf(valveId)
  if (!row) return ''
  return basisText({
    valve: row.valve,
    building: row.building,
    ratio: row.ratio,
    flowDeviation: row.flowDeviation,
    roomDeviation: row.roomDeviation,
    imbalanceValue: row.imbalanceValue,
    level: row.level
  })
}

async function submit(): Promise<void> {
  try {
    const result = await formRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingId) {
    await adjustStore.updateAdjust(editingId, { ...form })
    MessagePlugin.success('调节单已更新')
  } else {
    await adjustStore.createAdjust({ ...form })
    MessagePlugin.success('调节单已创建')
  }
  dialogVisible.value = false
  await refreshCounts()
}

function remove(adjust: Adjust): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: '确认删除该调节单？删除后不可恢复。',
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await adjustStore.removeAdjust(adjust.id)
      MessagePlugin.success('调节单已删除')
      dialog.destroy()
      await refreshCounts()
    }
  })
}

/* ---------------------------- 状态流转 ---------------------------- */

function nextStateOf(state: AdjustState): AdjustState | null {
  return ADJUST_STATE_FLOW[state]
}

const nextStateLabel = (state: AdjustState): string => {
  const next = nextStateOf(state)
  if (next === '已调节') return '执行调节'
  if (next === '已复核') return '复核闭环'
  return '已闭环'
}

async function advance(row: AdjustEnriched): Promise<void> {
  const next = ADJUST_STATE_FLOW[row.adjust.state]
  if (!next) {
    MessagePlugin.info('该调节单已完成复核闭环')
    return
  }
  if (next === '已复核') {
    openReview(row)
    return
  }
  await adjustStore.advance(row.adjust.id)
  MessagePlugin.success(`已推进为「${next}」，目标开度已回写到阀门台账`)
  await refreshCounts()
}

/* ------------------------------ 复核 ------------------------------ */

const reviewVisible = ref(false)
const reviewNote = ref('')
const reviewTargetId = ref<string | null>(null)
const reviewTargetLabel = ref('')

function openReview(row: AdjustEnriched): void {
  reviewTargetId.value = row.adjust.id
  reviewTargetLabel.value = row.valve ? row.valve.code : ''
  reviewNote.value = row.adjust.reviewNote || '复核后流量比恢复至 0.95 以上，室温达标，同意闭环'
  reviewVisible.value = true
}

async function submitReview(): Promise<void> {
  if (!reviewTargetId.value) return
  await adjustStore.review(reviewTargetId.value, reviewNote.value)
  MessagePlugin.success('复核完成，调节单已闭环')
  reviewVisible.value = false
  await refreshCounts()
}

/* ---------------------------- 备份导出 ---------------------------- */

function exportCsv(): void {
  const filename = exportAdjustCsv(
    stationStore.stations,
    stationStore.buildings,
    valveStore.valves,
    rank.measureTable.rows.value,
    adjustStore.adjusts
  )
  MessagePlugin.success(`已导出 ${filename}`)
}

function exportJson(): void {
  void (async () => {
    const payload = await exportSnapshot()
    const filename = `gbheatgrid-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    const iso = new Date().toISOString()
    stampBackupTime(iso)
    lastBackupAt.value = iso
    MessagePlugin.success(`已导出全量结构版本 ${filename}`)
  })()
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const payload = JSON.parse(await file.text()) as BackupPayload
    if (payload.app !== 'gbheatgrid') {
      MessagePlugin.error('存档文件格式不匹配（缺少 app: gbheatgrid 标识）')
      return
    }
    await importSnapshot(payload)
    MessagePlugin.success('存档已导入')
    await refreshCounts()
  } catch (error) {
    MessagePlugin.error(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    target.value = ''
  }
}

function reseed(): void {
  const dialog = DialogPlugin.confirm({
    header: '重置确认',
    body: '重置将清空现有数据并重新写入演示数据，确认继续？',
    confirmBtn: '重置并播种',
    cancelBtn: '取消',
    onConfirm: async () => {
      await resetDatabase()
      MessagePlugin.success('已重置为演示数据')
      dialog.destroy()
      await refreshCounts()
    }
  })
}

function clearData(): void {
  const dialog = DialogPlugin.confirm({
    header: '清空确认',
    body: '清空后所有本地数据将被删除且不可恢复，确认清空？',
    confirmBtn: '确认清空',
    cancelBtn: '取消',
    onConfirm: async () => {
      await clearAllTables()
      MessagePlugin.success('本地数据已清空')
      dialog.destroy()
      await refreshCounts()
    }
  })
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">调节单下发与复核</h2>
        <p class="page-head__desc">
          调节单状态机：待下发 → 已调节（回写阀门开度）→ 已复核（记录复核意见）。
        </p>
      </div>
      <div class="page-head__actions">
        <t-button variant="outline" @click="exportCsv">导出调节单 CSV</t-button>
        <t-button variant="outline" @click="exportJson">导出全量 JSON</t-button>
        <t-button variant="outline" @click="triggerImport">导入 JSON</t-button>
        <t-button theme="primary" @click="openCreate">新建调节单</t-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="待下发" :value="adjustStore.stateCounts['待下发']" suffix="张" tone="warning" />
      <StatBadge label="已调节" :value="adjustStore.stateCounts['已调节']" suffix="张" tone="info" />
      <StatBadge label="已复核" :value="adjustStore.stateCounts['已复核']" suffix="张" tone="success" />
      <StatBadge label="复核率" :value="adjustStore.reviewedPercent" :percent="adjustStore.reviewedPercent" suffix="%" tone="primary" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索阀门编号 / 执行人 / 依据"
      @change="onFilterChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">调节单（{{ rows.length }} / {{ adjustStore.adjusts.length }}）</h3>
        <span class="muted">执行人未指派时可先下发，执行后回填</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="还没有调节单"
        description="可到失衡度计算页一键生成，或在此手工新建。"
        action-text="新建调节单"
        secondary-text="重置为演示数据"
        compact
        :show-seed="adjustStore.adjusts.length === 0"
        @action="openCreate"
        @secondary="reseed"
        @seed="reseed"
      />

      <t-table v-else :data="rows" :columns="columns" :row-key="rowKey" bordered stripe size="small">
        <template #valveCell="{ row }">
          <div>
            <strong>{{ row.valve ? row.valve.code : '阀门已删除' }}</strong>
            <div class="muted">
              {{ row.valve ? stationStore.stationById.get(row.valve.stationId)?.name ?? '' : '' }}
            </div>
          </div>
        </template>
        <template #imbalanceCell="{ row }">
          <BalanceTag v-if="row.valve" :level="row.level" :imbalance="row.imbalanceValue" size="small" />
          <span v-else class="muted">—</span>
        </template>
        <template #openingCell="{ row }">
          {{ row.valve ? formatOpening(row.valve.currentOpening) : '—' }} →
          <strong>{{ formatOpening(row.adjust.targetOpening) }}</strong>
        </template>
        <template #basisCell="{ row }">
          <span class="muted">{{ row.adjust.basis }}</span>
        </template>
        <template #stateCell="{ row }">
          <t-tag
            size="small"
            variant="light"
            :theme="row.adjust.state === '已复核' ? 'success' : row.adjust.state === '已调节' ? 'primary' : 'warning'"
          >
            {{ row.adjust.state }}
          </t-tag>
        </template>
        <template #noteCell="{ row }">
          <span class="muted">{{ row.adjust.reviewNote || '—' }}</span>
        </template>
        <template #opCell="{ row }">
          <div class="toolbar">
            <t-button
              size="small"
              variant="text"
              theme="primary"
              :disabled="!nextStateOf(row.adjust.state as AdjustState)"
              @click="advance(row)"
            >
              {{ nextStateLabel(row.adjust.state as AdjustState) }}
            </t-button>
            <t-button size="small" variant="text" theme="primary" @click="openEdit(row)">编辑</t-button>
            <t-button size="small" variant="text" theme="danger" @click="remove(row.adjust)">删除</t-button>
          </div>
        </template>
      </t-table>
    </div>

    <div class="panel">
      <h3 class="panel-title">结构版本与本地数据</h3>
      <t-descriptions :column="3" bordered size="small">
        <t-descriptions-item label="IndexedDB 库名">gbheatgrid</t-descriptions-item>
        <t-descriptions-item label="数据结构版本">v{{ DB_VERSION }}（记录 v{{ stampedVersion }}）</t-descriptions-item>
        <t-descriptions-item label="最近备份">{{ lastBackupAt ?? '尚未备份' }}</t-descriptions-item>
        <t-descriptions-item label="换热站 / 楼栋">
          {{ counts.stations ?? 0 }} / {{ counts.buildings ?? 0 }}
        </t-descriptions-item>
        <t-descriptions-item label="阀门 / 实测">
          {{ counts.valves ?? 0 }} / {{ counts.measures ?? 0 }}
        </t-descriptions-item>
        <t-descriptions-item label="调节单">{{ counts.adjusts ?? 0 }}</t-descriptions-item>
      </t-descriptions>
      <div class="toolbar" style="margin-top: 14px">
        <t-button theme="primary" variant="outline" @click="exportJson">导出全量 JSON</t-button>
        <t-button variant="outline" @click="reseed">重置为演示数据</t-button>
        <t-button theme="danger" variant="outline" @click="clearData">清空本地数据</t-button>
        <t-button variant="text" theme="primary" @click="refreshCounts">刷新统计</t-button>
      </div>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChange" />
    </div>

    <t-dialog
      v-model:visible="dialogVisible"
      :header="dialogTitle"
      width="620px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submit"
    >
      <t-form ref="formRef" :data="form" :rules="rules" label-width="128px">
        <t-form-item label="阀门" name="valveId">
          <t-select v-model="form.valveId" :options="valveOptions" filterable placeholder="选择阀门" />
        </t-form-item>
        <t-form-item label="目标开度(%)" name="targetOpening">
          <t-input-number v-model="form.targetOpening" :min="0" :max="100" :step="5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="调节依据" name="basis">
          <t-textarea v-model="form.basis" :autosize="{ minRows: 3, maxRows: 5 }" placeholder="如：流量比 0.74 偏小，需增大开度" />
        </t-form-item>
        <t-form-item label="执行人" name="executor">
          <t-input v-model="form.executor" placeholder="如 王海" />
        </t-form-item>
        <t-form-item label="状态" name="state">
          <t-select
            v-model="form.state"
            :options="ADJUST_STATES.map((item) => ({ label: item, value: item }))"
            style="width: 100%"
          />
        </t-form-item>
        <t-form-item label="复核意见" name="reviewNote">
          <t-input v-model="form.reviewNote" placeholder="复核合格可留空" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <t-dialog
      v-model:visible="reviewVisible"
      :header="`复核闭环 · ${reviewTargetLabel}`"
      width="520px"
      :confirm-btn="'确认闭环'"
      :cancel-btn="'取消'"
      @confirm="submitReview"
    >
      <t-textarea v-model="reviewNote" :autosize="{ minRows: 3, maxRows: 6 }" placeholder="填写复核结论" />
      <p class="muted">复核后调节单状态置为「已复核」，并保留复核意见。</p>
    </t-dialog>
  </div>
</template>
