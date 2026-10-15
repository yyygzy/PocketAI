// `delegate_task` 的注册形状（V4-Iter-142 探针考察的就是这个形状）
//
// 注意一条不显然的事实：**引擎在 runToolsStep 里按名字截走这个工具，registry.execute 永远不会真跑到它**。
// 那为什么还要给 execute？—— 纵深防御：文本协议降级、IM 通道、以后新增的执行入口，任何一个如果直接
// 调 registry.execute('delegate_task')，都必须**明确失败**而不是"内置工具未执行"这种含糊话，
// 更不能因为找不到实现而把错误静默吞掉（V4-Iter-118 那轮"围栏被抽出来、写进库、却没人执行"就是这一族）。
import type { BuiltinTool } from './builtin'
import { DELEGATE_ROLES, DELEGATE_TASK_MAX_CHARS, DELEGATE_TOOL_ID, DELEGATE_TOOL_NAME } from '../../shared/delegation-rules'

export const delegateTaskTool: BuiltinTool = {
  schema: {
    id: DELEGATE_TOOL_ID,
    name: DELEGATE_TOOL_NAME,
    description:
      '把一项**可以独立完成、交付物明确**的工作交给一个子代理角色去做，等它做完把结果交回来。' +
      '子代理看不到这段对话的上下文，所以 task 要自带全部信息（要什么、给谁看、什么形态）。' +
      `role 只能取 ${DELEGATE_ROLES.join(' / ')}；能自己一步做完的事不要派——每次委派都会新起一段完整运行，` +
      '一轮编排的模型调用次数有上限，派多了会直接耗尽预算。',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: [...DELEGATE_ROLES],
          description: '子代理角色：researcher 取证 / writer 成文 / reviewer 审校'
        },
        task: {
          type: 'string',
          minLength: 1,
          maxLength: DELEGATE_TASK_MAX_CHARS,
          description: `交给该角色的完整任务（不超过 ${DELEGATE_TASK_MAX_CHARS} 字，含背景与交付形态）`
        }
      },
      required: ['role', 'task'],
      additionalProperties: false
    },
    source: 'builtin',
    // auto：委派本身不碰文件系统也不发消息，它只是多花一段模型时间；
    // 真正的闸门是"这台模型被用户点名允许委派"（delegate-prefs）与预算闸（delegation.ts）。
    permission: 'auto',
    // 截走路径不走 executeWithTimeout，这个值只是形状完整性的兜底：与父 run 的整轮超时同量级。
    timeoutMs: 5 * 60 * 1000
  },
  async execute(): Promise<string> {
    return 'DELEGATE_UNHANDLED: delegate_task 只能由 Agent 运行循环执行（这里被调用说明有新的执行入口没接上委派分支）'
  }
}
