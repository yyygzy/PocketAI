// @vitest-environment node
// §386：WebDAV 配置那一行「存在却读不出来」不再塌成「没配过」（候选 ①，口径 A＝三档同源＋逐处表态）
//
// 缺陷形状：`readWebDAVConfig` 只有两档（`cfg` 有值／null），而 `catch` 把「那一行 JSON 坏掉」也折进
// `cfg:null`＝「没配过」。可达路径＝整库恢复把 app_config 整表换成备份里那一份
// （`backup-service.ts` 的 `restoreWebDAVBackup` 里那句 `clearAppConfigCache` 注释自证）。
// 后果分四类，每一类都在演一句假话：
//   ①设置页摆一张空表单，点「保存」正好把那份坏行覆盖掉（用户从此以为是自己没配过）；
//   ②六发动作（上传／增量／清单／恢复／合并扫描／合并执行／删除）齐声说「未配置 WebDAV」；
//   ③远程清单回 `[]`＝「这台服务器上一份备份都没有」；
//   ④两个调度器静默跳过＝屏上只剩「从未运行」。
// 本枚＝读侧补第三颗 flag（三档互斥），出口按档表态：那一读回失败信封、六发回第三档那句、
// 两处屏各画各的脸、调度器坏行不再安静（与 §382 那判同一口径：让它落进 lastError，屏上读得到）。
//
// 策略：真加密真解密＋真注册真 invoke 的 IPC 通道＋**真 backup-scheduler**（只桩网络／配置仓／开库／日志）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const KEY = Buffer.alloc(32, 0x11)
const PW = 'real-dav-password-42'

const H = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  store: new Map<string, string>(),
  fieldKey: Buffer.alloc(32, 0x11),
  warns: [] as string[],
  net: [] as string[],
  listFails: null as string | null
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { H.handlers.set(ch, fn) } },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    static fromWebContents() { return undefined }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showErrorBox: () => {}
  },
  app: { isPackaged: false, getPath: () => process.cwd(), getAppPath: () => process.cwd(), quit: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getFieldKey: () => H.fieldKey,
    getDbKey: () => Buffer.alloc(32, 7),
    getMode: () => 'db',
    isDbEncrypted: () => true,
    hasKey: () => true
  }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => H.store.get(k) ?? null,
    set: (k: string, v: string) => { H.store.set(k, v) },
    delete: (k: string) => { H.store.delete(k) }
  },
  clearAppConfigCache: () => {}
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    error: (m: string) => H.warns.push(`error ${m}`),
    warn: (m: string) => H.warns.push(String(m)),
    info: () => {},
    debug: () => {}
  })
}))
vi.mock('archiver', () => ({ default: () => ({}) }))
vi.mock('unzipper', () => ({ default: {} }))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({ pragma: () => [] }) } }))
vi.mock('../src/main/portable', () => ({ DB_PATH: '', ATTACHMENTS_DIR: '', DATA_DIR: process.cwd() }))
vi.mock('../src/main/backup/webdav-client', () => ({
  testConnection: async () => { H.net.push('testConnection'); return { ok: true } },
  uploadBuffer: async () => { H.net.push('uploadBuffer'); return {} },
  downloadFile: async () => { H.net.push('downloadFile'); return Buffer.alloc(0) },
  listFiles: async () => { H.net.push('listFiles'); if (H.listFails) throw new Error(H.listFails); return [] },
  deleteFile: async () => { H.net.push('deleteFile') },
  remoteExists: async () => { H.net.push('remoteExists'); return 'absent' },
  uploadRemoteBuffer: async () => { H.net.push('uploadRemoteBuffer'); return {} },
  downloadRemoteFile: async () => { H.net.push('downloadRemoteFile'); return Buffer.alloc(0) }
}))

import { IPC, type WebDAVConfig } from '../src/shared/types'
import { registerBackupHandlers } from '../src/main/ipc/handlers/backup'
import {
  readWebDAVConfig,
  loadWebDAVConfig,
  saveWebDAVConfig,
  captureWebDAVForRekey,
  loadWebDAVConfigOrError,
  WEBDAV_CONFIG_UNREADABLE_MSG
} from '../src/main/backup/backup-service'
import { tick as backupTick } from '../src/main/backup/backup-scheduler'

const CFG_KEY = 'webdav_config'
const BASE: WebDAVConfig = { url: 'https://dav.example.com/remote.php/dav/files/me', username: 'me', passwordCipher: PW, directory: 'pocketai' }
/** 整库恢复留下的那一行：是一个字符串、但不是能解析的形状（也不是 JSON 对象） */
const BROKEN = '{"url":"https://dav.example.com/remote.php/dav/files/me","username":"me","passwordCipher":'

const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
  H.handlers.get(channel)!({ sender: {} }, ...args) as Promise<unknown>

beforeEach(() => {
  H.handlers.clear()
  H.store.clear()
  H.warns = []
  H.net = []
  H.listFails = null
  H.fieldKey = KEY
  registerBackupHandlers()
})

describe('①读侧：三档互斥（没行／坏行／好行）', () => {
  it('没那一行 ⇒ cfg null＋两颗 flag 都 false（「没配过」这一档不许顺带点亮别的）', () => {
    expect(readWebDAVConfig()).toEqual({ cfg: null, passwordUndecryptable: false, configUnreadable: false })
    expect(loadWebDAVConfig()).toBe(null)
  })

  it('有行、解析不出来 ⇒ cfg null 但 configUnreadable=true（这一档改前与上一档共用一个出口）', () => {
    H.store.set(CFG_KEY, BROKEN)
    const read = readWebDAVConfig()
    expect(read.cfg).toBe(null)
    expect(read.configUnreadable, '坏行必须自己说话').toBe(true)
    expect(read.passwordUndecryptable, '坏行不是"解不开"：连哪一栏是口令都不知道，谈不上解不开').toBe(false)
  })

  it('好行 ⇒ 两 flag 都 false；反向对照：换字段密钥让口令解不开时，configUnreadable 仍 false（两颗不许互相顶）', () => {
    saveWebDAVConfig(BASE)
    expect(readWebDAVConfig()).toMatchObject({ configUnreadable: false, passwordUndecryptable: false })
    H.fieldKey = Buffer.alloc(32, 0x33)
    expect(readWebDAVConfig()).toMatchObject({ passwordUndecryptable: true, configUnreadable: false })
  })

  it('坏行时轮换那一读（captureWebDAVForRekey）也不许说成「解不开」＝不进 count、不连累轮换', () => {
    H.store.set(CFG_KEY, BROKEN)
    expect(captureWebDAVForRekey()).toEqual({ cfg: null, undecryptable: false })
  })
})

describe('②取法出口：loadWebDAVConfigOrError 三档各回一句', () => {
  it('坏行 ⇒ 第三档那句，且与「未配置 WebDAV」不是同一句', () => {
    H.store.set(CFG_KEY, BROKEN)
    const got = loadWebDAVConfigOrError()
    expect('cfg' in got).toBe(false)
    expect((got as { error: string }).error).toBe(WEBDAV_CONFIG_UNREADABLE_MSG)
    expect(WEBDAV_CONFIG_UNREADABLE_MSG).not.toBe('未配置 WebDAV')
  })

  it('反向对照：真没配过 ⇒ 仍回「未配置 WebDAV」（这一档该指去「配置」，不是「重填」）', () => {
    expect((loadWebDAVConfigOrError() as { error: string }).error).toBe('未配置 WebDAV')
  })

  it('反向对照：好行 ⇒ 交回 cfg（口令已解密），两档 false', () => {
    saveWebDAVConfig(BASE)
    const got = loadWebDAVConfigOrError()
    expect('cfg' in got && got.cfg.passwordCipher).toBe(PW)
  })
})

describe('③出 IPC：那一读与六发动作按档表态', () => {
  it('LOAD_CONFIG 遇坏行 ⇒ 失败信封（不是 null）：null 会让设置页摆空表单，保存正好覆盖坏行', async () => {
    H.store.set(CFG_KEY, BROKEN)
    expect(await call(IPC.BACKUP_WEBDAV_LOAD_CONFIG)).toEqual({ ok: false, error: WEBDAV_CONFIG_UNREADABLE_MSG })
  })

  it('反向对照：LOAD_CONFIG 真没配过 ⇒ 仍回 null；好行 ⇒ 回掩码视图', async () => {
    expect(await call(IPC.BACKUP_WEBDAV_LOAD_CONFIG)).toBe(null)
    saveWebDAVConfig(BASE)
    const ok = await call(IPC.BACKUP_WEBDAV_LOAD_CONFIG) as Record<string, unknown>
    expect(ok.passwordCipher, '出 IPC 必须掩码').toBe('••••' + PW.slice(-4))
    expect(ok.configUnreadable, '掩码视图只带它原来那两颗，坏行那一档走失败信封').not.toBe(true)
  })

  it('上传那一发遇坏行 ⇒ 第三档那句，且一次网络都不发', async () => {
    H.store.set(CFG_KEY, BROKEN)
    expect(await call(IPC.BACKUP_WEBDAV_UPLOAD)).toEqual({ ok: false, error: WEBDAV_CONFIG_UNREADABLE_MSG })
    expect(H.net, '配置都读不出来，不该去碰远端').toEqual([])
  })

  it('反向对照：真没配过 ⇒ 那句仍是「未配置 WebDAV」', async () => {
    expect(await call(IPC.BACKUP_WEBDAV_UPLOAD)).toEqual({ ok: false, error: '未配置 WebDAV' })
  })

  it('清单那一发遇坏行 ⇒ 失败信封，绝不回 []（[]＝「这台服务器一份备份都没有」）', async () => {
    H.store.set(CFG_KEY, BROKEN)
    expect(await call(IPC.BACKUP_WEBDAV_LIST)).toEqual({ ok: false, error: WEBDAV_CONFIG_UNREADABLE_MSG })
    expect(H.net).toEqual([])
  })

  it('反向对照：好行＋远端拉取抛错 ⇒ 回的是网络那句，不是第三档那句（两种失败各说各的）', async () => {
    saveWebDAVConfig(BASE)
    H.listFails = 'socket hang up'
    const r = await call(IPC.BACKUP_WEBDAV_LIST) as { ok: boolean; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('socket hang up')
    expect(r.error).not.toBe(WEBDAV_CONFIG_UNREADABLE_MSG)
    expect(H.net, '好行那一发确实去拉了（坏行那发一次都没发）').toContain('listFiles')
  })

  it('恢复／合并扫描／合并执行／删除那四发同样按档表态（同源＝loadWebDAVConfigOrError）', async () => {
    H.store.set(CFG_KEY, BROKEN)
    const cases: Array<[string, unknown[]]> = [
      [IPC.BACKUP_WEBDAV_RESTORE, ['pocketai-backup-1.zip']],
      [IPC.BACKUP_WEBDAV_MERGE_SCAN, ['pocketai-backup-1.zip']],
      [IPC.BACKUP_WEBDAV_MERGE_EXECUTE, [{ filename: 'pocketai-backup-1.zip', strategy: 'newer' }]],
      [IPC.BACKUP_WEBDAV_DELETE, ['pocketai-backup-1.zip']]
    ]
    for (const [ch, args] of cases) {
      const r = await call(ch, ...args) as Record<string, unknown>
      expect(r.ok, `${ch} 不许把坏行说成没配过`).toBe(false)
      expect(r.error, ch).toBe(WEBDAV_CONFIG_UNREADABLE_MSG)
    }
    expect(H.net).toEqual([])
  })
})

describe('④定时备份：坏行不再演成「没配过」的安静', () => {
  it('启用＋坏行 ⇒ 这一轮真跑一次并落 lastError（数据健康与管家体检读的就是它）', async () => {
    H.store.set('backup.schedule_enabled', '1')
    H.store.set(CFG_KEY, BROKEN)
    await backupTick()
    const written = JSON.parse(H.store.get('backup.last_result')!) as { ok: boolean; error?: string }
    expect(written.ok).toBe(false)
    expect(written.error, '落库那句必须点名"读不出来"，不是「未配置 WebDAV」').toBe(WEBDAV_CONFIG_UNREADABLE_MSG)
    expect(H.net).toEqual([])
  })

  it('反向对照：启用＋真没配过 ⇒ 安静跳过（不落 last_result、不发网络）——这一档"没配"是合法状态', async () => {
    H.store.set('backup.schedule_enabled', '1')
    await backupTick()
    expect(H.store.has('backup.last_result'), '改前坏行走的就是这一支：屏上只剩「从未运行」').toBe(false)
    expect(H.net).toEqual([])
  })
})
