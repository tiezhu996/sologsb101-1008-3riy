<script setup lang="ts">
/**
 * /valves 阀位与设计参数登记
 * 登记口径、位置、当前开度与设计流量，登记阀位并对照设计流量校核开度。
 * 消费 Valve、Building；复用 <FilterBar>、<BalanceTag>、<EmptyPanel>。
 */
import { computed, reactive, ref } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import BalanceTag from '@/components/common/BalanceTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useValveStore, type ValveEnriched } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import {
  EMPTY_VALVE_DRAFT,
  VALVE_POSITIONS,
  type Valve,
  type ValveDraft,
  type ValvePosition
} from '@/types/valve'
import { HEAT_MODES, type HeatMode } from '@/types/building'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const valveStore = useValveStore()
const stationStore = useStationStore()
const rank = useImbalanceRank()

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: valveStore.filter.keyword,
  station: valveStore.filter.stationId,
  heatMode: valveStore.filter.heatModes,
  position: valveStore.filter.positions,
  only: valveStore.filter.onlyImbalanced
}))

const filterSelects = computed(() => [
  {
    key: 'station',
    label: '换热站',
    multiple: false,
    options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
  },
  { key: 'heatMode', label: '供热方式', options: HEAT_MODES.map((item) => ({ label: item, value: item })) },
  { key: 'position', label: '位置', options: VALVE_POSITIONS.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  valveStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    stationId: typeof model.station === 'string' ? model.station : '',
    heatModes: (Array.isArray(model.heatMode) ? model.heatMode : []) as HeatMode[],
    positions: (Array.isArray(model.position) ? model.position : []) as ValvePosition[],
    onlyImbalanced: model.only === true
  })
}

const filteredRows = computed(() =>
  valveStore.filtered.filter((item) => {
    if (valveStore.filter.onlyImbalanced) {
      const row = rank.rowOf(item.valve.id)
      return row ? row.level !== '平衡' : false
    }
    return true
  })
)

const columns = [
  { colKey: 'code', title: '阀门编号', width: 130, cell: 'codeCell' },
  { colKey: 'where', title: '换热站 / 楼栋', width: 200, cell: 'whereCell' },
  { colKey: 'dn', title: '口径', width: 90, cell: 'dnCell' },
  { colKey: 'position', title: '位置', width: 110 },
  { colKey: 'design', title: '设计流量', width: 120, cell: 'designCell' },
  { colKey: 'opening', title: '当前开度', width: 168, cell: 'openingCell' },
  { colKey: 'balance', title: '失衡判定', width: 150, cell: 'balanceCell' },
  { colKey: 'check', title: '开度校核', minWidth: 170, cell: 'checkCell' },
  { colKey: 'op', title: '操作', width: 170, cell: 'opCell' }
]

function valveRowKey(row: ValveEnriched): string {
  return row.valve.id
}

/* ------------------------------ 表单 ------------------------------ */

const dialogVisible = ref(false)
const dialogTitle = ref('登记阀门')
const form = reactive<ValveDraft>({ ...EMPTY_VALVE_DRAFT })
const formRef = ref()
let editingId: string | null = null

const rules = {
  buildingId: [{ required: true, message: '请选择所属楼栋', type: 'error' as const }],
  code: [{ required: true, message: '请填写阀门编号', type: 'error' as const }],
  designFlowM3h: [{ required: true, message: '请填写设计流量', type: 'error' as const }]
}

const buildingOptions = computed(() =>
  stationStore.buildings
    .filter((building) => !valveStore.filter.stationId || building.stationId === valveStore.filter.stationId)
    .map((building) => {
      const station = stationStore.stationById.get(building.stationId)
      return {
        label: `${station ? station.name : '未知站'} · ${building.name}（${building.heatMode}）`,
        value: building.id
      }
    })
)

function openCreate(): void {
  editingId = null
  dialogTitle.value = '登记阀门'
  const fallback = buildingOptions.value[0]?.value ?? ''
  Object.assign(form, { ...EMPTY_VALVE_DRAFT, buildingId: fallback })
  dialogVisible.value = true
}

function openEdit(row: ValveEnriched): void {
  editingId = row.valve.id
  dialogTitle.value = `编辑阀门 · ${row.valve.code}`
  Object.assign(form, {
    buildingId: row.valve.buildingId,
    code: row.valve.code,
    dn: row.valve.dn,
    currentOpening: row.valve.currentOpening,
    designFlowM3h: row.valve.designFlowM3h,
    position: row.valve.position
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  try {
    const result = await formRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingId) {
    await valveStore.updateValve(editingId, { ...form })
    MessagePlugin.success('阀门参数已更新')
  } else {
    await valveStore.createValve({ ...form })
    MessagePlugin.success('阀门已登记')
  }
  dialogVisible.value = false
}

function remove(valve: Valve): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: `删除阀门「${valve.code}」将同时删除其实测记录与调节单，确认删除？`,
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await valveStore.removeValve(valve.id)
      MessagePlugin.success('阀门及其下游数据已删除')
      dialog.destroy()
    }
  })
}

async function commitAll(): Promise<void> {
  const count = await valveStore.bulkCommitOpenings()
  if (count === 0) {
    MessagePlugin.warning('没有待提交的开度草稿')
    return
  }
  MessagePlugin.success(`已提交 ${count} 只阀门的开度`)
}

function onOnlyImbalancedChange(value: unknown): void {
  valveStore.patchFilter({ onlyImbalanced: value === true })
}

async function commitOne(row: ValveEnriched): Promise<void> {
  await valveStore.commitOpeningDraft(row.valve.id)
  MessagePlugin.success(`${row.valve.code} 开度已保存`)
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">阀位与设计参数登记</h2>
        <p class="page-head__desc">
          登记口径、位置、当前开度与设计流量；开度修改先进入草稿，确认后批量或逐条提交。
        </p>
      </div>
      <div class="page-head__actions">
        <t-button variant="outline" :disabled="Object.keys(valveStore.openingDraft).length === 0" @click="commitAll">
          提交开度草稿（{{ Object.keys(valveStore.openingDraft).length }}）
        </t-button>
        <t-button theme="primary" :disabled="buildingOptions.length === 0" @click="openCreate">登记阀门</t-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="阀门总数" :value="valveStore.valves.length" suffix="只" tone="primary" />
      <StatBadge label="平均开度" :value="valveStore.averageOpening.toFixed(1)" suffix="%" tone="info" />
      <StatBadge label="设计流量合计" :value="valveStore.totalDesignFlow.toFixed(0)" suffix="m³/h" tone="default" />
      <StatBadge
        label="失衡阀门"
        :value="rank.summary.value.total - rank.summary.value.balanced"
        :percent="rank.summary.value.severePercent"
        suffix="只"
        tone="danger"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索阀门编号 / 楼栋 / 换热站"
      switch-label="仅看失衡"
      :switch-value="valveStore.filter.onlyImbalanced"
      has-switch
      @change="onFilterChange"
      @update:switch-value="onOnlyImbalancedChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">阀门清单（{{ filteredRows.length }} / {{ valveStore.valves.length }}）</h3>
        <span class="muted">失衡判定基于各阀门最新一次实测流量与室温</span>
      </div>

      <EmptyPanel
        v-if="filteredRows.length === 0"
        title="没有匹配的阀门"
        description="先到换热站台账登记楼栋，再登记阀门口径与设计流量。"
        action-text="登记阀门"
        secondary-text="重置筛选"
        compact
        @action="openCreate"
        @secondary="valveStore.resetFilter()"
      />

      <t-table
        v-else
        :data="filteredRows"
        :columns="columns"
        :row-key="valveRowKey"
        bordered
        stripe
        size="small"
      >
        <template #codeCell="{ row }">
          <strong>{{ row.valve.code }}</strong>
        </template>
        <template #whereCell="{ row }">
          {{ row.station ? row.station.name : '—' }} / {{ row.building ? row.building.name : '—' }}
        </template>
        <template #dnCell="{ row }">DN{{ row.valve.dn }}</template>
        <template #designCell="{ row }">{{ row.valve.designFlowM3h.toFixed(1) }} m³/h</template>
        <template #openingCell="{ row }">
          <div class="toolbar">
            <t-input-number
              :value="valveStore.openingDraft[row.valve.id] ?? row.valve.currentOpening"
              :min="0"
              :max="100"
              :step="5"
              style="width: 104px"
              @change="valveStore.setOpeningDraft(row.valve.id, Number($event))"
            />
            <t-button
              size="small"
              variant="text"
              theme="primary"
              :disabled="valveStore.openingDraft[row.valve.id] === undefined"
              @click="commitOne(row)"
            >
              保存
            </t-button>
          </div>
        </template>
        <template #balanceCell="{ row }">
          <BalanceTag
            v-if="rank.rowOf(row.valve.id)?.latest"
            :level="rank.rowOf(row.valve.id)!.level"
            :imbalance="rank.rowOf(row.valve.id)!.imbalanceValue"
            size="small"
          />
          <span v-else class="muted">无实测</span>
        </template>
        <template #checkCell="{ row }">
          <span class="muted">{{ row.openingCheck }}</span>
        </template>
        <template #opCell="{ row }">
          <div class="toolbar">
            <t-button size="small" variant="text" theme="primary" @click="openEdit(row)">编辑</t-button>
            <t-button size="small" variant="text" theme="danger" @click="remove(row.valve)">删除</t-button>
          </div>
        </template>
      </t-table>
    </div>

    <t-dialog
      v-model:visible="dialogVisible"
      :header="dialogTitle"
      width="560px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submit"
    >
      <t-form ref="formRef" :data="form" :rules="rules" label-width="128px">
        <t-form-item label="所属楼栋" name="buildingId">
          <t-select v-model="form.buildingId" :options="buildingOptions" filterable placeholder="选择楼栋" />
        </t-form-item>
        <t-form-item label="阀门编号" name="code">
          <t-input v-model="form.code" placeholder="如 BL-3-01" />
        </t-form-item>
        <t-form-item label="口径 DN" name="dn">
          <t-input-number v-model="form.dn" :min="15" :step="5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="位置" name="position">
          <t-radio-group v-model="form.position" variant="default-filled">
            <t-radio-button v-for="item in VALVE_POSITIONS" :key="item" :value="item">{{ item }}</t-radio-button>
          </t-radio-group>
        </t-form-item>
        <t-form-item label="当前开度(%)" name="currentOpening">
          <t-input-number v-model="form.currentOpening" :min="0" :max="100" :step="5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="设计流量(m³/h)" name="designFlowM3h">
          <t-input-number v-model="form.designFlowM3h" :min="0" :step="1" style="width: 100%" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>
