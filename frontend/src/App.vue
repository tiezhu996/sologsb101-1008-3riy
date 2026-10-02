<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useStationStore } from '@/stores/stationStore'
import { useValveStore } from '@/stores/valveStore'
import { useAdjustStore } from '@/stores/adjustStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const valveStore = useValveStore()
const adjustStore = useAdjustStore()
const rank = useImbalanceRank()

const navItems = computed(() => [
  { path: '/stations', label: '换热站台账', badge: String(stationStore.stations.length) },
  { path: '/valves', label: '阀位登记', badge: String(valveStore.valves.length) },
  { path: '/measures', label: '实测录入', badge: String(rank.measureTable.rows.value.length) },
  { path: '/balance', label: '失衡度计算', badge: String(rank.summary.value.severe) },
  { path: '/adjusts', label: '调节单', badge: String(adjustStore.stateCounts['待下发']) }
])

const activePath = computed(() => {
  const matched = navItems.value.find((item) => route.path.startsWith(item.path))
  return matched ? matched.path : '/stations'
})

function go(path: string): void {
  void router.push(path)
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header__brand">
        <span class="app-header__mark">热</span>
        <div>
          <h1 class="app-header__title">供热管网水力平衡调节台</h1>
          <p class="app-header__sub">换热站 · 楼栋 · 阀门 · 实测流量 · 失衡度 · 调节单</p>
        </div>
      </div>
      <nav class="app-nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          class="app-nav__item"
          :class="{ 'is-active': activePath === item.path }"
          type="button"
          @click="go(item.path)"
        >
          <span>{{ item.label }}</span>
          <em v-if="item.badge" class="app-nav__badge">{{ item.badge }}</em>
        </button>
      </nav>
    </header>

    <main class="app-main">
      <router-view />
    </main>

    <footer class="app-footer">
      <span>数据仅存于本浏览器（IndexedDB / localStorage），不上传任何服务器。</span>
      <span>
        当前换热站：{{ stationStore.currentStation ? stationStore.currentStation.name : '未选择' }} ·
        严重失衡 {{ rank.summary.value.severe }} 只 / 共 {{ valveStore.valves.length }} 只
      </span>
    </footer>
  </div>
</template>
