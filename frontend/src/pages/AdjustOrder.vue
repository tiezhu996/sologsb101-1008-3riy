<script setup lang="ts">
/**
 * /adjusts 调节单下发与复核
 * 换班协作：待下发调节单先认领进「执行批次」，页面拿到租约后逐张执行；
 * 执行记录与阀门开度同事务落库，已完成项不被另一页重复处理；
 * 租约失效/写入失败后另一页可从最后完成项接管恢复。
 * 消费 Adjust、Valve、Measure、ExecutionBatch；复用公共组件。
 */
import { computed, onMounted, reactive, ref, watchEffect } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import BalanceTag from '@/components/common/BalanceTag.vue'
import { useAdjustStore, type AdjustEnriched } from '@/stores/adjustStore'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import { useExecutionBatches } from '@/hooks/useExecutionBatches'
import {
  ADJUST_STATES,
  EMPTY_ADJUST_DRAFT,
  type Adjust,
  type AdjustDraft,
  type AdjustState
} from '@/types/adjust'
import { basisText, formatOpening } from '@/utils/balance'
import { exportAdjustCsv, formatDateTime } from '@/utils/export'
import type { ExecutionBatchRow } from '@/utils/db'
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
const {
  batches: execBatches,
  items: execItems,
  activeBatch,
  historicalBatches,
  session,
  running: execRunning,
  ownsLease,
  leasedByOther,
  leaseRemainingMs,
  itemsOf,
  switchShift,
  claim,
  claimAndRun,
  runBatch,
  stopRunning,
  retry,
  backfillHistory,
  refresh: refreshExec
} = useExecutionBatches()

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

// 首次进入：旧调节单（已调节/已复核）幂等补成历史批次，刷新按最终执行结果展示
onMounted(() => {
  void backfillHistory()
    .then((n: number) => {
      if (n > 0) MessagePlugin.info(`已将 ${n} 张旧调节单补录为历史执行批次`)
      return refreshExec()
    })
    .then(() => refreshCounts())
    .catch(() => undefined)
})

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

/* ------------------------------ 班次身份 ------------------------------ */

const shiftOptions = [
  { label: '白班', value: '白班' },
  { label: '夜班', value: '夜班' }
]

function onShiftChange(value: unknown): void {
  const shift = value === '夜班' ? '夜班' : '白班'
  switchShift(shift)
  MessagePlugin.success(`已切换为${shift}（页签 ${session.tag}）`)
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
  { colKey: 'valve', title: '阀门 / 楼栋', width: 190, cell: 'valveCell' },
  { colKey: 'imbalance', title: '失衡度', width: 140, cell: 'imbalanceCell' },
  { colKey: 'opening', title: '当前 → 目标 / 最终开度', width: 200, cell: 'openingCell' },
  { colKey: 'basis', title: '调节依据', minWidth: 240, cell: 'basisCell' },
  { colKey: 'executor', title: '执行人/批次', width: 150, cell: 'executorCell' },
  { colKey: 'state', title: '状态', width: 100, cell: 'stateCell' },
  { colKey: 'note', title: '复核意见', width: 160, cell: 'noteCell' },
  { colKey: 'op', title: '操作', width: 240, cell: 'opCell' }
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
    body: '确认删除该调节单？其执行记录将一并从所属批次移除，删除后不可恢复。',
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

/* ------------------------ 执行批次：认领 / 执行 ------------------------ */

/** 待下发且未认领的调节单（批量认领复选框） */
const selectedPendingIds = ref<string[]>([])

const pendingRows = computed(() => rows.value.filter((row) => row.adjust.state === '待下发' && !row.adjust.batchId))

const allPendingChecked = computed({
  get: () => pendingRows.value.length > 0 && pendingRows.value.every((row) => selectedPendingIds.value.includes(row.adjust.id)),
  set: (checked: boolean) => {
    selectedPendingIds.value = checked ? pendingRows.value.map((row) => row.adjust.id) : []
  }
})

function onPendingCheck(row: AdjustEnriched, checked: boolean): void {
  const id = row.adjust.id
  selectedPendingIds.value = checked
    ? Array.from(new Set([...selectedPendingIds.value, id]))
    : selectedPendingIds.value.filter((item) => item !== id)
}

async function claimSelected(runAfter: boolean): Promise<void> {
  const ids = selectedPendingIds.value.length > 0 ? selectedPendingIds.value : pendingRows.value.map((row) => row.adjust.id)
  if (ids.length === 0) {
    MessagePlugin.info('没有待认领的待下发调节单')
    return
  }
  try {
    if (runAfter) {
      const summary = await claimAndRun(ids)
      MessagePlugin[summary.failed > 0 || summary.message.includes('中断') ? 'warning' : 'success'](summary.message)
    } else {
      const { claimed } = await claim(ids)
      MessagePlugin.success(claimed > 0 ? `已认领 ${claimed} 张调节单进执行批次` : '所选调节单此前已被认领')
    }
    selectedPendingIds.value = []
    await refreshCounts()
  } catch (error) {
    MessagePlugin.error(error instanceof Error ? error.message : '认领失败')
  }
}

/** 单张认领并执行 */
async function claimOne(row: AdjustEnriched): Promise<void> {
  try {
    const summary = await claimAndRun([row.adjust.id])
    MessagePlugin[summary.failed > 0 || summary.message.includes('中断') ? 'warning' : 'success'](summary.message)
    await refreshCounts()
  } catch (error) {
    MessagePlugin.error(error instanceof Error ? error.message : '认领失败')
  }
}

async function runActiveBatch(): Promise<void> {
  const batch = activeBatch.value
  if (!batch) {
    MessagePlugin.info('当前没有可执行的批次')
    return
  }
  const summary = await runBatch(batch.id)
  MessagePlugin[summary.failed > 0 || summary.message.includes('中断') || summary.message.includes('正被') ? 'warning' : 'success'](
    summary.message
  )
  await refreshCounts()
}

async function takeOverAndRun(): Promise<void> {
  await runActiveBatch()
}

async function pauseBatch(): Promise<void> {
  await stopRunning()
  MessagePlugin.info('已暂停并释放租约，另一页可接管继续执行')
}

async function retryBatch(batch: ExecutionBatchRow): Promise<void> {
  try {
    const reset = await retry(batch.id)
    MessagePlugin.success(`已重置 ${reset} 个失败项，继续执行`)
    const summary = await runBatch(batch.id)
    MessagePlugin[summary.failed > 0 ? 'warning' : 'success'](summary.message)
  } catch (error) {
    MessagePlugin.error(error instanceof Error ? error.message : '重试失败')
  }
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

/** 行内主操作已拆分为认领执行 / 查看批次 / 复核闭环按钮，见模板 opCell */

/* ---------------------------- 批次视图派生 ---------------------------- */

function batchProgress(batch: ExecutionBatchRow): { percent: number; text: string } {
  const done = batch.completedCount
  const percent = batch.itemCount === 0 ? 0 : Math.round((done / batch.itemCount) * 100)
  return { percent, text: `${done} / ${batch.itemCount}` }
}

function leaseText(batch: ExecutionBatchRow): string {
  if (ownsLease(batch)) return `本页持约 · 剩 ${Math.ceil(leaseRemainingMs(batch) / 1000)}s`
  if (leasedByOther(batch)) return `${batch.leaseOwner} 执行中 · 剩 ${Math.ceil(leaseRemainingMs(batch) / 1000)}s`
  return '租约空闲 · 可接管'
}

const batchStateTheme = (state: ExecutionBatchRow['state']): 'success' | 'warning' | 'primary' | 'danger' | 'default' => {
  if (state === '已完成') return 'success'
  if (state === '历史批次') return 'default'
  if (state === '已中断') return 'danger'
  if (state === '执行中') return 'primary'
  return 'warning'
}

const activeBatchItems = computed(() => (activeBatch.value ? itemsOf(activeBatch.value.id) : []))

/* ---------------------------- 备份导出 ---------------------------- */

function exportCsv(): void {
  const filename = exportAdjustCsv(
    stationStore.stations,
    stationStore.buildings,
    valveStore.valves,
    rank.measureTable.rows.value,
    adjustStore.adjusts,
    execItems.value,
    execBatches.value
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
          待下发调节单先认领进执行批次，页面拿到租约后逐张执行；执行记录与阀门开度同事务落库，换班不重复、开度对得上。
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

    <!-- 班次身份与执行批次协作 -->
    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">执行批次协作</h3>
        <div class="toolbar">
          <span class="muted">当前班次</span>
          <t-radio-group
            :value="session.shift"
            variant="default-filled"
            size="small"
            :options="shiftOptions"
            @change="onShiftChange"
          />
          <t-tag size="small" theme="primary" variant="light">
            {{ session.shift }} · 页签 {{ session.tag }}
          </t-tag>
        </div>
      </div>

      <!-- 存在未完成批次：展示租约与接管 -->
      <div v-if="activeBatch" class="batch-card">
        <div class="batch-card__head">
          <div>
            <t-tag size="small" :theme="batchStateTheme(activeBatch.state)" variant="light">
              {{ activeBatch.state }}
            </t-tag>
            <strong style="margin-left: 8px">{{ activeBatch.name }}</strong>
          </div>
          <span class="muted">{{ leaseText(activeBatch) }}</span>
        </div>
        <t-progress
          :percentage="batchProgress(activeBatch).percent"
          :label="true"
          style="margin: 10px 0"
        />
        <div class="muted" style="margin-bottom: 10px">
          进度 {{ batchProgress(activeBatch).text }}
          <template v-if="activeBatch.failedCount > 0">
            ，失败 {{ activeBatch.failedCount }} 项（最后完成序号 {{ activeBatch.lastCompletedSeq }}，可接管续跑）
          </template>
          <template v-else>
            ，最后完成序号 {{ activeBatch.lastCompletedSeq }}
          </template>
        </div>

        <ul class="batch-items">
          <li v-for="item in activeBatchItems" :key="item.id" class="batch-items__li">
            <span class="batch-items__seq">{{ item.seq }}</span>
            <span>{{ item.valveId }}</span>
            <t-tag
              size="small"
              variant="light"
              :theme="item.status === '已完成' ? 'success' : item.status === '失败' ? 'danger' : 'warning'"
            >
              {{ item.status }}
            </t-tag>
            <span v-if="item.executedOpening !== null" class="muted">
              最终开度 {{ item.executedOpening }}% · {{ formatDateTime(item.executedAt) }} · {{ item.executedBy }}
            </span>
            <span v-else-if="item.status === '失败'" class="muted" style="color: #c0392b">
              {{ item.failReason }}
            </span>
            <span v-else class="muted">待执行（目标 {{ item.targetOpening }}%）</span>
          </li>
        </ul>

        <div class="toolbar" style="margin-top: 12px">
          <t-button
            v-if="ownsLease(activeBatch) && execRunning"
            theme="warning"
            variant="outline"
            @click="pauseBatch"
          >
            暂停并释放租约
          </t-button>
          <t-button
            v-else-if="ownsLease(activeBatch)"
            theme="primary"
            :loading="execRunning"
            @click="runActiveBatch"
          >
            继续执行本批次
          </t-button>
          <t-button
            v-else-if="!leasedByOther(activeBatch)"
            theme="primary"
            :loading="execRunning"
            @click="takeOverAndRun"
          >
            接管租约并从最后完成项续跑
          </t-button>
          <t-tag v-else size="small" theme="primary" variant="light">
            租约内不可抢占，等待 {{ activeBatch.leaseOwner }} 释放或租约到期
          </t-tag>
          <t-button
            v-if="activeBatch.failedCount > 0 && !leasedByOther(activeBatch)"
            theme="danger"
            variant="outline"
            :disabled="execRunning"
            @click="retryBatch(activeBatch)"
          >
            重试失败项并续跑
          </t-button>
        </div>
      </div>

      <!-- 无未完成批次：认领待下发调节单 -->
      <div v-else>
        <p class="muted" style="margin: 4px 0 10px">
          待下发调节单需先认领进批次，拿到租约后才逐张执行；已被认领的不会在另一页重复处理。
        </p>
        <div class="toolbar">
          <t-button theme="primary" :disabled="pendingRows.length === 0 || execRunning" @click="claimSelected(true)">
            {{ selectedPendingIds.length > 0 ? `认领选中 ${selectedPendingIds.length} 张并执行` : '一键认领全部待下发并执行' }}
          </t-button>
          <t-button variant="outline" :disabled="pendingRows.length === 0 || execRunning" @click="claimSelected(false)">
            仅认领进批次
          </t-button>
          <t-checkbox v-if="pendingRows.length > 0" :checked="allPendingChecked" @change="(v: boolean) => (allPendingChecked = v)">
            全选待下发（{{ pendingRows.length }}）
          </t-checkbox>
        </div>
      </div>

      <!-- 历史批次 -->
      <div v-if="historicalBatches.length > 0" style="margin-top: 12px">
        <p class="muted" style="margin: 0 0 6px">历史执行批次（旧调节单首次进入已补录，按最终执行结果留存）：</p>
        <div v-for="batch in historicalBatches" :key="batch.id" class="batch-history">
          <t-tag size="small" theme="default" variant="light">{{ batch.state }}</t-tag>
          <span style="margin-left: 8px">{{ batch.name }}</span>
          <span class="muted" style="margin-left: 8px">{{ batch.completedCount }} 张 · {{ formatDateTime(batch.createdAt) }}</span>
        </div>
      </div>
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
        <span class="muted">最终开度以执行记录为准；执行记录与阀门开度同事务保存</span>
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
          <div>
            {{ row.valve ? formatOpening(row.valve.currentOpening) : '—' }} →
            目标 <strong>{{ formatOpening(row.adjust.targetOpening) }}</strong>
          </div>
          <div v-if="row.finalOpening !== null" class="muted">
            最终执行 <strong style="color: #1e8449">{{ formatOpening(row.finalOpening) }}</strong>
          </div>
          <div v-else class="muted">尚未执行</div>
        </template>
        <template #basisCell="{ row }">
          <span class="muted">{{ row.adjust.basis }}</span>
        </template>
        <template #executorCell="{ row }">
          <div>{{ row.execution && row.execution.executedBy ? row.execution.executedBy : row.adjust.executor }}</div>
          <div v-if="row.execution && row.execution.executedAt" class="muted">
            {{ formatDateTime(row.execution.executedAt) }}
          </div>
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
            <t-checkbox
              v-if="row.adjust.state === '待下发' && !row.adjust.batchId"
              :checked="selectedPendingIds.includes(row.adjust.id)"
              @change="(checked: boolean) => onPendingCheck(row, checked)"
            />
            <t-button
              v-if="row.adjust.state === '待下发' && !row.adjust.batchId"
              size="small"
              variant="text"
              theme="primary"
              :disabled="execRunning"
              @click="claimOne(row)"
            >
              认领并执行
            </t-button>
            <t-button
              v-else-if="row.adjust.state === '待下发' && row.adjust.batchId"
              size="small"
              variant="text"
              theme="primary"
              @click="runActiveBatch"
            >
              查看批次
            </t-button>
            <t-button
              v-else-if="row.adjust.state === '已调节'"
              size="small"
              variant="text"
              theme="primary"
              @click="openReview(row)"
            >
              复核闭环
            </t-button>
            <t-tag v-else size="small" theme="success" variant="light">已闭环</t-tag>
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
        <t-descriptions-item label="调节单 / 执行批次">
          {{ counts.adjusts ?? 0 }} / {{ counts.executionBatches ?? 0 }}
        </t-descriptions-item>
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
      <p class="muted">复核后调节单状态置为「已复核」，并保留复核意见；执行开度以批次执行记录为准。</p>
    </t-dialog>
  </div>
</template>
