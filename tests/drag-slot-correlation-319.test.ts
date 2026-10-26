// V4-Iter-319（行为面）：拖拽槽的「关联号」——迟到的预写结果不许写进当前这一格。
//
// 缺陷形状（§309／§311 同族，落在导出拖拽这条 pointerdown→dragstart 的 await 窗口上）：
// 改前 ChatView 只有**一格** `dragPathRef`，两个可拖按钮（长图／多选导出）都往里写、都从里读。
// pointerdown 之后主进程预写临时文件是一段异步，其间用户按了另一个按钮（或又按一次同一颗），
// 旧那轮的响应晚到时只会看见一个格子，于是把**旧内容**的路径写进去；dragstart 是同步事件、
// 拿什么就拖什么 ⇒ 点「导出选中」那顆按钮拖出来的是上一轮的长图 PNG（或反过来），界面无任何异常。
//
// 这一面只判格子自己的规矩（四问，逐条对应变异）：
//   ① 最新一代写得进去（正向对照——防守卫写成"恒不写"）；
//   ② 旧一代写不进（守卫本体）；
//   ③ begin 当场清掉上一轮的成品（不然 pointerdown 后立刻 dragstart 会把旧内容拖出去）；
//   ④ 两格之间不串（长图那一格的迟到响应影响不到多选那一格）。
// 「哪个按钮挂哪一格」是接线，jsdom 里多选那条按钮进不去（`VirtualMessageList` 一张卡片都不渲染
// ⇒ selectedIds 永远是空集，批量操作栏整块不出现，见记忆里的挂载面边界），由同批的源码级闸门守：
// tests/chat-view-drag-slot-wiring-319.test.ts。
import { describe, it, expect } from 'vitest'
import { beginDrag, commitDrag, type DragSlot } from '../src/renderer/src/modules/chat/ChatView'

const fresh = (): DragSlot => ({ gen: 0, path: null })

describe('§319 拖拽槽的关联号', () => {
  it('① 正向对照：最新一代的预写结果写得进格子', () => {
    const slot = fresh()
    const gen = beginDrag(slot)
    commitDrag(slot, gen, '/tmp/pocketai-export/a.png')
    expect(slot.path).toBe('/tmp/pocketai-export/a.png')
  })

  it('② 守卫本体：同一格上旧一代的响应写不进去，新一代照常写', () => {
    const slot = fresh()
    const stale = beginDrag(slot)
    const latest = beginDrag(slot)
    expect(latest).not.toBe(stale)
    commitDrag(slot, stale, '/tmp/pocketai-export/old.md')
    expect(slot.path, '迟到的旧一轮不许覆盖').toBeNull()
    commitDrag(slot, latest, '/tmp/pocketai-export/new.md')
    expect(slot.path).toBe('/tmp/pocketai-export/new.md')
  })

  it('②b 迟到的成功不许复活已被清掉的那格（新一轮预写失败时保持"未就绪"）', () => {
    const slot = fresh()
    const g1 = beginDrag(slot)
    const g2 = beginDrag(slot)
    commitDrag(slot, g2, null) // 第二轮构建失败／没选中消息 ⇒ 明确不可拖
    commitDrag(slot, g1, '/tmp/pocketai-export/late.png') // 第一轮这时候才落地
    expect(slot.path, '新一轮没成品时，迟到那份不许把格子填满').toBeNull()
  })

  it('③ begin 当场清掉上一轮的成品：按下去还没预写完就拖＝取消，而不是拖走旧内容', () => {
    const slot = fresh()
    commitDrag(slot, beginDrag(slot), '/tmp/pocketai-export/first.png')
    beginDrag(slot)
    expect(slot.path, '重按一次之后旧路径必须立刻不可用').toBeNull()
  })

  it('④ 两格各管一个按钮：长图那一格的响应动不了多选那一格', () => {
    const png = fresh()
    const md = fresh()
    const pngGen = beginDrag(png)
    const mdGen = beginDrag(md)
    commitDrag(md, mdGen, '/tmp/pocketai-export/selected.md')
    commitDrag(png, pngGen, '/tmp/pocketai-export/long.png') // png 那一轮这时才落地
    expect(md.path).toBe('/tmp/pocketai-export/selected.md')
    expect(png.path).toBe('/tmp/pocketai-export/long.png')
  })

  it('代次从 1 起算且逐次递增（格子初值 0 ⇒ 第一轮必然拿到"最新一代"）', () => {
    const slot = fresh()
    expect(beginDrag(slot)).toBe(1)
    expect(beginDrag(slot)).toBe(2)
  })
})
