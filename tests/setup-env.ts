// §299 测试全局 setup：把 @testing-library 的 asyncUtilTimeout 默认值从 1000ms 抬到 8000ms。
//
// 为什么是这一处而不是逐文件补 MOUNT_BUDGET：findBy*/waitFor 的默认预算走的是 testing-library
// 自己的 asyncUtilTimeout，与 vitest 的 testTimeout 是两条独立尺子；全仓 65 份 jsdom 文件里
// 等"挂载读链"（getUiPrefs→listConversations→…才渲染出来的元素）的用例在满载 240 isolate worker
// 抢机器时会被饿到 >1s，于是每趟全量都从这 65 份里逮到不同的一份红（§295→282＋237、§298→228）。
// 一处抬默认值 = 覆盖全部现有与未来文件；负向断言（toBeNull/toBe(false) 那类初值即满足的）不受影响，
// 真挂死仍会在 8s（findBy）／20s（vitest testTimeout）超时红，只是慢一点，不会被掩盖成"过"。
//
// 只在 jsdom 环境装：node 文件不引 @testing-library，动态 import 跳过它们，不污染 200+ 条纯逻辑用例。
export {} // 让本文件成为 ES module，顶层 await 才合法（tsc TS1375）

if (typeof window !== 'undefined') {
  const { configure } = await import('@testing-library/react')
  configure({ asyncUtilTimeout: 8000 })
}
