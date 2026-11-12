// 「新界面 + 旧主进程」的统一提示（V4-Iter-475）
//
// 现场：dev 下主进程可能几天没重启，渲染层走 HMR 拿到新界面，于是每个新通道各报一句
// `No handler registered for 'agent:get-tool-surface'`，用户只看到一堆同名错误、不知道该干什么。
// 这里在启动时打一次握手：主进程回它这份包里认识的通道常量表，渲染层拿自己这份做差集。
//
// 三条纪律：
//  ① **只提示不阻断**：组件只写自己的 state，不挡任何模块渲染（失败时面板照旧可用）；
//  ② 握手本身失败（旧主进程没有 handler、或旧 preload 连方法都没有）也必须有可见失败面，
//     不许空 catch，也不许因为「怕吵」静默；
//  ③ 不把 `getAgentToolSurface` 之类的真实调用改成可选链——问题要在这里显形，而不是在那里消失。
import React, { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { errText } from '../utils/error'
import { handshakeChannelList, missingChannels } from '../../../shared/ipc-handshake'

/** 提示里最多列几个通道名：够定位方向，又不至于把一整屏塞满 */
const MAX_LISTED_CHANNELS = 3

export const MainProcessHandshakeNotice: React.FC = () => {
  const { t } = useI18n()
  const [missing, setMissing] = useState<string[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // 旧 preload 里连这个方法都没有：先认形状，再认调用结果。两者都要落到 failure 上。
    const bridge = window.pocketai
    if (typeof bridge?.mainHandshake !== 'function') {
      setFailure(t('common.mainHandshakeMissing'))
      return
    }
    try {
      void bridge
        .mainHandshake()
        .then((reply) => {
          if (!alive) return
          if (!reply || !Array.isArray(reply.channels)) {
            setFailure(t('common.mainHandshakeMissing'))
            return
          }
          const diff = missingChannels(handshakeChannelList(), reply.channels)
          setMissing(diff.length > 0 ? diff : null)
        })
        .catch((e: unknown) => {
          if (alive) setFailure(errText(e, t('common.unknownError')))
        })
    } catch (e) {
      // 旧 preload 的桥是同步抛（属性不存在时直接 TypeError），同样要显示出来
      setFailure(errText(e, t('common.unknownError')))
    }
    return () => {
      alive = false
    }
  }, [t])

  if (missing) {
    const shown = missing.slice(0, MAX_LISTED_CHANNELS).join(', ')
    const channels = missing.length > MAX_LISTED_CHANNELS ? `${shown} …` : shown
    return (
      <div
        role="alert"
        className="mx-3 mt-2 text-xs px-3 py-2 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger)] leading-relaxed"
      >
        {t('common.mainStale', { n: missing.length, channels })}
      </div>
    )
  }
  if (failure) {
    return (
      <div
        role="alert"
        className="mx-3 mt-2 text-xs px-3 py-2 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger)] leading-relaxed"
      >
        {t('common.mainHandshakeFailed', { msg: failure })}
      </div>
    )
  }
  return null
}
