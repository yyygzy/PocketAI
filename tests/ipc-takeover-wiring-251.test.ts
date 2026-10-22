// V4-Iter-251：闸门第四面量到的 SettingsModule 那一簇（11 处）收了 9 处，这里钉"接管的话真写进去了"。
//
// 为什么这一批用**接线计数**而不是真挂载：`SettingsModule` 里这九发读散在四个组件（对话设置、
// 路径页脚、加密面板的重取两处、许可证刷新、恢复码卡片、备份计划三处），真挂载要把整棵设置页连同
// 十几发 IPC 一起桩起来，成本与收益不成比例；而这一批的缺陷形状是**"那句接管的话有没有落到屏上"**，
// 用计数能逐条对上（§225 的 ⑤ 就是同一层判据的先例）。**如实记：这九处没有真挂载用例。**
//
// 两张名单都是判据：① 新的接管写法每条都数得出（少一条＝那一发退回静默）；
// ② 旧的"判了不接管"写法必须归零（冒出一条＝红）。反向对照就藏在 ② 里——
// 它使得"我把 resolve 面写成 reject 面"这种半吊子改法也过不了关。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 这个文件是 w/crlf：先归一成 LF，判"写法落点"才与行尾无关（§216 那次孤立 CR 的坑）
const SRC = fs
  .readFileSync(path.resolve(__dirname, '../src/renderer/src/modules/settings/SettingsModule.tsx'), 'utf-8')
  .replace(/\r\n/g, '\n')

const count = (re: RegExp): number => (SRC.match(re) ?? []).length

describe('§251 收口后的接线：九发读各自的接管落点', () => {
  it('① 新的接管写法逐条数得出（少一条就是那一发退回静默）', () => {
    const cases: Array<[string, RegExp, number]> = [
      ['智能标题那发：resolve／reject／成功清空三条落点都在', /setTitleErr\(/g, 3],
      ['智能标题那块把原因挂上屏', /titleErr && <LoadFailNotice/g, 1],
      ['应用路径那发：resolve／reject／成功清空三条落点都在', /setPathsErr\(/g, 3],
      ['路径整块消失时改说"读不到"', /!paths && pathsErr &&/g, 1],
      ['加密状态三发读（挂载／解锁事件／refreshEnc）都写 encErr', /setEncErr\(ipcFailText\(v, t\('common\.unknownError'\)\)\)/g, 3],
      ['加密状态那两发重取的 reject 面也写 encErr', /setEncErr\(errText\(e, t\('common\.unknownError'\)\)\)/g, 3],
      ['许可证刷新的两条失败面写 licErr（挂载那一发本批之前就接了）', /setLicErr\(ipcFailText\(v, t\('common\.unknownError'\)\)\)/g, 2],
      ['恢复码那一发的失败进这张卡片已有的 notice 通道', /setNotice\(\{ ok: false, text: ipcFailText\(v,/g, 1],
      ['备份计划：三处重取并成一条 loadSchedule，两条失败面都写 schedErr', /setSchedErr\((ipcFailText|errText)\(/g, 2],
      ['备份计划读不到时那一块不再整块消失', /!schedule && schedErr && <LoadFailNotice/g, 1],
      ['上传后与保存后的两处刷新改走同一条 loadSchedule', /await loadSchedule\(\)/g, 2],
      ['进面板那一发也走 loadSchedule', /void loadSchedule\(\)/g, 1]
    ]
    for (const [what, re, want] of cases) {
      expect(count(re), what).toBe(want)
    }
  })

  it('② 旧的"判了不接管"写法必须归零（这条同时是上面那条的反向对照）', () => {
    const leftovers: Array<[string, RegExp]> = [
      ['智能标题', /if \(!hasIpcFailed\(v\)\) setEnabled\(v\)/g],
      ['应用路径', /if \(!hasIpcFailed\(v\)\) setPaths\(v\)/g],
      ['加密状态（三发重取都算）', /if \(!hasIpcFailed\(v\)\) setEnc\(v\)/g],
      ['许可证', /if \(!hasIpcFailed\(v\)\) setLic\(v\)/g],
      ['恢复码是否存在', /if \(!hasIpcFailed\(v\)\) setHasKey\(v\)/g],
      ['备份计划（三处）', /if \(!hasIpcFailed\(v\)\) setSchedule\(v\)/g]
    ]
    for (const [what, re] of leftovers) expect(count(re), `这一处还留着"判了不接管"的老写法：${what}`).toBe(0)
  })

  it('③ 成功分支一条都没被顺手删掉（否则收口会变成"永远显示读不到"）', () => {
    const keeps: Array<[string, RegExp, number]> = [
      ['setEnabled(v)', /setEnabled\(v\)/g, 1],
      ['setPaths(v)', /setPaths\(v\)/g, 1],
      ['setEnc(v)（三发读的成功分支）', /setEnc\(v\)/g, 3],
      ['setLic(v)', /setLic\(v\)/g, 2],
      ['setHasKey(v)', /setHasKey\(v\)/g, 1],
      ['setSchedule(v)', /setSchedule\(v\)/g, 1],
      ['成功时把 err 清掉（残留的原因不许压过到了的数据，§222 那条）', /set(Enc|Lic|Paths|Title)?Err\(null\)|setSchedErr\(null\)/g, 6]
    ]
    for (const [what, re, want] of keeps) expect(count(re), `成功分支/清空那一句对不上：${what}`).toBe(want)
  })

  it('④ 顺手收掉的那处形状问题：备份计划曾把同一个 .catch 串了两次', () => {
    expect(count(/\.catch\(reportIpcError\('settings\.refreshSchedule'\)\)\.catch\(/g), '重复的 .catch 链还在').toBe(0)
  })
})
