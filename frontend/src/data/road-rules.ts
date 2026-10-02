// 林区道路通行规则：巡检、施工、人工封闭三类来源共用这一份判定，
// 服务层和页面都从这里取，不再各自写一套状态映射。

/** 通行结论来源。「迁移回填」只在档案升级时出现，不参与日常提交。 */
export type PassageSource = '巡检' | '施工' | '人工封闭' | '迁移回填'

/** 通行状态按严格程度从宽到严排列，下标即严格等级。 */
export const PASSAGE_STATUS_ORDER = ['正常通行', '需维护', '正在施工', '禁止通行'] as const
export type PassageStatus = (typeof PASSAGE_STATUS_ORDER)[number]

/** 日常提交的来源（不含迁移回填）。 */
export type SubmissionSource = Exclude<PassageSource, '迁移回填'>

/** 各来源登记后对应的通行结论。 */
export const SOURCE_STATUS: Record<SubmissionSource, PassageStatus> = {
  巡检: '需维护',
  施工: '正在施工',
  人工封闭: '禁止通行',
}

// 同一严格等级冲突时的来源优先级：施工优先于巡检，人工封闭最高。
const SOURCE_PRIORITY: Record<PassageSource, number> = {
  迁移回填: 0,
  巡检: 1,
  施工: 2,
  人工封闭: 3,
}

export type PassageVerdict = {
  source: PassageSource
  status: PassageStatus
  reason: string
}

/** 追加进档案的一条通行历史：每次提交都留痕，包括未生效的。 */
export type PassageHistoryEntry = PassageVerdict & {
  at: string
  revision: number
  effective: boolean
}

export function severityOf(status: string): number {
  const index = PASSAGE_STATUS_ORDER.indexOf(status as PassageStatus)
  return index < 0 ? 0 : index
}

/**
 * 冲突判定：更严格的结论生效；同样严格时来源优先级高的生效
 * （施工优先于巡检；人工封闭与旧结论冲突时以更严格的为准）。
 * 返回 incoming 是否应当成为当前结论；未生效的提交也只进历史，不改结论。
 */
export function resolvePassage(current: PassageVerdict, incoming: PassageVerdict): boolean {
  const gap = severityOf(incoming.status) - severityOf(current.status)
  if (gap !== 0) {
    return gap > 0
  }
  return SOURCE_PRIORITY[incoming.source] > SOURCE_PRIORITY[current.source]
}
