<script setup lang="ts">
/**
 * /measures 实测流量 / 供回水温录入
 * 按日期成组录入流量与三温，支持批量粘贴导入，自动预览失衡度。
 * 消费 Measure、Valve；复用 <FilterBar>、<EmptyPanel>、<BalanceTag>。
 */
import { computed, reactive, ref } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import BalanceTag from '@/components/common/BalanceTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import { EMPTY_MEASURE_DRAFT, type Measure, type MeasureDraft } from '@/types/measure'
import type { MeasureRow } from '@/utils/db'
import { balanceLevel, formatFlow, formatTemp, imbalance } from '@/utils/balance'
import { parseMeasureBatch } from '@/utils/export'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const valveStore = useValveStore()
const stationStore = useStationStore()
const rank = useImbalanceRank()
const measureTable = useIdbTable<MeasureRow>((database) => database.measures, { sortByUpdatedAt: false })

const activeValveId = ref<string>('')
const detailDialogVisible = ref(false)
const detailTitle = ref('录入实测')
const form = reactive<MeasureDraft>({ ...EMPTY_MEASURE_DRAFT })
const formRef = ref()
let editingId: string | null = null

const batchText = ref('')
const batchDialogVisible = ref(false)

const rules = {
  date: [{ required: true, message: '请填写实测日期（YYYY-MM-DD）', type: 'error' as const }],
  flowM3h: [{ required: true, message: '请填写实测流量', type: 'error' as const }],
  operator: [{ required: true, message: '请填写录入人', type: 'error' as const }]
}

const filterModel = computed<FilterModel>(() => ({
  keyword: valveStore.filter.keyword,
  station: valveStore.filter.stationId
}))

const filterSelects = computed(() => [
  {
    key: 'station',
    label: '换热站',
    multiple: false,
    options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
  }
])

function onFilterChange(model: FilterModel): void {
  valveStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    stationId: typeof model.station === 'string' ? model.station : ''
  })
}

const candidates = computed(() => valveStore.filtered)

const activeValve = computed(() => valveStore.valves.find((valve) => valve.id === activeValveId.value) ?? null)
const activeRow = computed(() => (activeValveId.value ? rank.rowOf(activeValveId.value) : null))

const measuresOfActive = computed(() =>
  measureTable.rows.value
    .filter((measure) => measure.valveId === activeValveId.value)
    .sort((a, b) => b.date.localeCompare(a.date))
)

const latestMeasures = computed(() =>
  [...measureTable.rows.value].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12)
)

const previewImbalance = computed(() => {
  const design = activeValve.value ? activeValve.value.designFlowM3h : 0
  const value = imbalance(form.flowM3h, design, form.roomTempC)
  return { value, level: balanceLevel(value, form.flowM3h, design) }
})

/* ------------------------------ 录入 ------------------------------ */

function selectValve(id: string): void {
  activeValveId.value = id
}

function openCreate(): void {
  if (!activeValve.value) {
    MessagePlugin.warning('请先在左侧选择一只阀门')
    return
  }
  editingId = null
  detailTitle.value = `录入实测 · ${activeValve.value.code}`
  Object.assign(form, {
    valveId: activeValve.value.id,
    date: new Date().toISOString().slice(0, 10),
    flowM3h: activeRow.value?.measured || activeValve.value.designFlowM3h,
    supplyTempC: 50,
    returnTempC: 40,
    roomTempC: 20,
    operator: ''
  })
  detailDialogVisible.value = true
}

function openEdit(measure: Measure): void {
  editingId = measure.id
  detailTitle.value = `编辑实测 · ${measure.date}`
  Object.assign(form, {
    valveId: measure.valveId,
    date: measure.date,
    flowM3h: measure.flowM3h,
    supplyTempC: measure.supplyTempC,
    returnTempC: measure.returnTempC,
    roomTempC: measure.roomTempC,
    operator: measure.operator
  })
  detailDialogVisible.value = true
}

async function submit(): Promise<void> {
  try {
    const result = await formRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingId) {
    await measureTable.update(editingId, { ...form })
    MessagePlugin.success('实测记录已更新')
  } else {
    await measureTable.create({ ...form }, 'ms')
    MessagePlugin.success('实测记录已保存，流量比与室温偏差已自动计算')
  }
  detailDialogVisible.value = false
}

function remove(measure: Measure): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: `确认删除 ${measure.date} 的实测记录？`,
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await measureTable.remove(measure.id)
      MessagePlugin.success('实测记录已删除')
      dialog.destroy()
    }
  })
}

/* ---------------------------- 批量粘贴 ---------------------------- */

const batchPreview = computed(() => {
  const parsed = parseMeasureBatch(batchText.value)
  return parsed.map((row) => {
    const valve = valveStore.valves.find((item) => item.code === row.code) ?? null
    const design = valve ? valve.designFlowM3h : 0
    const value = valve ? imbalance(row.flowM3h, design, row.roomTempC) : 0
    return { ...row, valve, imbalanceValue: value }
  })
})

async function importBatch(): Promise<void> {
  const rows = batchPreview.value.filter((row) => row.valve !== null)
  if (rows.length === 0) {
    MessagePlugin.warning('没有解析到可匹配阀门编号的数据行')
    return
  }
  const now = Date.now()
  await measureTable.bulkPut(
    rows.map((row, index) => ({
      id: `ms_${now.toString(36)}${index}${Math.random().toString(36).slice(2, 5)}`,
      valveId: row.valve!.id,
      date: row.date,
      flowM3h: row.flowM3h,
      supplyTempC: row.supplyTempC,
      returnTempC: row.returnTempC,
      roomTempC: row.roomTempC,
      operator: row.operator || '批量导入',
      createdAt: now,
      updatedAt: now
    }))
  )
  MessagePlugin.success(`已批量导入 ${rows.length} 条实测记录`)
  batchText.value = ''
  batchDialogVisible.value = false
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">实测流量 / 供回水温录入</h2>
        <p class="page-head__desc">
          选定阀门后按日期成组录入流量与三温，系统即时给出流量比、室温偏差与失衡度。
        </p>
      </div>
      <div class="page-head__actions">
        <t-button variant="outline" @click="batchDialogVisible = true">批量粘贴导入</t-button>
        <t-button theme="primary" :disabled="!activeValveId" @click="openCreate">录入实测</t-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="实测记录" :value="measureTable.rows.value.length" suffix="条" tone="primary" />
      <StatBadge label="已实测阀门" :value="new Set(measureTable.rows.value.map((item) => item.valveId)).size" suffix="只" tone="info" />
      <StatBadge label="平均失衡度" :value="rank.summary.value.average.toFixed(1)" suffix="%" tone="warning" />
      <StatBadge label="严重失衡" :value="rank.summary.value.severe" suffix="只" tone="danger" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索阀门编号 / 楼栋"
      @change="onFilterChange"
    />

    <div class="grid-two" style="margin-top: 16px">
      <div class="panel">
        <h3 class="panel-title">阀门列表（{{ candidates.length }}）</h3>
        <EmptyPanel
          v-if="candidates.length === 0"
          title="没有可录入的阀门"
          description="先到换热站台账登记楼栋与阀门。"
          compact
        />
        <div
          v-for="item in candidates"
          :key="item.valve.id"
          class="card-list-item"
          :class="{ 'is-active': item.valve.id === activeValveId }"
          @click="selectValve(item.valve.id)"
        >
          <div class="card-list-item__head">
            <span>{{ item.valve.code }}</span>
            <BalanceTag
              v-if="rank.rowOf(item.valve.id)?.latest"
              :level="rank.rowOf(item.valve.id)!.level"
              size="small"
            />
          </div>
          <div class="card-list-item__meta">
            <span>{{ item.building ? item.building.name : '—' }}</span>
            <span>· DN{{ item.valve.dn }}</span>
            <span>· 设计 {{ item.valve.designFlowM3h.toFixed(1) }} m³/h</span>
            <span>· 实测 {{ item.valve.id ? (rank.rowOf(item.valve.id)?.measureCount ?? 0) : 0 }} 次</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <template v-if="activeValve">
          <div class="panel-head">
            <h3 class="panel-title" style="margin: 0">
              {{ activeValve.code }} · 实测明细
              <span class="muted">
                {{ stationStore.stationById.get(activeValve.stationId)?.name ?? '' }}
              </span>
            </h3>
            <div class="toolbar">
              <span v-if="activeRow && activeRow.latest" class="muted">
                最新 {{ activeRow.latest.date }}：{{ formatFlow(activeRow.measured) }} ·
                {{ formatTemp(activeRow.latest.roomTempC) }}
              </span>
              <t-button size="small" theme="primary" @click="openCreate">录入实测</t-button>
            </div>
          </div>

          <EmptyPanel
            v-if="measuresOfActive.length === 0"
            title="该阀门暂无实测记录"
            description="点击「录入实测」登记第一条流量与三温读数。"
            action-text="录入实测"
            compact
            @action="openCreate"
          />

          <t-table
            v-else
            :data="measuresOfActive"
            :columns="[
              { colKey: 'date', title: '日期', width: 120 },
              { colKey: 'flow', title: '流量', width: 120, cell: 'flowCell' },
              { colKey: 'supply', title: '供水', width: 96, cell: 'supplyCell' },
              { colKey: 'back', title: '回水', width: 96, cell: 'backCell' },
              { colKey: 'room', title: '室温', width: 96, cell: 'roomCell' },
              { colKey: 'operator', title: '录入人', width: 100 },
              { colKey: 'op', title: '操作', width: 140, cell: 'opCell' }
            ]"
            row-key="id"
            bordered
            size="small"
          >
            <template #flowCell="{ row }">{{ formatFlow(row.flowM3h) }}</template>
            <template #supplyCell="{ row }">{{ formatTemp(row.supplyTempC) }}</template>
            <template #backCell="{ row }">{{ formatTemp(row.returnTempC) }}</template>
            <template #roomCell="{ row }">{{ formatTemp(row.roomTempC) }}</template>
            <template #opCell="{ row }">
              <div class="toolbar">
                <t-button size="small" variant="text" theme="primary" @click="openEdit(row)">编辑</t-button>
                <t-button size="small" variant="text" theme="danger" @click="remove(row)">删除</t-button>
              </div>
            </template>
          </t-table>

          <h4 class="panel-subtitle">最近录入（全部阀门）</h4>
          <t-table
            :data="latestMeasures"
            :columns="[
              { colKey: 'date', title: '日期', width: 120 },
              { colKey: 'valve', title: '阀门', width: 130, cell: 'valveCell' },
              { colKey: 'flow2', title: '流量', width: 120, cell: 'flow2Cell' },
              { colKey: 'room2', title: '室温', width: 96, cell: 'room2Cell' },
              { colKey: 'operator2', title: '录入人', width: 100, cell: 'operator2Cell' }
            ]"
            row-key="id"
            bordered
            size="small"
          >
            <template #valveCell="{ row }">
              {{ valveStore.valves.find((valve) => valve.id === row.valveId)?.code ?? '—' }}
            </template>
            <template #flow2Cell="{ row }">{{ formatFlow(row.flowM3h) }}</template>
            <template #room2Cell="{ row }">{{ formatTemp(row.roomTempC) }}</template>
            <template #operator2Cell="{ row }">{{ row.operator }}</template>
          </t-table>
        </template>

        <EmptyPanel v-else title="尚未选择阀门" description="在左侧列表选择一只阀门后即可录入实测数据。" compact />
      </div>
    </div>

    <t-dialog
      v-model:visible="detailDialogVisible"
      :header="detailTitle"
      width="560px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submit"
    >
      <t-form ref="formRef" :data="form" :rules="rules" label-width="128px">
        <t-form-item label="实测日期" name="date">
          <t-input v-model="form.date" placeholder="YYYY-MM-DD" />
        </t-form-item>
        <t-form-item label="实测流量(m³/h)" name="flowM3h">
          <t-input-number v-model="form.flowM3h" :min="0" :step="0.5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="供水温度(℃)" name="supplyTempC">
          <t-input-number v-model="form.supplyTempC" :min="0" :step="0.5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="回水温度(℃)" name="returnTempC">
          <t-input-number v-model="form.returnTempC" :min="0" :step="0.5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="室温(℃)" name="roomTempC">
          <t-input-number v-model="form.roomTempC" :min="0" :step="0.5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="录入人" name="operator">
          <t-input v-model="form.operator" placeholder="如 王海" />
        </t-form-item>
      </t-form>
      <t-alert theme="info" :message="`当前输入失衡度约 ${previewImbalance.value.toFixed(1)}% · 判定 ${previewImbalance.level}`" />
    </t-dialog>

    <t-dialog
      v-model:visible="batchDialogVisible"
      header="批量粘贴导入实测数据"
      width="680px"
      :confirm-btn="'解析并导入'"
      :cancel-btn="'取消'"
      @confirm="importBatch"
    >
      <p class="muted" style="margin-top: 0">
        每行一条：阀门编号,日期(YYYY-MM-DD),流量,供温,回温,室温,录入人
      </p>
      <t-textarea v-model="batchText" :autosize="{ minRows: 6, maxRows: 12 }" placeholder="BL-3-01,2024-11-25,20.5,50,39,20.4,王海" />
      <div v-if="batchPreview.length > 0" style="margin-top: 12px">
        <p class="muted">解析到 {{ batchPreview.length }} 行，可匹配 {{ batchPreview.filter((item) => item.valve).length }} 行：</p>
        <t-table
          :data="batchPreview"
          :columns="[
            { colKey: 'code', title: '阀门编号', width: 130 },
            { colKey: 'date', title: '日期', width: 120 },
            { colKey: 'flowM3h', title: '流量', width: 100 },
            { colKey: 'roomTempC', title: '室温', width: 90 },
            { colKey: 'match', title: '匹配', width: 90, cell: 'matchCell' },
            { colKey: 'imb', title: '失衡度', width: 100, cell: 'imbCell' }
          ]"
          row-key="code"
          size="small"
          bordered
        >
          <template #matchCell="{ row }">
            <t-tag size="small" :theme="row.valve ? 'success' : 'danger'" variant="light">
              {{ row.valve ? '已匹配' : '未匹配' }}
            </t-tag>
          </template>
          <template #imbCell="{ row }">
            {{ row.valve ? `${row.imbalanceValue.toFixed(1)}%` : '—' }}
          </template>
        </t-table>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.panel-subtitle {
  margin: 18px 0 8px;
  font-size: 14px;
  font-weight: 600;
}
</style>
