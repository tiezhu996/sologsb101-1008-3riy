/**
 * 路由表：/stations、/valves、/measures、/balance、/adjusts
 * 页面按路由懒加载，构建时自动分包。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/stations' },
  {
    path: '/stations',
    name: 'station-list',
    component: () => import('@/pages/StationList.vue'),
    meta: { title: '换热站与楼栋台账' }
  },
  {
    path: '/valves',
    name: 'valve-list',
    component: () => import('@/pages/ValveList.vue'),
    meta: { title: '阀位与设计参数登记' }
  },
  {
    path: '/measures',
    name: 'measure-entry',
    component: () => import('@/pages/MeasureEntry.vue'),
    meta: { title: '实测流量与供回水温录入' }
  },
  {
    path: '/balance',
    name: 'balance-board',
    component: () => import('@/pages/BalanceBoard.vue'),
    meta: { title: '失衡度计算与排序' }
  },
  {
    path: '/adjusts',
    name: 'adjust-order',
    component: () => import('@/pages/AdjustOrder.vue'),
    meta: { title: '调节单下发与复核' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/stations' }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '供热管网水力平衡调节台'
  document.title = `${title} · 供热管网水力平衡调节台`
})

export default router
