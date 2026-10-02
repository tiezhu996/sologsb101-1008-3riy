import { createApp } from 'vue'
import { createPinia } from 'pinia'
import TDesign from 'tdesign-vue-next'
import 'tdesign-vue-next/es/style/index.css'
import App from '@/App.vue'
import router from '@/router'
import { initDatabase, stampDbVersion } from '@/utils/db'
import '@/styles/main.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(TDesign)

stampDbVersion()

// 首屏先完成 IndexedDB 打开与演示数据播种，再挂载应用，避免列表页空窗
void initDatabase()
  .catch((error: unknown) => {
    console.error('本地数据库初始化失败', error)
  })
  .finally(() => {
    app.mount('#app')
  })
