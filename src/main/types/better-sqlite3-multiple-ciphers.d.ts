// better-sqlite3-multiple-ciphers v13 的 package.json exports 未映射 types 入口
// （types 在根 index.d.ts，但 exports["."] 仅指向 ./lib/index.js），
// moduleResolution: Bundler 下 TS 无法解析，这里用 ambient 声明复用 better-sqlite3 的类型。
// API 与 better-sqlite3 完全一致，仅多出加密 PRAGMA 支持。
declare module 'better-sqlite3-multiple-ciphers' {
  import Database = require('better-sqlite3')
  export = Database
}
