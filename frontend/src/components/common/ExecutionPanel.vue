<script setup lang="ts">
/**
 * 执行批次协作面板（调节单页使用）
 * - 选择本班次，把待下发调节单先认领进执行批次，页面拿到租约后逐张执行；
 * - 展示当前批次进度、租约剩余与心跳状态；可暂停释放租约；
 * - 租约失效/中断的批次可由另一页「接管续跑」，从最后完成项之后继续；
 * - 下方列出历史/已完成批次，刷新与交接时核对最终执行结果。
 */
import { computed } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { useBatchStore } from '@/stores/batchStore'
import { SHIFT_NAMES, type ExecutionBatch, type ShiftName } from '@/types/executionBatch'
import { formatClock, formatDateTime, leaseRemainingSeconds } from '@/utils/datetime'

const batchStore = useBatchStore()

const shifts = SHIFT_NAMES.map((item) => ({ label: item, value: item }))

const claimableCount = computed(() => batchStore.claimableAdjusts.length)

const recentBatches = computed(() => batchStore.batches.slice(0, 6))

const leaseRemaining = computed(() => {
  const batch = batchStore.runningBatch
  if (!batch) return 0
  return leaseRemainingSeconds(batch.leaseExpiresAt, batchStore.nowTick)
})

const progressPercent = computed(() => {
  const batch = batchStore.runningBatch
  return batch ? batchStore.progressOf(batch).percent : 0
})

const progressText = computed(() => {
  const batch = batchStore.runningBatch
  if (!batch) return ''
  const { done, total } = batchStore.progressOf(batch)
  return `${done} / ${total} 张`
})

function onShiftChange(value: ShiftName): void {
  batchStore.setShift(value)
}

async function claimAll(): Promise<void> {
  const result = await batchStore.claimAndRun()
  if (result.status === 'completed' && result.batch) {
    MessagePlugin.success(`已认领 ${result.batch.totalCount} 张并开始逐张执行`)
  } else if (result.message) {
    MessagePlugin.warning(result.message)
  }
}

async function pauseRun(): Promise<void> {
  await batchStore.pause()
  MessagePlugin.info('已暂停并释放租约，另一页可从最后完成项接管续跑')
}

async function takeover(batch: ExecutionBatch): Promise<void> {
  const result = await batchStore.takeOver(batch.id)
  if (result.status === 'completed' && result.batch) {
    MessagePlugin.success(`已接管「${batch.name}」，从第 ${(result.batch.completedSeq ?? 0) + 1} 张继续执行`)
  } else if (result.message) {
    MessagePlugin.warning(result.message)
  }
}

function statusTag(batch: ExecutionBatch): { text: string; theme: 'success' | 'warning' | 'primary' | 'default' } {
  if (batch.kind === 'history') return { text: '历史批次', theme: 'default' }
  if (batch.status === 'completed') return { text: '已完成', theme: 'success' }
  if (batch.status === 'interrupted') return { text: '待接管', theme: 'warning' }
  if (batchStore.takeoverEligible(batch)) return { text: '租约失效', theme: 'warning' }
  return { text: '执行中', theme: 'primary' }
}
</script>

<template>
  <div class="panel batch-panel">
    <div class="panel-head batch-panel__head">
      <h3 class="panel-title" style="margin: 0">执行批次协作（白班 / 夜班换班交接）</h3>
      <div class="toolbar">
        <span class="muted">本页班次</span>
        <t-radio-group
          :model-value="batchStore.ownerShift"
          variant="default-filled"
          size="small"
          @change="onShiftChange"
        >
          <t-radio-button v-for="item in shifts" :key="item.value" :value="item.value">{{ item.label }}</t-radio-button>
        </t-radio-group>
        <t-button
          theme="primary"
          size="small"
          :disabled="batchStore.busy || claimableCount === 0"
          @click="claimAll"
        >
          认领全部待下发单（{{ claimableCount }}）并执行
        </t-button>
        <t-button
          v-if="batchStore.runningBatch"
          theme="warning"
          size="small"
          :disabled="!batchStore.busy"
          @click="pauseRun"
        >
          暂停 / 释放租约
        </t-button>
      </div>
    </div>

    <p v-if="batchStore.lastError" class="batch-panel__error">{{ batchStore.lastError }}</p>

    <!-- 当前持约批次 -->
    <div v-if="batchStore.runningBatch" class="batch-active">
      <div class="batch-active__title">
        <t-tag size="small" theme="primary" variant="light">
          {{ batchStore.isLeaseHeld ? '本页持约执行中' : '租约已失效' }}
        </t-tag>
        <strong>{{ batchStore.runningBatch.name }}</strong>
        <span class="muted">
          最后完成项：第 {{ batchStore.runningBatch.completedSeq }} 张 · 租约剩余
          <span :class="{ 'batch-panel__expired': leaseRemaining <= 0 }">{{ leaseRemaining }}s</span>
          · 心跳 {{ formatClock(batchStore.runningBatch.lastHeartbeatAt) }}
        </span>
      </div>
      <t-progress :percentage="progressPercent" :label="progressText" size="small" />
      <p class="muted" style="margin: 6px 0 0">{{ batchStore.runningBatch.note }}</p>
    </div>

    <!-- 批次交接列表 -->
    <table class="batch-table">
      <thead>
        <tr>
          <th>执行批次</th>
          <th style="width: 110px">状态</th>
          <th style="width: 130px">进度</th>
          <th style="width: 150px">持约班次 / 租约</th>
          <th style="width: 170px">认领 / 完成时间</th>
          <th style="width: 110px">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in recentBatches" :key="batch.id">
          <td>
            <strong>{{ batch.name }}</strong>
            <div class="muted">{{ batch.note }}</div>
          </td>
          <td>
            <t-tag size="small" variant="light" :theme="statusTag(batch).theme">{{ statusTag(batch).text }}</t-tag>
          </td>
          <td>
            {{ batchStore.progressOf(batch).done }} / {{ batchStore.progressOf(batch).total }} 张
            （{{ batchStore.progressOf(batch).percent }}%）
          </td>
          <td>
            <template v-if="batch.kind === 'normal' && batch.status !== 'completed'">
              {{ batch.ownerShift || '—' }}
              <span v-if="batch.ownerId" class="muted">
                · {{ batchStore.takeoverEligible(batch) ? '已失效' : `剩 ${leaseRemainingSeconds(batch.leaseExpiresAt, batchStore.nowTick)}s` }}
              </span>
              <div v-if="batch.ownerId" class="muted">v{{ batch.leaseVersion }}</div>
            </template>
            <span v-else class="muted">—</span>
          </td>
          <td>
            <div>{{ formatDateTime(batch.claimedAt) }}</div>
            <div class="muted">{{ batch.finishedAt ? formatDateTime(batch.finishedAt) : '未完成' }}</div>
          </td>
          <td>
            <t-button
              v-if="batch.kind === 'normal' && batch.status !== 'completed'"
              size="small"
              variant="text"
              theme="primary"
              :disabled="!batchStore.takeoverEligible(batch) || batchStore.busy"
              @click="takeover(batch)"
            >
              接管续跑
            </t-button>
            <span v-else class="muted">—</span>
          </td>
        </tr>
        <tr v-if="recentBatches.length === 0">
          <td colspan="6" class="muted" style="text-align: center; padding: 12px">
            还没有执行批次，点击上方按钮认领待下发调节单开始执行
          </td>
        </tr>
      </tbody>
    </table>

    <p class="muted" style="margin: 8px 0 0">
      协作规则：待下发单先认领进批次，持约页逐张执行；每张执行记录与阀门开度在同一事务保存，已完成项不会被另一页重复处理；租约失效或写入失败后，另一页可从最后完成项接管续跑。
    </p>
  </div>
</template>

<style scoped>
.batch-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.batch-panel__error {
  margin: 8px 0;
  padding: 6px 10px;
  background: #fdecea;
  color: #c0392b;
  border-radius: 4px;
  font-size: 13px;
}

.batch-panel__expired {
  color: #c0392b;
  font-weight: 600;
}

.batch-active {
  margin: 12px 0;
  padding: 12px;
  border: 1px solid #d9e6f5;
  border-radius: 6px;
  background: #f5f9ff;
}

.batch-active__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.batch-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
  font-size: 13px;
}

.batch-table th,
.batch-table td {
  border: 1px solid #e7e7e7;
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}

.batch-table th {
  background: #fafafa;
  font-weight: 600;
}
</style>
