// app-config.repo 内存缓存测试
//
// 覆盖 src/main/db/repositories/app-config.repo.ts 的读缓存层：
// get 首查落缓存/命中免查库、null 也缓存、set/delete 同步更新缓存、
// clearAppConfigCache 失效后重新查库。
//
// 策略：mock dbService 用计数器验证「是否真的查了库」；
// 缓存是模块级 Map，用 vi.resetModules + 动态 import 隔离用例间状态。
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 模拟 app_config 表：Map 当 KV 存储，selectCount 统计真实 SELECT 次数
function createMockDb() {
  const store = new Map<string, string>()
  let selectCount = 0
  const dbService = {
    getHandle: () => ({
      prepare: (sql: string) => ({
        get: (key: string) => {
          if (sql.startsWith('SELECT')) selectCount++
          return store.has(key) ? { value: store.get(key) } : undefined
        },
        run: (key: string, value?: string) => {
          if (sql.startsWith('INSERT')) store.set(key, value ?? '')
          else if (sql.startsWith('DELETE')) store.delete(key)
        }
      })
    })
  }
  return { dbService, getSelectCount: () => selectCount }
}

async function loadRepo() {
  vi.resetModules()
  const mock = createMockDb()
  vi.doMock('../src/main/db/database', () => ({ dbService: mock.dbService }))
  // app-config.repo 依赖 portable → electron app（模块加载期读 isPackaged/getAppPath）
  vi.doMock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/mock/app' } }))
  const mod = await import('../src/main/db/repositories/app-config.repo')
  return { ...mock, appConfigRepo: mod.appConfigRepo, clearAppConfigCache: mod.clearAppConfigCache }
}

describe('appConfigRepo 内存读缓存', () => {
  let ctx: Awaited<ReturnType<typeof loadRepo>>

  beforeEach(async () => {
    ctx = await loadRepo()
  })

  it('get 首次查库，二次命中缓存不再查库', () => {
    ctx.appConfigRepo.set('k1', 'v1') // 预置：走 set（同时进缓存）
    ctx.clearAppConfigCache() // 清缓存，让下一次 get 真正查库
    expect(ctx.getSelectCount()).toBe(0)

    expect(ctx.appConfigRepo.get('k1')).toBe('v1')
    expect(ctx.getSelectCount()).toBe(1)
    expect(ctx.appConfigRepo.get('k1')).toBe('v1')
    expect(ctx.getSelectCount()).toBe(1) // 命中缓存，SELECT 计数不变
  })

  it('未设置的 key 返回 null，null 结果同样被缓存', () => {
    expect(ctx.appConfigRepo.get('missing')).toBeNull()
    expect(ctx.getSelectCount()).toBe(1)
    expect(ctx.appConfigRepo.get('missing')).toBeNull()
    expect(ctx.getSelectCount()).toBe(1) // null 缓存命中，不再 miss 查库
  })

  it('set 落库并同步更新缓存，后续 get 直接读缓存', () => {
    ctx.appConfigRepo.set('k2', 'v2')
    expect(ctx.getSelectCount()).toBe(0)
    expect(ctx.appConfigRepo.get('k2')).toBe('v2')
    expect(ctx.getSelectCount()).toBe(0) // set 已填充缓存，get 零查询
  })

  it('set 覆盖已有缓存值', () => {
    ctx.appConfigRepo.set('k3', 'old')
    ctx.appConfigRepo.set('k3', 'new')
    expect(ctx.appConfigRepo.get('k3')).toBe('new')
  })

  it('delete 落库并缓存 null，后续 get 返回 null 不查库', () => {
    ctx.appConfigRepo.set('k4', 'v4')
    ctx.appConfigRepo.delete('k4')
    expect(ctx.appConfigRepo.get('k4')).toBeNull()
    expect(ctx.getSelectCount()).toBe(0) // delete 已把 null 写入缓存
  })

  it('不同 key 互不干扰', () => {
    ctx.appConfigRepo.set('a', '1')
    ctx.appConfigRepo.set('b', '2')
    expect(ctx.appConfigRepo.get('a')).toBe('1')
    expect(ctx.appConfigRepo.get('b')).toBe('2')
    expect(ctx.appConfigRepo.get('c')).toBeNull()
  })

  it('clearAppConfigCache 失效后 get 重新查库（restore 整库替换场景）', () => {
    ctx.appConfigRepo.set('k5', 'before-restore')
    expect(ctx.appConfigRepo.get('k5')).toBe('before-restore')

    // 模拟 restore：绕过 repo 直接改库（整库替换）后清缓存
    ctx.dbService.getHandle().prepare('INSERT INTO app_config').run('k5', 'after-restore')
    ctx.clearAppConfigCache()

    expect(ctx.appConfigRepo.get('k5')).toBe('after-restore')
    expect(ctx.getSelectCount()).toBe(1) // 缓存已清，这次 get 真查了库
  })
})
