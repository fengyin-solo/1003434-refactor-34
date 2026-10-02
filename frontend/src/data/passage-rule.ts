// 林区道路的共用通行规则：巡检、施工、人工封闭三类判断都走这一份，
// 页面和其它模块不再各自写判定逻辑。

/** 通行结论，按严格程度从宽到严排列。 */
export const PASSAGE_STATUSES = ['正常通行', '需维护', '正在施工', '禁止通行'] as const
export type PassageStatus = (typeof PASSAGE_STATUSES)[number]

/** 结论来源，同级冲突时优先级从低到高：迁移回填 < 巡检 < 施工 < 人工封闭。 */
export const PASSAGE_SOURCES = ['迁移回填', '巡检', '施工', '人工封闭'] as const
export type PassageSource = (typeof PASSAGE_SOURCES)[number]

/** 一条落档的通行结论：只追加、不改写，历史封闭原因和通行状态都留在这里。 */
export type PassageRecord = {
  版本: number
  来源: PassageSource
  结论: PassageStatus
  封闭原因: string
  记录时间: string
  说明: string
}

const SEVERITY: Record<PassageStatus, number> = {
  正常通行: 0,
  需维护: 1,
  正在施工: 2,
  禁止通行: 3,
}

const SOURCE_RANK: Record<PassageSource, number> = {
  迁移回填: 0,
  巡检: 1,
  施工: 2,
  人工封闭: 3,
}

/** 道路动作到结论的固定映射，三种动作共用同一张表。 */
export const ROAD_ACTIONS = ['安排巡检', '登记施工', '封闭道路'] as const
export type RoadAction = (typeof ROAD_ACTIONS)[number]

export const ACTION_CONCLUSION: Record<RoadAction, { 来源: PassageSource; 结论: PassageStatus }> = {
  安排巡检: { 来源: '巡检', 结论: '需维护' },
  登记施工: { 来源: '施工', 结论: '正在施工' },
  封闭道路: { 来源: '人工封闭', 结论: '禁止通行' },
}

/**
 * 冲突裁决：先比严格程度（禁止通行 > 正在施工 > 需维护 > 正常通行），
 * 同级再比来源优先级（人工封闭 > 施工 > 巡检 > 迁移回填），最后比版本新旧。
 * 也就是：施工优先于巡检；人工封闭冲突时以更严格的结论为准。
 */
export function comparePassage(a: PassageRecord, b: PassageRecord): number {
  if (SEVERITY[a.结论] !== SEVERITY[b.结论]) {
    return SEVERITY[a.结论] - SEVERITY[b.结论]
  }
  if (SOURCE_RANK[a.来源] !== SOURCE_RANK[b.来源]) {
    return SOURCE_RANK[a.来源] - SOURCE_RANK[b.来源]
  }
  return a.版本 - b.版本
}

/** 从结论历史里挑出当前生效的一条；没有记录时返回 null。 */
export function resolvePassage(records: PassageRecord[]): PassageRecord | null {
  let winner: PassageRecord | null = null
  for (const record of records) {
    if (winner === null || comparePassage(record, winner) > 0) {
      winner = record
    }
  }
  return winner
}

/** 巡护路线重算用的通行面：正在施工、禁止通行的路段都算受阻。 */
export function isBlocked(status: PassageStatus): boolean {
  return SEVERITY[status] >= SEVERITY['正在施工']
}
