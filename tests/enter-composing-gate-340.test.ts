// V4-Iter-340 闸门第七面：Enter 提交点必判输入法组字
//
// 形状＝同一个动作有两条触发路径（点按钮 vs 按 Enter），守卫只写在其中一条上。`isComposing` 这条
// 早就在仓库里立过（Composer 发消息、KbAskPanel、KnowledgeModule 检索三处都判），但从没铺满：
// 本批动手前的现数是**35 个 onKeyDown-Enter 提交点里只有 2 个判了**。这里把它做成一张名单闸门，
// 让"再写一个自由文本 Enter 提交框而忘了判"变成 CI 红而不是又一次 hunt。
//
// 两桶口径（§341 起两桶同判，不再有"未判定"那一档）：
// - 自由文本桶＝宿主元素没有 type、或 type 是 text／无条件的其它值（23 处，§340 铺满）
// - 口令与数字桶（type 含 password／number 的 12 处）⇒ §341 真机判掉了这一档：CDP `Input.imeSetComposition`
//   ＋`Input.dispatchKeyEvent` 打在跑起来的实例上，password 与 number 两格里 compositionstart 照发、
//   组字中那次 keydown 的 `isComposing` 都是 true（同屏 text 格作正向对照）。真机后果最重的一格是锁屏解锁框：
//   连按八次组字 Enter，屏上先七次「密码错误」、第八次翻成「尝试过于频繁，请稍后再试」
//   ⇒ 半截组字串真的打进主进程校验链、吃掉了 SEC-10 限流器的额度。
//   （1 个字的组字串会被 `masterPasswordSchema` 的 min(6) 挡在 IPC 入口，那是另一张脸：错误照弹、但不计额度）
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '../src/renderer/src')

interface Site {
  file: string
  calls: string
  secret: boolean
  hasComposing: boolean
}

/** 输入一份 TSX 源码，返回它所有的 onKeyDown-Enter 提交点（分类器与闸门共用，漏杀对照也走这一份） */
function scan(file: string, text: string): Site[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const sites: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'onKeyDown') {
      const init = node.initializer
      const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
      const body = expr ? expr.getText() : ''
      // 判 Enter：`=== 'Enter'`／`== 'Enter'`（不匹配 `!==`，那类是"除 Enter 之外"）
      const usesEnter = /(?:^|[^!])===?\s*['"]Enter['"]/.test(body)
      if (expr && usesEnter) {
        const attrs = node.parent
        let typeText = ''
        for (const p of attrs.properties) {
          if (ts.isJsxAttribute(p) && p.name.getText() === 'type') typeText = p.getText()
        }
        const secret = /password|number/.test(typeText)
        // 它调用了什么（右键菜单/输入框提交的动作名，当名单的身份证用）
        const names: string[] = []
        const walk = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) {
            const e = n.expression
            const nm = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.getText() : ''
            if (nm && !['preventDefault', 'stopPropagation', 'void', 'then', 'trim'].includes(nm)) names.push(nm)
          }
          ts.forEachChild(n, walk)
        }
        walk(expr)
        sites.push({ file, calls: [...new Set(names)].sort().join(','), secret, hasComposing: /isComposing/.test(body) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return sites
}

function allSites(): Site[] {
  const out: Site[] = []
  const walkDir = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walkDir(p)
      else if (e.name.endsWith('.tsx')) {
        out.push(...scan(path.relative(ROOT, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')))
      }
    }
  }
  walkDir(ROOT)
  return out
}

describe('① 分类器自己要有牙', () => {
  const SAMPLE = `const A = () => (
  <div>
    <input onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
    <input type="password" onKeyDown={(e) => { if (e.key === 'Enter') send() }} />
    <input onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) ok() }} />
    <input onKeyDown={(e) => { if (e.key === 'Escape') cancel() }} />
    <input onKeyDown={(e) => { if (e.key !== 'Enter') weird() }} />
  </div>
)`

  it('认出自由文本与口令两类、判过的标成判过、只判 Escape 与 `!== Enter` 的不算提交点', () => {
    const got = scan('sample.tsx', SAMPLE)
    expect(got.map((s) => `${s.calls}|secret=${s.secret}|comp=${s.hasComposing}`)).toEqual([
      'save|secret=false|comp=false',
      'send|secret=true|comp=false',
      'ok|secret=false|comp=true'
    ])
  })

  it('漏杀对照：把 sample 里那句 isComposing 拿掉 ⇒ 违规名单立刻多一个（判据不是恒绿）', () => {
    const stripped = SAMPLE.replace(' && !e.nativeEvent.isComposing', '')
    // §341 起两桶同判，所以 sample 里没判的那颗口令框（send）也在名单里
    expect(scan('sample.tsx', SAMPLE).filter((s) => !s.hasComposing).map((s) => s.calls)).toEqual(['save', 'send'])
    expect(scan('sample.tsx', stripped).filter((s) => !s.hasComposing).map((s) => s.calls)).toEqual(['save', 'send', 'ok'])
  })
})

describe('② 全仓现数与两桶身份证', () => {
  const sites = allSites()
  const freeText = sites.filter((s) => !s.secret)
  const secret = sites.filter((s) => s.secret)

  it(`Enter 提交点总数＝35（口令 12＋自由文本 23）——新增提交点必须先进这张表`, () => {
    expect(sites.length).toBe(35)
    expect(secret.length).toBe(12)
    expect(freeText.length).toBe(23)
  })

  it('一个不漏（§341 起两桶并一条判据）：35 个提交点每个都得判 isComposing', () => {
    const missing = sites.filter((s) => !s.hasComposing).map((s) => `${s.file} → ${s.calls}`)
    expect(missing, `这些输入框按 Enter 会把输入法组字中的半截句子交出去：\n${missing.join('\n')}`).toEqual([])
  })

  it('自由文本桶的身份证（文件＋动作名）逐条钉住：改名／搬走也要过这张表', () => {
    expect(freeText.map((s) => `${s.file}::${s.calls}`).sort()).toEqual([
      'components/OllamaPanel.tsx::doPull,setCustomModel',
      'components/SnippetButton.tsx::insertWithVars',
      'components/SnippetVarsDialog.tsx::insert,onCancel',
      'modules/agent/components/AgentMessageCard.tsx::onEditingChange,submit',
      'modules/agent/components/AgentSearchBar.tsx::onClose,onNext,onPrev',
      'modules/agent/components/SessionRail.tsx::commit,setEditing',
      'modules/chat/ConversationList.tsx::commit,setEditing',
      'modules/chat/ConversationList.tsx::commitNote,setNoteEditing',
      'modules/chat/ConversationList.tsx::setCreatingGroup,setNewGroupName,submitCreateGroup',
      'modules/chat/ConversationList.tsx::setRenamingGroupId,submitRenameGroup',
      'modules/chat/MessageBubble.tsx::onResend,setEditing',
      'modules/files/FilesModule.tsx::submit',
      'modules/knowledge/KbAskPanel.tsx::commitRename,setRenamingId',
      'modules/knowledge/KbAskPanel.tsx::send',
      'modules/knowledge/KnowledgeModule.tsx::handleSearch',
      'modules/knowledge/KnowledgeModule.tsx::submit',
      'modules/knowledge/KnowledgeModule.tsx::submit',
      'modules/settings/SettingsModule.tsx::save',
      'modules/settings/UserMemoryPanel.tsx::add',
      'modules/settings/UserMemoryPanel.tsx::saveEdit,setEditingId',
      'modules/skills/SkillMarket.tsx::fetchRemote',
      'modules/skills/SkillMarket.tsx::handleImportFromUrl',
      'modules/translate/TranslateModule.tsx::submit'
    ].sort())
  })

  it('口令与数字那 12 处的身份证（§341 真机判定后并入必判桶，名单照钉）', () => {
    expect(secret.map((s) => `${s.file}::${s.calls}`).sort()).toEqual([
      'components/LockOverlay.tsx::onUnlock',
      'components/ReminderMenu.tsx::submitCustom',
      'modules/agent/channels/ChannelsPanel.tsx::patchCfg,setPrimaryDraft',
      'modules/agent/channels/ChannelsPanel.tsx::patchCfg,setSecondaryDraft',
      'modules/agent/chat/AgentPanel.tsx::confirmCrypto,setCryptoPrompt',
      'modules/agent/components/AgentToolBars.tsx::patchWsConfig,setWsKeyDraft',
      'modules/chat/ChatModule.tsx::confirmCrypto,setCryptoPrompt',
      'modules/settings/SettingsModule.tsx::commitCodeCollapse',
      'modules/settings/SettingsModule.tsx::doMergeRescanWithPwd',
      'modules/settings/SettingsModule.tsx::doRestoreWithPassword',
      'modules/unlock/UnlockPage.tsx::handleSubmit',
      'modules/wizard/FirstRunWizard.tsx::enableEncryption'
    ].sort())
  })
})

describe('③ 同批另两项非输入法修复的接线钉子', () => {
  const settings = fs.readFileSync(path.resolve(ROOT, 'modules/settings/SettingsModule.tsx'), 'utf8').replace(/\r\n/g, '\n')

  it('代理那一屏：Enter 绕不过那颗按钮的在飞态（守卫写在 save() 体内，两条路共用）', () => {
    expect(settings.split('const save = async () => {').length - 1).toBe(1)
    const body = settings.split('const save = async () => {')[1]!.slice(0, 200)
    expect(body, 'save() 的第一句必须是在飞守卫').toMatch(/^\s*(\/\/[^\n]*\n\s*)*if \(saving\) return\n\s*setSaving\(true\)/)
  })
})
