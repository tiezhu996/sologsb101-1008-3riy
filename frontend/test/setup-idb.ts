/** 测试环境：先于任何 Dexie 模块导入初始化内存版 IndexedDB */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
;(globalThis as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange

export {}
