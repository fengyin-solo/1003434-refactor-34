import { PASSAGE_STATUS_ORDER, type PassageHistoryEntry, type PassageStatus } from './road-rules'
import type { EntryRow } from './types'

// 林区道路档案迁移：旧字段（v1，「通行状态」单字段）升级到 v2。
// 原则：只增不改——旧字段原样保留，新字段按采集顺序回填，历史走追加，不做一次覆盖。

export const ROAD_MODULE_KEY = 'forestroad'

/** 档案版本号：1 为旧字段档案，2 为现行版本。 */
export const ROAD_ARCHIVE_VERSION = 2

function isPassageStatus(value: string): value is PassageStatus {
  return (PASSAGE_STATUS_ORDER as readonly string[]).includes(value)
}

/**
 * 把存量道路从旧档案升级到 v2，按数组顺序（即采集顺序）回填「采集序号」。
 * 已是最新版本的行原样返回，迁移可重复执行。
 */
export function migrateRoadRows(
  rows: EntryRow[],
  now: Date = new Date(),
): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const migrated = rows.map((row, index) => {
    if (Number(row['档案版本'] ?? 1) >= ROAD_ARCHIVE_VERSION) {
      return row
    }
    changed = true
    const status = String(row.status)
    const legacyStatus = String(row['通行状态'] ?? status)
    const history: PassageHistoryEntry[] = [
      {
        at: now.toISOString(),
        revision: 1,
        source: '迁移回填',
        status: isPassageStatus(status) ? status : '正常通行',
        reason: `档案迁移：旧通行状态「${legacyStatus}」转入历史，旧字段保留不覆盖`,
        effective: true,
      },
    ]
    return {
      ...row, // 旧字段（含「通行状态」）全部保留，迁移只增不改
      采集序号: Number(row['采集序号'] ?? index + 1),
      档案版本: ROAD_ARCHIVE_VERSION,
      版本号: 1,
      结论来源: '迁移回填',
      封闭原因: row['封闭原因'] ?? (status === '禁止通行' ? '历史封闭，迁移前未记录原因' : ''),
      通行历史: JSON.stringify(history),
    }
  })
  return { rows: migrated, changed }
}

/** 读出档案里的通行历史；存的是 JSON 串，坏了就当没有历史，不影响主流程。 */
export function readRoadHistory(row: EntryRow): PassageHistoryEntry[] {
  try {
    const parsed = JSON.parse(String(row['通行历史'] ?? '[]')) as unknown
    return Array.isArray(parsed) ? (parsed as PassageHistoryEntry[]) : []
  } catch {
    return []
  }
}

/** 追加一条通行历史，返回新行；历史只增不删。 */
export function appendRoadHistory(row: EntryRow, entry: PassageHistoryEntry): EntryRow {
  return { ...row, 通行历史: JSON.stringify([...readRoadHistory(row), entry]) }
}
