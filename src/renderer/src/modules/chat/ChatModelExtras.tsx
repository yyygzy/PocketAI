// 对话壳顶栏的模型级徽标（P4 批次 0）：上下文窗口 / 备用模型链 / 文本协议。
//
// 对话壳是多目标模型，这里只给**主目标**（targets[0]）挂这三颗徽标：窗口与备用本来就是
// "这台模型"的属性，多目标时逐台编辑器会挤爆顶栏；主目标是实际第一发，改它即改主路径。
// 状态与读写来自宿主传入的 `useAgentModelExtras`（唯一实现），展示来自 `ModelExtrasBadges`
//（唯一实现）。宿主同时要把 extras 交给零调用提示用（`textProtocolForced` / 开启动作），
// 所以由 ChatModule 统一调一次 hook、这里不再自读一份，避免同一台模型被读两遍。
import React from 'react'
import type { ProviderRecord, ChatTarget } from '../../../../shared/types'
import { ModelExtrasBadges } from './ModelExtrasBadges'
import type { AgentModelExtras } from './useAgentModelExtras'

interface Props {
  providers: ProviderRecord[]
  targets: ChatTarget[]
  extras: AgentModelExtras
}

export const ChatModelExtras: React.FC<Props> = ({ providers, targets, extras }) => {
  const primary = targets[0]
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="chat-model-extras">
      <ModelExtrasBadges
        providers={providers}
        providerId={primary?.providerId ?? ''}
        model={primary?.model ?? ''}
        extras={extras}
      />
    </div>
  )
}
