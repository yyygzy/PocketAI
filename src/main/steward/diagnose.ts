// 平台管家 · 安全检测（audit）与故障诊断（diagnose）
//
// audit：偏安全姿态 —— 加密 / 锁屏 / 备份新鲜度 / DB 完整性 / 便携物理风险，输出 0-100 评分
// diagnose：偏可运行性 —— 完整性 / 孤儿数据 / 迁移版本 / 目录可写 / 磁盘空间 / Provider 配置
//
// 所有探测逐项 try/catch：单项失败不影响整份报告。

import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AuditResult,
  DiagnoseResult,
  SecurityCheck,
  DiagnoseItem,
  CheckLevel
} from '../../shared/types'
import { dbService, LATEST_SCHEMA_VERSION } from '../db/database'
import { masterKeyManager } from '../crypto/master-key'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { providerRepo } from '../db/repositories/provider.repo'
import { loadWebDAVConfig } from '../backup/backup-service'
import { getBackupSchedule } from '../backup/backup-scheduler'
import { getHardwareInfo } from './hardware'
import { DATA_DIR, DB_PATH } from '../portable'

const DAY_MS = 24 * 3600 * 1000

function levelScore(level: CheckLevel): number {
  if (level === 'danger') return 30
  if (level === 'warn') return 10
  return 0
}

function scoreOf(checks: SecurityCheck[]): number {
  const deduct = checks.reduce((sum, c) => sum + levelScore(c.level), 0)
  return Math.max(0, 100 - deduct)
}

// ─── 安全检测 ────────────────────────────────────────────────────

export function runAudit(): AuditResult {
  const checks: SecurityCheck[] = []
  const dbMode = masterKeyManager.getMode()
  const unlocked = masterKeyManager.hasKey()

  // 1. 数据库加密
  if (dbMode === 'db') {
    checks.push({
      id: 'db-encryption',
      label: '数据库加密',
      level: 'ok',
      detail: '已启用主密码（SQLCipher AES-256 库级加密）'
    })
    // 2. 锁定状态
    checks.push({
      id: 'lock-state',
      label: '当前锁定状态',
      level: unlocked ? 'ok' : 'danger',
      detail: unlocked ? '数据库处于解锁状态，可正常使用' : '数据库当前已锁定',
      suggestion: unlocked ? undefined : '通过隐私锁解锁窗口输入主密码后再继续使用'
    })
    // 3. 自动锁屏
    const timeoutMs = appConfigRepo.getAutoLockTimeout()
    if (timeoutMs > 0) {
      checks.push({
        id: 'auto-lock',
        label: '自动锁屏',
        level: 'ok',
        detail: `闲置 ${Math.round(timeoutMs / 60000)} 分钟自动锁定`
      })
    } else {
      checks.push({
        id: 'auto-lock',
        label: '自动锁屏',
        level: 'warn',
        detail: '未开启自动锁屏，最小化或离开后数据一直可读',
        suggestion: '设置 → 隐私与加密 → 开启自动锁屏超时'
      })
    }
  } else {
    checks.push({
      id: 'db-encryption',
      label: '数据库加密',
      level: 'warn',
      detail: '数据库未加密：全部会话、知识库、配置以明文存储，拷贝数据文件即可读取',
      suggestion: '设置 → 隐私与加密 → 启用主密码（便携/U 盘场景强烈建议）'
    })
  }

  // 4. DB 完整性
  try {
    const row = dbService.getHandle().prepare('PRAGMA integrity_check').get() as { 'integrity_check': string }
    const ok = row['integrity_check'] === 'ok'
    checks.push({
      id: 'integrity',
      label: '数据库完整性',
      level: ok ? 'ok' : 'danger',
      detail: ok ? 'integrity_check = ok' : `检测到损坏：${row['integrity_check']}`,
      suggestion: ok ? undefined : '立即停止写入，从 WebDAV 或本地备份恢复'
    })
  } catch (e) {
    checks.push({
      id: 'integrity',
      label: '数据库完整性',
      level: 'danger',
      detail: `完整性检查执行失败：${(e as Error).message}`
    })
  }

  // 5. 备份姿态
  try {
    const cfg = loadWebDAVConfig()
    const schedule = getBackupSchedule()
    if (!cfg) {
      checks.push({
        id: 'backup-cloud',
        label: '云端备份',
        level: 'warn',
        detail: '未配置 WebDAV 云备份，设备损坏/丢失时数据无法找回',
        suggestion: '设置 → 备份 → 配置 WebDAV（坚果云 / Nextcloud 等）'
      })
    } else {
      checks.push({
        id: 'backup-cloud',
        label: '云端备份',
        level: schedule.enabled ? 'ok' : 'warn',
        detail: schedule.enabled
          ? `WebDAV 已配置，定时备份每 ${schedule.intervalHours} 小时执行`
          : 'WebDAV 已配置但定时备份未开启，仅手动备份',
        suggestion: schedule.enabled ? undefined : '设置 → 备份 → 勾选「启用定时自动备份」'
      })
      const lastOkAt = schedule.lastResult?.ok ? schedule.lastResult.at : null
      if (lastOkAt === null) {
        checks.push({
          id: 'backup-freshness',
          label: '备份新鲜度',
          level: 'warn',
          detail: '尚无成功的云端备份记录',
          suggestion: '设置 → 备份 → 立即上传一次备份'
        })
      } else {
        const days = (Date.now() - lastOkAt) / DAY_MS
        const level: CheckLevel = days <= 7 ? 'ok' : days <= 30 ? 'warn' : 'danger'
        checks.push({
          id: 'backup-freshness',
          label: '备份新鲜度',
          level,
          detail: `最近一次成功备份：${new Date(lastOkAt).toLocaleString()}（${days.toFixed(1)} 天前）`,
          suggestion: days > 30 ? '备份过旧，立即手动上传或缩短定时备份间隔' : undefined
        })
      }
    }
  } catch (e) {
    checks.push({
      id: 'backup-cloud',
      label: '云端备份',
      level: 'warn',
      detail: `备份配置读取失败：${(e as Error).message}`
    })
  }

  // 6. 便携介质物理风险
  try {
    const hw = getHardwareInfo()
    if (hw.disk.removable) {
      checks.push({
        id: 'portable-physical',
        label: '便携介质',
        level: 'warn',
        detail: '应用运行在可移动磁盘上，存在丢失/被拷贝的物理风险',
        suggestion: '务必启用主密码加密，并在不用时安全弹出设备'
      })
    }
  } catch { /* 硬件探测失败不阻塞检测 */ }

  return { score: scoreOf(checks), checks }
}

// ─── 故障诊断 ────────────────────────────────────────────────────

function safeItem(
  id: string,
  label: string,
  fn: () => Omit<DiagnoseItem, 'id' | 'label'>
): DiagnoseItem {
  try {
    return { id, label, ...fn() }
  } catch (e) {
    return { id, label, level: 'danger', detail: `检测异常：${(e as Error).message}` }
  }
}

export function runDiagnose(): DiagnoseResult {
  const items: DiagnoseItem[] = []

  // 1. 完整性
  items.push(safeItem('integrity', '数据库完整性', () => {
    const row = dbService.getHandle().prepare('PRAGMA integrity_check').get() as { 'integrity_check': string }
    const ok = row['integrity_check'] === 'ok'
    return {
      level: ok ? 'ok' : 'danger',
      detail: ok ? 'integrity_check = ok' : `检测到损坏：${row['integrity_check']}`,
      fix: ok ? undefined : '从 WebDAV 或本地备份恢复数据库'
    }
  }))

  // 2. 孤儿消息
  items.push(safeItem('orphan-messages', '孤儿消息', () => {
    const c = (dbService.getHandle().prepare(`
      SELECT COUNT(*) as c FROM messages m
      LEFT JOIN conversations c ON m.conversation_id = c.id
      WHERE c.id IS NULL
    `).get() as { c: number }).c
    return {
      level: c > 0 ? 'warn' : 'ok',
      detail: c > 0 ? `发现 ${c} 条不属于任何会话的孤儿消息` : '无孤儿消息',
      fix: c > 0 ? '点下方「安全清理」自动删除' : undefined
    }
  }))

  // 3. 孤儿向量块
  items.push(safeItem('orphan-chunks', '孤儿向量块', () => {
    const c = (dbService.getHandle().prepare(`
      SELECT COUNT(*) as c FROM kb_chunks kc
      LEFT JOIN kb_documents d ON kc.doc_id = d.id
      WHERE d.id IS NULL
    `).get() as { c: number }).c
    return {
      level: c > 0 ? 'warn' : 'ok',
      detail: c > 0 ? `发现 ${c} 个无主知识库向量块` : '无孤儿向量块',
      fix: c > 0 ? '点下方「安全清理」自动删除' : undefined
    }
  }))

  // 4. 迁移版本
  items.push(safeItem('schema-version', '数据库结构版本', () => {
    const row = dbService
      .getHandle()
      .prepare('SELECT MAX(version) as v FROM schema_migrations')
      .get() as { v: number | null }
    const current = row.v ?? 0
    const ok = current >= LATEST_SCHEMA_VERSION
    return {
      level: ok ? 'ok' : 'danger',
      detail: ok ? `v${current}（最新）` : `v${current}，代码要求 v${LATEST_SCHEMA_VERSION}`,
      fix: ok ? undefined : '完全退出并重启 PocketAI，启动时会自动执行迁移'
    }
  }))

  // 5. 数据目录可写
  items.push(safeItem('data-dir-writable', '数据目录可写', () => {
    const probe = join(DATA_DIR, `.write-test-${Date.now()}.tmp`)
    try {
      writeFileSync(probe, 'ok')
      return { level: 'ok', detail: `可读写：${DATA_DIR}` }
    } finally {
      try { unlinkSync(probe) } catch { /* ignore */ }
    }
  }))

  // 6. DB 文件存在
  items.push(safeItem('db-file', '数据库文件', () => ({
    level: existsSync(DB_PATH) ? 'ok' : 'danger',
    detail: existsSync(DB_PATH) ? `文件存在：${DB_PATH}` : `数据库文件缺失：${DB_PATH}`,
    fix: existsSync(DB_PATH) ? undefined : '从备份恢复，或检查安全软件是否隔离了数据文件'
  })))

  // 7. 磁盘剩余空间
  items.push(safeItem('disk-space', '磁盘剩余空间', () => {
    const hw = getHardwareInfo()
    const free = hw.disk.freeSpace
    if (free == null) return { level: 'ok', detail: '未能获取磁盘容量（非 Windows 平台）' }
    const gb = free / (1024 * 1024 * 1024)
    const level: CheckLevel = gb < 2 ? 'danger' : gb < 5 ? 'warn' : 'ok'
    return {
      level,
      detail: `剩余 ${gb.toFixed(1)} GB`,
      fix: gb < 2 ? '磁盘空间严重不足，可能导致写入失败/数据库损坏，请立即清理' : gb < 5 ? '空间偏低，建议清理或更换存储位置' : undefined
    }
  }))

  // 8. Provider 配置
  items.push(safeItem('providers', '模型提供商配置', () => {
    const providers = providerRepo.list()
    if (providers.length === 0) {
      return {
        level: 'warn',
        detail: '尚未配置任何模型提供商，对话功能无法使用',
        fix: '设置 → 模型提供商 → 添加 Ollama 或在线 API'
      }
    }
    const problems: string[] = []
    for (const p of providers) {
      if (!p.enabled) continue
      if (p.type !== 'ollama' && p.apiKeys.filter(Boolean).length === 0) {
        problems.push(`「${p.name}」未填写 API Key`)
      }
      if (!p.baseUrl) problems.push(`「${p.name}」未填写接口地址`)
      if (p.models.length === 0) problems.push(`「${p.name}」尚未拉取模型列表`)
    }
    if (problems.length > 0) {
      return { level: 'warn', detail: problems.join('；'), fix: '设置 → 模型提供商 → 编辑对应提供商' }
    }
    const enabledCount = providers.filter((p) => p.enabled).length
    return { level: 'ok', detail: `已配置 ${providers.length} 个提供商（${enabledCount} 个启用），配置完整` }
  }))

  return { items }
}
