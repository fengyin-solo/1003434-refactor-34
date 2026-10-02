import { freshRows, listRows, readBucket, saveRows, writeBucket } from '@/data/local-store'
import {
  ACTION_CONCLUSION,
  isBlocked,
  resolvePassage,
  type PassageRecord,
  type PassageStatus,
} from '@/data/passage-rule'
import type { ActionResult, EntryRow } from '@/data/types'

// 林区道路档案：v1 是旧字段（「通行状态」一个文本），v2 起改为
// 「采集序号 + 结论版本 + 追加式通行历史」。旧档案只留快照、不覆盖改写。
export const ROAD_ARCHIVE_VERSION = 2

const LEGACY_BUCKET = 'forestroad-legacy-v1' // 旧版档案快照：首次迁移时留存，之后不再动
const ARCHIVE_BUCKET = 'forestroad-archive' // 通行结论历史：按道路 id 只追加

type RoadArchive = Record<string, PassageRecord[]>

function roadRows(): EntryRow[] {
  return listRows('forestroad')
}

export function readRoadArchive(): RoadArchive {
  return readBucket<RoadArchive>(ARCHIVE_BUCKET) ?? {}
}

function writeRoadArchive(archive: RoadArchive): void {
  writeBucket(ARCHIVE_BUCKET, archive)
}

/** 旧版档案快照：已存在就直接返回，不会被再次覆盖。 */
export function legacySnapshot(): EntryRow[] | null {
  return readBucket<EntryRow[]>(LEGACY_BUCKET)
}

export function isMigrated(): boolean {
  const rows = roadRows()
  return rows.length > 0 && rows.every((row) => Number(row['档案版本']) === ROAD_ARCHIVE_VERSION)
}

/**
 * 旧档案迁移到新版本：
 * 1. 旧档案整体留一份快照，只留一次，之后不再覆盖；
 * 2. 存量道路按采集顺序（既有登记顺序）回填采集序号；
 * 3. 旧通行状态、封闭原因转成首条通行结论追加进历史，已有历史不动；
 * 4. 迁移完成后，巡护任务的巡护路线跟着重算。
 */
export function migrateRoadArchive(): boolean {
  if (isMigrated()) {
    return false
  }
  const rows = roadRows()
  if (legacySnapshot() === null) {
    writeBucket(LEGACY_BUCKET, JSON.parse(JSON.stringify(rows)))
  }
  const archive = readRoadArchive()
  const now = new Date().toISOString()
  const migrated = rows.map((row, index) => {
    const id = String(row.id)
    let history = archive[id]
    if (!history || history.length === 0) {
      // 旧档案里的通行状态与封闭原因原样落成首条结论，历史不丢。
      const oldStatus = String(row.status) as PassageStatus
      history = [
        {
          版本: 1,
          来源: '迁移回填',
          结论: oldStatus,
          封闭原因: String(
            row['封闭原因'] ?? (oldStatus === '禁止通行' ? String(row['通行状态'] ?? '') : ''),
          ),
          记录时间: now,
          说明: '旧档案迁移回填',
        },
      ]
      archive[id] = history
    }
    const effective = resolvePassage(history)
    return {
      ...row,
      status: effective ? effective.结论 : row.status,
      档案版本: ROAD_ARCHIVE_VERSION,
      采集序号: index + 1,
      封闭原因: effective && effective.结论 === '禁止通行' ? effective.封闭原因 : '',
      结论来源: effective ? effective.来源 : '迁移回填',
      结论版本: history[history.length - 1].版本,
    }
  })
  saveRows('forestroad', migrated)
  writeRoadArchive(archive)
  recalcPatrolRoutes()
  return true
}

/**
 * 提交一条通行结论：先比较结论版本再落档（比较并交换），
 * 同一条道路并发提交时，只有版本对得上的那一份生效，其余打回。
 */
export function submitRoadConclusion(
  roadId: number,
  action: string,
  expectedVersion: number,
  reason = '',
): ActionResult {
  migrateRoadArchive()
  const mapping = (ACTION_CONCLUSION as Record<string, { 来源: PassageRecord['来源']; 结论: PassageStatus }>)[
    action
  ]
  if (!mapping) {
    return { ok: false, message: `林区道路没有登记「${action}」这个动作` }
  }
  const rows = freshRows('forestroad')
  const index = rows.findIndex((row) => Number(row.id) === roadId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${roadId} 的林区道路` }
  }
  const current = rows[index]
  const currentVersion = Number(current['结论版本'] ?? 0)
  if (currentVersion !== expectedVersion) {
    return {
      ok: false,
      message: `这条林区道路已有新的通行结论（当前版本 ${currentVersion}），本次提交未生效，请刷新后重试`,
    }
  }
  const record: PassageRecord = {
    版本: currentVersion + 1,
    来源: mapping.来源,
    结论: mapping.结论,
    封闭原因: action === '封闭道路' ? reason.trim() : '',
    记录时间: new Date().toISOString(),
    说明: action,
  }
  const archive = readRoadArchive()
  const id = String(roadId)
  const history = [...(archive[id] ?? []), record]
  archive[id] = history
  const effective = resolvePassage(history) ?? record
  const updated: EntryRow = {
    ...current,
    status: effective.结论,
    pending: effective.结论 !== '禁止通行',
    abnormal: false,
    封闭原因: effective.结论 === '禁止通行' ? effective.封闭原因 : '',
    结论来源: effective.来源,
    结论版本: record.版本,
  }
  const next = [...rows]
  next[index] = updated
  saveRows('forestroad', next)
  writeRoadArchive(archive)
  recalcPatrolRoutes()
  const message =
    effective.版本 === record.版本
      ? `林区道路已${action}，当前状态「${effective.结论}」`
      : `林区道路已${action}并落档，按通行规则当前仍生效「${effective.结论}」（${effective.来源}）`
  return { ok: true, message }
}

/** 某条道路的通行历史，按落档顺序返回。 */
export function roadHistory(roadId: number): PassageRecord[] {
  return readRoadArchive()[String(roadId)] ?? []
}

export function roadArchiveInfo(): { migrated: boolean; legacyCount: number } {
  const legacy = legacySnapshot()
  return { migrated: isMigrated(), legacyCount: legacy ? legacy.length : 0 }
}

/**
 * 巡护路线重算：道路通行结论变化（含迁移）后，巡护任务里引用到
 * 受阻路段（正在施工、禁止通行）的路线，标出「需绕开」；恢复通行则清空。
 */
export function recalcPatrolRoutes(): void {
  const blocked = roadRows()
    .filter((row) => isBlocked(String(row.status) as PassageStatus))
    .map((row) => ({ 编号: String(row['道路编号'] ?? ''), 名称: String(row['道路名称'] ?? '') }))
  const patrols = listRows('patrol')
  let changed = false
  const next = patrols.map((row) => {
    const route = String(row['巡护路线'] ?? '')
    const hits = blocked.filter(
      (road) =>
        (road.编号 !== '' && route.includes(road.编号)) ||
        (road.名称 !== '' && route.includes(road.名称)),
    )
    const note = hits.length > 0 ? `需绕开：${hits.map((hit) => hit.名称 || hit.编号).join('、')}` : ''
    if (String(row['路线调整'] ?? '') === note) {
      return row
    }
    changed = true
    return { ...row, 路线调整: note }
  })
  if (changed) {
    saveRows('patrol', next)
  }
}
