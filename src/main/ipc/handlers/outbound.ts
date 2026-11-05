// 出网清单（只读）
//
// 清单本身来自 net/outbound-registry.ts（覆盖测试盯住调用点），这里只负责把
// 注册表 + 从现有配置仓储解析出的当前真实地址交给渲染端；没有写入通道。
import { IPC } from '../../../shared/types'
import { getOutboundEntriesView } from '../../net/outbound-registry'
import { safeHandle } from '../safe-handle'

export function registerOutboundHandlers(): void {
  safeHandle(IPC.OUTBOUND_GET, () => getOutboundEntriesView())
}
