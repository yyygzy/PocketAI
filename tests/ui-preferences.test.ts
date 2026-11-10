// ui-preferences 界面偏好测试
//
// 覆盖 src/main/ui-preferences.ts 的：
// - clampOpacity：透明度限幅（非有限→1、限幅 MIN..MAX=0.6..1）
// - getUiPreferences：读取 opacity（非法→1）+ customCss（缺省→''）
// - setUiPreferences：opacity clamp 后持久化、customCss 截 200K
//
// 策略：clampOpacity 纯函数无依赖；get/setUiPreferences 用 vi.hoisted mock appConfigRepo(Map)。
// setUiPreferences 内部 applyOpacityToMainWindows 调用 BrowserWindow.getAllWindows，
// mock electron 使其返回空数组避免窗口操作。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  windows: [] as unknown[],
  appConfigRepo: {
    get: (k: string) => mocks.store.get(k) ?? null,
    set: (k: string, v: string) => { mocks.store.set(k, v) },
    delete: (k: string) => { mocks.store.delete(k) }
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => mocks.windows
  }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: mocks.appConfigRepo }))

import { clampOpacity, getUiPreferences, setUiPreferences, MIN_OPACITY, MAX_OPACITY, MAX_CSS_LENGTH, MAX_PREFERENCE_ID_CHARS, normalizeCodeCollapseLines, DEFAULT_CODE_COLLAPSE_LINES, MAX_CODE_COLLAPSE_LINES, getUiTheme, readStoredUiTheme, windowBackground, setUiTheme, normalizeUiTheme, markThemedWindow, hasStoredUiTheme, awaitRendererTheme, reportRendererTheme } from '../src/main/ui-preferences'

beforeEach(() => {
  mocks.store.clear()
  mocks.windows.length = 0
})

describe('clampOpacity — 透明度限幅', () => {
  it('正常范围内值原样返回', () => {
    expect(clampOpacity(0.8)).toBe(0.8)
    expect(clampOpacity(0.6)).toBe(0.6)
    expect(clampOpacity(1)).toBe(1)
  })

  it('低于下限 → 抬到 MIN', () => {
    expect(clampOpacity(0.3)).toBe(MIN_OPACITY)
    expect(clampOpacity(0)).toBe(MIN_OPACITY)
    expect(clampOpacity(-1)).toBe(MIN_OPACITY)
  })

  it('高于上限 → 压到 MAX', () => {
    expect(clampOpacity(1.5)).toBe(MAX_OPACITY)
    expect(clampOpacity(2)).toBe(MAX_OPACITY)
  })

  it('非有限值 → 1', () => {
    expect(clampOpacity(NaN)).toBe(1)
    expect(clampOpacity(Infinity)).toBe(1)
    expect(clampOpacity(-Infinity)).toBe(1)
  })

  it('边界值不截断', () => {
    expect(clampOpacity(MIN_OPACITY)).toBe(MIN_OPACITY)
    expect(clampOpacity(MAX_OPACITY)).toBe(MAX_OPACITY)
  })
})

describe('getUiPreferences — 读取偏好', () => {
  it('未配置 → opacity=1, customCss=""', () => {
    const p = getUiPreferences()
    expect(p.opacity).toBe(1)
    expect(p.customCss).toBe('')
  })

  it('已配置 opacity 且合法 → clamp 后返回', () => {
    mocks.store.set('ui.opacity', '0.7')
    expect(getUiPreferences().opacity).toBe(0.7)
  })

  it('opacity 超范围 → clamp', () => {
    mocks.store.set('ui.opacity', '2.0')
    expect(getUiPreferences().opacity).toBe(1)
  })

  it('opacity 非数字 → 回退 1', () => {
    mocks.store.set('ui.opacity', 'abc')
    expect(getUiPreferences().opacity).toBe(1)
  })

  it('opacity 为 0 或负数 → 回退 1（raw>0 判断）', () => {
    mocks.store.set('ui.opacity', '0')
    expect(getUiPreferences().opacity).toBe(1)
  })

  it('已配置 customCss → 原样返回', () => {
    mocks.store.set('ui.custom_css', 'body { color: red; }')
    expect(getUiPreferences().customCss).toBe('body { color: red; }')
  })
})

describe('setUiPreferences — 保存偏好', () => {
  it('设置 opacity → clamp 后持久化为字符串', () => {
    setUiPreferences({ opacity: 0.75 })
    expect(mocks.store.get('ui.opacity')).toBe('0.75')
  })

  it('opacity 超范围 → Zod 校验抛错（schema 边界）', () => {
    expect(() => setUiPreferences({ opacity: 5 })).toThrow()
    expect(mocks.store.has('ui.opacity')).toBe(false)
  })

  it('opacity 非有限 → Zod 校验抛错', () => {
    expect(() => setUiPreferences({ opacity: NaN })).toThrow()
  })

  it('设置 customCss → 持久化', () => {
    setUiPreferences({ customCss: 'a { color: blue; }' })
    expect(mocks.store.get('ui.custom_css')).toBe('a { color: blue; }')
  })

  it('customCss 超 MAX_CSS_LENGTH → 截断', () => {
    const longCss = 'x'.repeat(MAX_CSS_LENGTH + 100)
    setUiPreferences({ customCss: longCss })
    expect(mocks.store.get('ui.custom_css')).toHaveLength(MAX_CSS_LENGTH)
  })

  it('不传任何字段 → 不修改 store', () => {
    setUiPreferences({})
    expect(mocks.store.size).toBe(0)
  })

  it('返回最新偏好', () => {
    const result = setUiPreferences({ opacity: 0.7, customCss: 'x' })
    expect(result.opacity).toBe(0.7)
    expect(result.customCss).toBe('x')
  })
})

describe('Agent「上次用在哪」偏好（ui.agent_assistant_id / ui.agent_conversation_id）', () => {
  it('未配置 → 两个 id 都是空串（空=没有存档，不是读取失败）', () => {
    const p = getUiPreferences()
    expect(p.agentAssistantId).toBe('')
    expect(p.agentConversationId).toBe('')
  })

  it('写入后读回原值，键名落在 app_config（合并时属 LOCAL_KEEP 表，不会被另一台机器搬来）', () => {
    setUiPreferences({ agentAssistantId: 'a-1', agentConversationId: 'c-2' })
    expect(mocks.store.get('ui.agent_assistant_id')).toBe('a-1')
    expect(mocks.store.get('ui.agent_conversation_id')).toBe('c-2')
    const p = getUiPreferences()
    expect(p.agentAssistantId).toBe('a-1')
    expect(p.agentConversationId).toBe('c-2')
  })

  it('只传助手 → 会话字段不动（不能把另一半存档顺手清空）', () => {
    setUiPreferences({ agentAssistantId: 'a-1', agentConversationId: 'c-2' })
    setUiPreferences({ agentAssistantId: 'a-9' })
    expect(mocks.store.get('ui.agent_conversation_id')).toBe('c-2')
  })

  it('空串是合法的「清除」，与「没传这个字段」区分得开', () => {
    setUiPreferences({ agentAssistantId: 'a-1' })
    setUiPreferences({ agentAssistantId: '' })
    expect(mocks.store.get('ui.agent_assistant_id')).toBe('')
    expect(getUiPreferences().agentAssistantId).toBe('')
  })

  it('入参去首尾空白；存档只放 id，不放内容', () => {
    setUiPreferences({ agentAssistantId: '  a-1  ' })
    expect(mocks.store.get('ui.agent_assistant_id')).toBe('a-1')
  })

  it('读路径也限长 128（KV 被别的写法拉进长串时不至于整份偏好变肥）', () => {
    mocks.store.set('ui.agent_conversation_id', 'x'.repeat(MAX_PREFERENCE_ID_CHARS + 50))
    expect(getUiPreferences().agentConversationId).toHaveLength(MAX_PREFERENCE_ID_CHARS)
  })

  it('超过 128 的入参被 schema 拒绝，不写库（与 opacity/折叠阈值同口径）', () => {
    expect(() => setUiPreferences({ agentAssistantId: 'x'.repeat(200) })).toThrow()
    expect(mocks.store.has('ui.agent_assistant_id')).toBe(false)
  })

  it('KV 被外部写脏（非字符串）→ 读回空串，不抛', () => {
    mocks.store.set('ui.agent_assistant_id', 12345 as unknown as string)
    expect(getUiPreferences().agentAssistantId).toBe('')
  })
})

describe('normalizeCodeCollapseLines — 折叠阈值清洗', () => {

  it('缺省/空值 → 默认 20（未配置不等于永不折叠）', () => {
    expect(normalizeCodeCollapseLines(null)).toBe(DEFAULT_CODE_COLLAPSE_LINES)
    expect(normalizeCodeCollapseLines(undefined)).toBe(DEFAULT_CODE_COLLAPSE_LINES)
    expect(normalizeCodeCollapseLines('')).toBe(DEFAULT_CODE_COLLAPSE_LINES)
    expect(normalizeCodeCollapseLines('abc')).toBe(DEFAULT_CODE_COLLAPSE_LINES)
    expect(normalizeCodeCollapseLines(-1)).toBe(DEFAULT_CODE_COLLAPSE_LINES)
    expect(normalizeCodeCollapseLines(NaN)).toBe(DEFAULT_CODE_COLLAPSE_LINES)
  })

  it('0 是合法值（永不折叠），向下取整，超上限压到 200', () => {
    expect(normalizeCodeCollapseLines(0)).toBe(0)
    expect(normalizeCodeCollapseLines('0')).toBe(0)
    expect(normalizeCodeCollapseLines('12.9')).toBe(12)
    expect(normalizeCodeCollapseLines(999)).toBe(MAX_CODE_COLLAPSE_LINES)
  })
})

describe('主题底色（ui.theme，A-3 / D1）', () => {
  function fakeWindow(): { win: Record<string, unknown>; setBackgroundColor: ReturnType<typeof vi.fn> } {
    const setBackgroundColor = vi.fn()
    return { win: { isDestroyed: () => false, setBackgroundColor }, setBackgroundColor }
  }

  it('无值 → 按现有默认深色（不改默认）', () => {
    expect(getUiTheme()).toBe('dark')
    expect(windowBackground()).toBe('#1e1e2e')
    expect(normalizeUiTheme(null)).toBe('dark')
    expect(normalizeUiTheme('bogus')).toBe('dark')
  })

  it('切到浅色 → 写 KV、底色变浅、只作用于打了主题标记的窗口', () => {
    expect(setUiTheme('light')).toBe('light')
    expect(mocks.store.get('ui.theme')).toBe('light')
    expect(windowBackground('light')).toBe('#eff1f5')

    const themed = fakeWindow()
    const popup = fakeWindow()
    markThemedWindow(themed.win as never)
    mocks.windows.push(themed.win, popup.win)

    setUiTheme('light')
    expect(themed.setBackgroundColor).toHaveBeenLastCalledWith('#eff1f5')
    expect(popup.setBackgroundColor).not.toHaveBeenCalled()

    setUiTheme('dark')
    expect(themed.setBackgroundColor).toHaveBeenLastCalledWith('#1e1e2e')
  })

  it('重新启动读回上次主题（无缓存，直接读 KV）', () => {
    setUiTheme('light')
    expect(getUiTheme()).toBe('light')
    expect(windowBackground()).toBe('#eff1f5')
  })

  it('新预设 id（ocean/sand）走同一套读写：窗口底色查表，不再落回深色', () => {
    expect(windowBackground('ocean')).toBe('#0f2033')
    expect(windowBackground('sand')).toBe('#faf7f0')
    expect(setUiTheme('ocean')).toBe('ocean')
    expect(mocks.store.get('ui.theme')).toBe('ocean')
    expect(getUiTheme()).toBe('ocean')
    expect(readStoredUiTheme()).toBe('ocean')
    expect(setUiTheme('sand')).toBe('sand')
    expect(readStoredUiTheme()).toBe('sand')
  })

  it('readStoredUiTheme 只回答「有没有值」：缺省/脏值 → null，合法值原样', () => {
    expect(readStoredUiTheme()).toBeNull()
    mocks.store.set('ui.theme', 'light')
    expect(readStoredUiTheme()).toBe('light')
    mocks.store.set('ui.theme', 'dark')
    expect(readStoredUiTheme()).toBe('dark')
    mocks.store.set('ui.theme', 'bogus')
    expect(readStoredUiTheme()).toBeNull()
  })

  it('readStoredUiTheme 不吞库未打开异常（调用方据此跳过回填，而不是误判成无值）', () => {
    const original = mocks.appConfigRepo.get
    mocks.appConfigRepo.get = () => {
      throw new Error('Database not opened')
    }
    try {
      expect(() => readStoredUiTheme()).toThrow()
    } finally {
      mocks.appConfigRepo.get = original
    }
  })

  it('库未打开（读 KV 抛错）→ 退回深色且不污染后续读取', () => {
    const original = mocks.appConfigRepo.get
    mocks.appConfigRepo.get = () => {
      throw new Error('Database not opened')
    }
    try {
      expect(getUiTheme()).toBe('dark')
      expect(windowBackground()).toBe('#1e1e2e')
    } finally {
      mocks.appConfigRepo.get = original
    }
    mocks.store.set('ui.theme', 'light')
    expect(getUiTheme()).toBe('light')
  })
})

describe('代码块折叠阈值持久化', () => {
  it('未配置 → getUiPreferences 返回 20', () => {
    expect(getUiPreferences().codeCollapseLines).toBe(DEFAULT_CODE_COLLAPSE_LINES)
  })

  it('设 0 → 存「0」且读回 0（不被当成缺省值吞掉）', () => {
    setUiPreferences({ codeCollapseLines: 0 })
    expect(mocks.store.get('ui.code_collapse_lines')).toBe('0')
    expect(getUiPreferences().codeCollapseLines).toBe(0)
  })

  it('超上限入参 → schema 直接拒绝（与 opacity 同口径，不静默改写用户意图）', () => {
    expect(() => setUiPreferences({ codeCollapseLines: 500 })).toThrow()
    expect(mocks.store.has('ui.code_collapse_lines')).toBe(false)
  })

  it('小数/负数按 schema 拒绝（int + min 0），不写库', () => {
    expect(() => setUiPreferences({ codeCollapseLines: 12.5 })).toThrow()
    expect(() => setUiPreferences({ codeCollapseLines: -1 })).toThrow()
    expect(mocks.store.has('ui.code_collapse_lines')).toBe(false)
  })

  it('KV 被外部写脏 → 读回默认', () => {
    mocks.store.set('ui.code_collapse_lines', 'not-a-number')
    expect(getUiPreferences().codeCollapseLines).toBe(DEFAULT_CODE_COLLAPSE_LINES)
  })
})

describe('首帧主题上报（D1：首启不闪深色）', () => {
  function fakeWindow(id: number): {
    win: Record<string, unknown>
    setBackgroundColor: ReturnType<typeof vi.fn>
  } {
    const setBackgroundColor = vi.fn()
    const win = {
      webContents: { id },
      isDestroyed: () => false,
      setBackgroundColor,
      once: vi.fn()
    }
    return { win, setBackgroundColor }
  }

  it('hasStoredUiTheme：有值 true；缺省/脏值 false；读库抛错也按「没有」', () => {
    expect(hasStoredUiTheme()).toBe(false)
    mocks.store.set('ui.theme', 'light')
    expect(hasStoredUiTheme()).toBe(true)
    mocks.store.set('ui.theme', 'bogus')
    expect(hasStoredUiTheme()).toBe(false)

    const original = mocks.appConfigRepo.get
    mocks.appConfigRepo.get = () => {
      throw new Error('Database not opened')
    }
    try {
      expect(hasStoredUiTheme()).toBe(false)
    } finally {
      mocks.appConfigRepo.get = original
    }
  })

  it('上报后先把主题化窗口底色改对，再结算等待中的显示（只结算一次）', () => {
    const { win, setBackgroundColor } = fakeWindow(7)
    markThemedWindow(win as never)
    const onReport = vi.fn()
    awaitRendererTheme(win as never, onReport)

    reportRendererTheme({ id: 7 } as never, 'light')
    expect(setBackgroundColor).toHaveBeenLastCalledWith('#eff1f5')
    expect(onReport).toHaveBeenCalledTimes(1)

    reportRendererTheme({ id: 7 } as never, 'light')
    expect(onReport).toHaveBeenCalledTimes(1)
  })

  it('没登记等待的窗口（KV 已有底色/解锁窗/独立窗）上报一律忽略，不动底色也不结算', () => {
    const { win, setBackgroundColor } = fakeWindow(8)
    markThemedWindow(win as never)
    const onReport = vi.fn()
    // 没有 awaitRendererTheme 登记
    reportRendererTheme({ id: 8 } as never, 'light')
    expect(setBackgroundColor).not.toHaveBeenCalled()
    expect(onReport).not.toHaveBeenCalled()
  })

  it('登记了等待但窗口未打主题标记：只结算显示，不改底色', () => {
    const { win, setBackgroundColor } = fakeWindow(9)
    const onReport = vi.fn()
    awaitRendererTheme(win as never, onReport)

    reportRendererTheme({ id: 9 } as never, 'dark')
    expect(setBackgroundColor).not.toHaveBeenCalled()
    expect(onReport).toHaveBeenCalledTimes(1)
  })

  it('上报值非法按默认深色处理（与 normalizeUiTheme 同口径）', () => {
    const { win, setBackgroundColor } = fakeWindow(10)
    markThemedWindow(win as never)
    awaitRendererTheme(win as never, vi.fn())
    reportRendererTheme({ id: 10 } as never, 'bogus' as never)
    expect(setBackgroundColor).toHaveBeenLastCalledWith('#1e1e2e')
  })
})
