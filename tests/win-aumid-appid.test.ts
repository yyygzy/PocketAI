// 清单 B66 里唯一能进 CI 的那半边。
//
// B66 的正题（安装版任务栏是不是紫色墨匣徽标）这台机器证不了：V4-Iter-132 重启 dev 后实测
// 主窗口 PKEY_AppUserModel_ID 为空、任务栏按钮仍归成「Electron - 1 个运行窗口」，
// 因为 Windows 11 要这个 AUMID 对应到一个已注册的快捷方式（安装版由 NSIS 写）。
// 但「应用声明的 AUMID 必须与打包时的 build.appId 同源」是纯代码侧的不变量：
// 改了一边没改另一边 ⇒ 安装版按钮与快捷方式不同组，图标与名字都会退回宿主 exe，
// 而编译器和现有用例都看不见（现查 tests/ 里 setAppUserModelId 原为 0 引用）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const APP_ID = (
  JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    build?: { appId?: string }
  }
).build?.appId

describe('Windows AUMID 与 build.appId 同源（清单 B66 的 CI 半边）', () => {
  it('src/main/index.ts 里 setAppUserModelId 的字面量 == package.json 的 build.appId', () => {
    const m = /app\.setAppUserModelId\((['"])([^'"]+)\1\)/.exec(SRC)
    expect(m, 'src/main/index.ts 里找不到 setAppUserModelId 调用').toBeTruthy()
    expect(APP_ID, 'package.json 里没有 build.appId').toBeTruthy()
    expect(m![2]).toBe(APP_ID)
  })

  it('调用点带 win32 闸门：非 Windows 不该设这个 ID', () => {
    const line = SRC.split(/\r?\n/).find((l) => l.includes('app.setAppUserModelId('))
    expect(line, '调用点整行找不到').toBeTruthy()
    expect(line).toContain("process.platform === 'win32'")
  })
})
