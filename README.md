# 供热管网水力平衡调节台（sologsb101-1008）

面向供热公司运行调度与二次网平衡调节班组，按换热站—楼栋—单元三级登记阀门开度与设计流量，用实测流量与室温反馈计算失衡度并下发调节单。核心动作：建站与楼栋、登记阀位与设计参数、录入实测流量与供回水温、算失衡度排序、下发调节单并复核。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22808**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5 | `<script setup>` + Composition API |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `vue-tsc --noEmit` |
| UI 组件 | TDesign Vue Next 1.20 | 表格、表单、Dialog、Tag、Descriptions、Progress |
| 状态管理 | Pinia 2.3 | `stationStore` / `valveStore` / `adjustStore` |
| 路由 | Vue Router 4.5 | History 模式，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1008/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbheatgrid
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts building.ts valve.ts measure.ts adjust.ts executionBatch.ts
        ├── stores/             # stationStore.ts valveStore.ts adjustStore.ts
        ├── components/common/  # BalanceTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useImbalanceRank.ts useIdbTable.ts useExecutionBatches.ts
        ├── pages/              # StationList.vue ValveList.vue MeasureEntry.vue BalanceBoard.vue AdjustOrder.vue
        ├── router/index.ts
        ├── utils/              # balance.ts db.ts export.ts batches.ts batchEvents.ts session.ts
        ├── scripts/            # verify-batches.ts 执行批次逻辑验证（不参与构建）
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 换热站与楼栋台账 | Station、Building | 新建/编辑/删除换热站与楼栋；按供热方式与面积区间筛选；卡片回显失衡楼栋数与待复核单数 |
| `/valves` | 阀位与设计参数登记 | Valve、Building | 登记口径/位置/开度/设计流量；开度改动进入草稿后可逐条或批量提交；失衡标签与开度校核 |
| `/measures` | 实测流量/供回水温录入 | Measure、Valve | 按日期成组录入流量与三温；支持「阀门编号,日期,流量,供温,回温,室温,录入人」批量粘贴导入并即时预览失衡度 |
| `/balance` | 失衡度计算与排序 | Valve、Measure | 按失衡度降序排行；仅看失衡；导出失衡度 CSV；单条/一键生成调节单 |
| `/adjusts` | 调节单下发与复核 | Adjust、Valve、Measure、ExecutionBatch | 待下发先认领进**执行批次**（租约 + 心跳续约），持约页逐张执行，执行记录与阀门开度同事务落库；换班租约失效后另一页从最后完成项接管恢复；导出调节单 CSV 与全量 JSON |

## 五、数据存储说明

- **IndexedDB 库名**：`gbheatgrid`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`buildings`、`valves`、`measures`、`adjusts`、`executionBatches`、`executionItems`
- **数据结构版本**：`DB_VERSION = 3`
  - `version(1) → version(2)`：补齐 `revision`、用所属楼栋回填阀门 `stationId` 冗余列、规整开度与复核字段
  - `version(3)`：新增「执行批次 / 执行项」协作表（租约 `leaseOwner`+`leaseUntil`、完成水位 `lastCompletedSeq` 等），调节单补 `batchId` 归属列
- **换班执行协作（执行批次）**：
  - 待下发调节单先「认领进批次」，认领在单个 Dexie 事务内回填 `adjust.batchId`，天然去重，另一页无法重复认领
  - 批次持有**租约**（TTL 30s，执行期间每 10s 心跳续约）；租约内不可抢占，失效或主动暂停后另一页可接管
  - 持约页**逐张执行**：执行记录（最终开度/执行人/时间/结果）与阀门开度、调节单状态在**同一事务**提交；已完成项幂等跳过，杜绝重复记录与开度对不上
  - 租约失效 / 写入失败后，接管方按 `lastCompletedSeq` **从最后完成项之后恢复**，阀门缺失等业务失败项可重试
  - 旧的「已调节 / 已复核」调节单首次进入调节单页时**幂等补成一张历史批次**；页面刷新（liveQuery 跨标签 + BroadcastChannel）与 CSV/JSON 导出一律按**最终执行开度**展示
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座换热站 → 5 栋楼 → 10 只阀门 → 20 条实测 → 4 张调节单的互相引用数据；播种幂等
- **localStorage 辅助键**：`gbheatgrid:db-version`、`gbheatgrid:last-backup-at`、`gbheatgrid:ui-prefs`（上次选中换热站、仅看失衡开关）、`gbheatgrid:shift-tag`（当前班次；页签实例标识另存 sessionStorage）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22808
npm run build      # vue-tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
npm run verify:batches   # 用 fake-indexeddb 验证执行批次认领/租约/接管恢复/历史补录（28 项断言）
```

## 七、判定口径

- 流量比 `= 实测流量 ÷ 设计流量`；流量偏差率 `= (流量比 − 1) × 100%`
- 室温偏差 `= 室温 − 20℃`
- 合成失衡度 `= |流量偏差率| × 0.7 + |室温偏差| × 1.5`（单位 %）
- 判级：`≤ 10%` 平衡，`10% ~ 25%` 偏大 / 偏小（按流量方向），`> 25%` 严重失衡
- 目标开度建议 `= 当前开度 ÷ 流量比`，按 5% 取整并限制在 20% ~ 100%
