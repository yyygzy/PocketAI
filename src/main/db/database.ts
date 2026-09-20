// 数据库服务：SQLite3MultipleCiphers + 版本化迁移
//
// 加密级别（EncryptionMode）：
//   'none'  → 无密码，better-sqlite3-multiple-ciphers 不启用加密
//   'db'    → 库级加密，PRAGMA key 打开（AES-256-GCM）
//   'field' → 字段级加密（Provider apiKeys 等敏感列 AES-256-GCM 单独加解密）
//
// 明文→加密迁移流程：
//   1. 打开明文库 → 切 DELETE journal_mode → PRAGMA rekey = '<password>'
//   2. 关闭 → 再打开时先 PRAGMA key = '<password>' 再开 WAL
//   3. 密码轮换：PRAGMA key 旧密码 → PRAGMA rekey 新密码
//
import Database from 'better-sqlite3-multiple-ciphers'
import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH, DATA_DIR } from '../portable'

export type Migration = {
  version: number
  name: string
  up: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    up: `
      CREATE TABLE IF NOT EXISTS assistants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        avatar TEXT,
        system_prompt TEXT,
        default_provider_id TEXT,
        default_model TEXT,
        default_params TEXT,
        tool_permissions TEXT,
        skill_ids TEXT,
        welcome_message TEXT,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        assistant_id TEXT,
        title TEXT,
        model TEXT,
        params TEXT,
        status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        provider TEXT,
        model TEXT,
        status TEXT,
        parent_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT,
        api_key_encrypted TEXT,
        models TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'provider_enabled',
    up: `
      ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
    `
  },
  {
    version: 3,
    name: 'knowledge_base',
    up: `
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        embedding_provider_id TEXT,
        embedding_model TEXT,
        embedding_dim INTEGER,
        chunk_size INTEGER NOT NULL DEFAULT 800,
        chunk_overlap INTEGER NOT NULL DEFAULT 200,
        top_k INTEGER NOT NULL DEFAULT 20,
        top_n INTEGER NOT NULL DEFAULT 5,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL,
        source TEXT,
        source_type TEXT,
        title TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        kb_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE,
        FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);
      CREATE INDEX IF NOT EXISTS idx_kb_docs_kb ON kb_documents(kb_id);

      ALTER TABLE assistants ADD COLUMN knowledge_base_ids TEXT;
    `
  },
  {
    version: 4,
    name: 'mcp_servers',
    up: `
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT 'stdio',
        command TEXT,
        args TEXT,
        env TEXT,
        url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 5,
    name: 'license_and_encryption',
    up: `
      CREATE TABLE IF NOT EXISTS license_records (
        id TEXT PRIMARY KEY,
        license_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        plan TEXT NOT NULL,
        features TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        installed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS field_keys (
        id TEXT PRIMARY KEY,
        target_table TEXT NOT NULL,
        target_column TEXT NOT NULL,
        salt BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      ALTER TABLE providers ADD COLUMN api_key_cipher TEXT;
    `
  },
  {
    version: 6,
    name: 'messages_fts5_search',
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        conversation_id,
        message_id,
        tokenize='trigram'
      );

      -- 回填历史消息
      INSERT INTO messages_fts(content, conversation_id, message_id)
        SELECT content, conversation_id, id FROM messages WHERE content IS NOT NULL;

      -- 新增消息（status=done 时可能带最终 content）
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(content, conversation_id, message_id)
          VALUES (new.content, new.conversation_id, new.id);
      END;

      -- 更新消息内容（只在流式完成后同步 FTS5，避免 chunk 刷屏）
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content, status ON messages
        WHEN new.status = 'done' BEGIN
        DELETE FROM messages_fts WHERE message_id = new.id;
        INSERT INTO messages_fts(content, conversation_id, message_id)
          VALUES (new.content, new.conversation_id, new.id);
      END;

      -- 删除消息
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END;
    `
  },
  {
    version: 7,
    name: 'messages_fts5_trigram_fix',
    up: `
      -- 旧 v6 用了默认 tokenizer 或无 trigram，这里 drop + recreate
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TABLE IF EXISTS messages_fts;

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        conversation_id,
        message_id,
        tokenize='trigram'
      );

      INSERT INTO messages_fts(content, conversation_id, message_id)
        SELECT content, conversation_id, id FROM messages WHERE content IS NOT NULL;

      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(content, conversation_id, message_id)
          VALUES (new.content, new.conversation_id, new.id);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE OF content, status ON messages
        WHEN new.status = 'done' BEGIN
        DELETE FROM messages_fts WHERE message_id = new.id;
        INSERT INTO messages_fts(content, conversation_id, message_id)
          VALUES (new.content, new.conversation_id, new.id);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END;
    `
  },
  {
    version: 8,
    name: 'skills',
    up: `
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT,
        content TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 9,
    name: 'messages_tool_calls',
    up: `
      ALTER TABLE messages ADD COLUMN tool_calls TEXT;
    `
  },
  {
    version: 10,
    name: 'messages_attachments',
    up: `
      ALTER TABLE messages ADD COLUMN attachments TEXT;
    `
  },
  {
    // v11: V2 批次一——笔记模块 + MCP 运行时类型
    version: 11,
    name: 'notes_and_mcp_runtime',
    up: `
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);
      ALTER TABLE mcp_servers ADD COLUMN runtime TEXT NOT NULL DEFAULT 'binary';
    `
  },
  {
    // v12: V2 批次二——翻译模块（翻译历史 + 术语表）
    version: 12,
    name: 'translation_tables',
    up: `
      CREATE TABLE IF NOT EXISTS translations (
        id TEXT PRIMARY KEY,
        source_text TEXT NOT NULL DEFAULT '',
        target_text TEXT NOT NULL DEFAULT '',
        source_lang TEXT NOT NULL DEFAULT 'auto',
        target_lang TEXT NOT NULL DEFAULT 'en',
        style TEXT NOT NULL DEFAULT 'standard',
        provider_id TEXT NOT NULL DEFAULT '',
        provider_name TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_translations_created_at ON translations(created_at DESC);
      CREATE TABLE IF NOT EXISTS translation_glossary (
        id TEXT PRIMARY KEY,
        source_term TEXT NOT NULL,
        target_term TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `
  },
  {
    // v13: V2 批次四——绘图模块（生成图片历史；图片文件存 data/images/，DB 只存相对路径）
    version: 13,
    name: 'images_table',
    up: `
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        provider_id TEXT NOT NULL DEFAULT '',
        provider_name TEXT NOT NULL DEFAULT '',
        size TEXT NOT NULL DEFAULT '1024x1024',
        file_name TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at DESC);
    `
  },
  {
    // v14: V2 批次八——沙箱基础层（HTML 产物元数据；文件本体存 data/sandbox/）
    version: 14,
    name: 'sandbox_files_table',
    up: `
      CREATE TABLE IF NOT EXISTS sandbox_files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sandbox_files_created_at ON sandbox_files(created_at DESC);
    `
  },
  {
    // v15: V2 批次九——迷你应用元数据（icon/description/is_app）
    version: 15,
    name: 'sandbox_files_app_meta',
    up: `
      ALTER TABLE sandbox_files ADD COLUMN icon TEXT NOT NULL DEFAULT '📦';
      ALTER TABLE sandbox_files ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE sandbox_files ADD COLUMN is_app INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    // v16: V2——Python 系 MCP：每 Server 的 pip 依赖列表（配合独立 venv）
    version: 16,
    name: 'mcp_server_python_packages',
    up: `
      ALTER TABLE mcp_servers ADD COLUMN python_packages TEXT NOT NULL DEFAULT '[]';
    `
  }
]

/** 代码内最新迁移版本（诊断模块用来判断库结构是否落后） */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export type EncryptionMode = 'none' | 'db'

export class DatabaseService {
  private db: Database.Database | null = null
  private encryptionMode: EncryptionMode = 'none'

  /**
   * 打开数据库。
   * - masterKey 为空 / 未提供：无密码模式（不启用加密，兼容现有明文库）
   * - masterKey 提供：库级加密模式（SQLite3MultipleCiphers AES-256-GCM）
   */
  open(masterKey?: Buffer): void {
    if (this.db) return

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }

    const encrypted = Boolean(masterKey)
    this.encryptionMode = encrypted ? 'db' : 'none'

    this.db = new Database(DB_PATH)
    this.db.pragma('cipher = sqlcipher')
    this.db.pragma('legacy = 0')

    if (encrypted && masterKey) {
      const hex = masterKey.toString('hex')
      this.db.pragma(`key = "x'${hex}'"`)
    }

    // WAL 在加密/无加密模式下都可用
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  /** 对现有明文数据库启用加密（迁移流程） */
  enableEncryption(masterKey: Buffer): void {
    if (!this.db) throw new Error('Database not opened')
    if (this.encryptionMode === 'db') throw new Error('Database already encrypted')

    // rekey 必须在 DELETE journal_mode 下
    this.db.pragma('journal_mode = DELETE')
    const hex = masterKey.toString('hex')
    this.db.pragma(`rekey = "x'${hex}'"`)
    this.encryptionMode = 'db'

    // 重新打开以确保加密生效
    this.db.close()
    this.db = null
    this.open(masterKey)
  }

  /** 从加密库移除加密（迁移流程） */
  disableEncryption(masterKey: Buffer): void {
    if (!this.db) throw new Error('Database not opened')
    if (this.encryptionMode !== 'db') throw new Error('Database is not encrypted')

    // 先验证密码
    this.db.pragma('journal_mode = DELETE')
    const hex = masterKey.toString('hex')
    this.db.pragma(`key = "x'${hex}'"`)
    // 用空密码 rekey = 去掉加密（SQLite3MultipleCiphers 特有）
    this.db.pragma("rekey = ''")
    this.encryptionMode = 'none'

    this.db.close()
    this.db = null
    this.open()
  }

  /** 获取当前加密模式 */
  getEncryptionMode(): EncryptionMode {
    return this.encryptionMode
  }

  runMigrations(): void {
    if (!this.db) throw new Error('Database not opened')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `)

    const applied = new Set(
      this.db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((r: any) => r.version as number)
    )

    const now = Date.now()
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue
      const tx = this.db.transaction(() => {
        this.db!.exec(m.up)
        this.db!
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, now)
      })
      tx()
    }
  }

  integrityCheck(): { ok: boolean; details: string } {
    if (!this.db) return { ok: false, details: 'Database not opened' }
    try {
      const row = this.db.pragma('integrity_check', { simple: true }) as any
      const result = Array.isArray(row) ? row[0]?.integrity_check : row
      return { ok: result === 'ok', details: String(result) }
    } catch (e: any) {
      return { ok: false, details: e.message }
    }
  }

  getHandle(): Database.Database {
    if (!this.db) throw new Error('Database not opened')
    return this.db
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

export const dbService = new DatabaseService()
