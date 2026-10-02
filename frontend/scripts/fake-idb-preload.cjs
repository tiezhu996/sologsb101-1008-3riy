// 测试预加载：在任何应用模块（db.ts 会立即 new Dexie）之前注入 IndexedDB 全局
const fake = require('fake-indexeddb')
globalThis.indexedDB = fake.indexedDB
globalThis.IDBKeyRange = fake.IDBKeyRange
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v))
}
