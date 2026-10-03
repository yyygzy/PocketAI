// 消息朗读 TTS：Web Speech API（speechSynthesis）本地语音合成，无外部依赖。
//
// 设计：
// - stripSpeechText 为纯函数（剥离 Markdown 标记），可单测，不碰浏览器 API
// - 全局单例：同一时间只朗读一条消息；新朗读顶替旧朗读；同条再点=停止
// - 播放态通过 subscribeSpeak 订阅（模块级 listener），组件卸载时按 id 精确停止
// - Chromium 长文本约 15s 后可能静默暂停：定时 resume 兜底
// - 无 speechSynthesis 环境（旧系统/无语音包）isTtsSupported()=false，调用方隐藏入口

/** 当前正在朗读的消息 id 状态 */
export type TtsState = { id: string } | null
type TtsListener = (state: TtsState) => void

/**
 * 剥离 Markdown 标记为适合朗读的纯文本：
 * 围栏代码块整块移除（朗读代码无意义）；图片移除；链接保留文字；
 * 标题/引用/列表前缀、强调标记、HTML 标签、表格管道去除；空白折叠。
 */
export function stripSpeechText(md: string): string {
  let s = md
  // 围栏代码块整块（```...```）
  s = s.replace(/```[\s\S]*?```/g, ' ')
  // 图片 ![alt](url)
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  // 链接 [text](url) → text
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 行内代码 `x` → x（术语保留读音）
  s = s.replace(/`([^`]*)`/g, '$1')
  // 标题前缀
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  // 引用前缀
  s = s.replace(/^\s*>\s?/gm, '')
  // 无序列表前缀
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  // 有序列表前缀
  s = s.replace(/^\s*\d+\.\s+/gm, '')
  // 粗体/斜体标记（**x** / __x__ / *x* / _x_）
  s = s.replace(/\*\*([^*]*)\*\*/g, '$1')
  s = s.replace(/__([^_]*)__/g, '$1')
  s = s.replace(/\*([^*]*)\*/g, '$1')
  s = s.replace(/_([^_]*)_/g, '$1')
  // HTML 标签
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  // 表格管道 / 分隔线
  s = s.replace(/\|/g, ' ')
  // 空白折叠：行内多空格合一；换行两侧空白吃掉；3+ 连续换行收敛为空一行
  s = s.replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return s
}

const listeners = new Set<TtsListener>()
let current: { id: string; utter: SpeechSynthesisUtterance } | null = null
let resumeTimer: ReturnType<typeof setInterval> | null = null

function emit(): void {
  const state: TtsState = current ? { id: current.id } : null
  for (const l of listeners) l(state)
}

function clearResumeTimer(): void {
  if (resumeTimer !== null) {
    clearInterval(resumeTimer)
    resumeTimer = null
  }
}

/** 环境是否支持语音合成 */
export function isTtsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** 订阅播放态变化；返回取消订阅函数 */
export function subscribeSpeak(cb: TtsListener): () => void {
  listeners.add(cb)
  cb(current ? { id: current.id } : null)
  return () => {
    listeners.delete(cb)
  }
}

/** 界面语言 → BCP47 前缀（zh/en/ja/ko 直接用作语音匹配前缀） */
function langPrefix(langHint?: string): string | null {
  if (langHint === 'zh' || langHint === 'en' || langHint === 'ja' || langHint === 'ko') return langHint
  return null
}

/** 按语言前缀挑选本地语音；无匹配返回 null（交系统默认） */
function pickVoice(prefix: string | null): SpeechSynthesisVoice | null {
  if (!prefix) return null
  const voices = window.speechSynthesis.getVoices()
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? null
}

/**
 * 朗读指定消息：先停掉当前朗读再开始。text 为空或环境不支持时静默忽略。
 * @param id 消息 id（播放态订阅与精确停止用）
 * @param text 已剥离 Markdown 的纯文本
 * @param langHint 界面语言（zh/en/ja/ko），用于挑选匹配的本地语音
 */
export function speak(id: string, text: string, langHint?: string): void {
  if (!isTtsSupported()) return
  const plain = text.trim()
  if (!plain) return
  window.speechSynthesis.cancel()
  clearResumeTimer()

  const prefix = langPrefix(langHint)
  const utter = new SpeechSynthesisUtterance(plain)
  if (prefix) {
    utter.lang = prefix === 'zh' ? 'zh-CN' : prefix
    const voice = pickVoice(prefix)
    if (voice) utter.voice = voice
  }
  utter.rate = 1
  const entry = { id, utter }
  current = entry
  emit()

  const finish = () => {
    // 只清理自己（可能已被新朗读顶替）
    if (current === entry) {
      current = null
      clearResumeTimer()
      emit()
    }
  }
  utter.onend = finish
  utter.onerror = finish

  window.speechSynthesis.speak(utter)
  // Chromium 长文本暂停 bug：周期唤醒（speaking 但 paused 时 resume）
  resumeTimer = setInterval(() => {
    if (current !== entry) {
      clearResumeTimer()
      return
    }
    if (window.speechSynthesis.paused && window.speechSynthesis.speaking) {
      window.speechSynthesis.resume()
    }
  }, 10_000)
}

/**
 * 停止朗读。
 * @param id 传入时仅当正在朗读的是该 id 才停止（组件卸载精确清理）；不传无条件停止
 */
export function stop(id?: string): void {
  if (!isTtsSupported()) return
  if (id && current && current.id !== id) return
  window.speechSynthesis.cancel()
  clearResumeTimer()
  if (current) {
    current = null
    emit()
  }
}
