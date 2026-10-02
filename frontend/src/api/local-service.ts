import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { ROAD_MODULE_KEY, appendRoadHistory, migrateRoadRows } from '@/data/road-archive'
import {
  SOURCE_STATUS,
  resolvePassage,
  type PassageSource,
  type PassageStatus,
  type SubmissionSource,
} from '@/data/road-rules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 林区道路的动作不再是各自的状态映射，统一折算成通行规则的来源。
const ROAD_ACTION_SOURCE: Record<string, SubmissionSource> = {
  安排巡检: '巡检',
  登记施工: '施工',
  封闭道路: '人工封闭',
}

// 道路结论变化会影响巡护路线，这些状态视为「路不通」。
const ROUTE_BLOCKING_STATUSES = ['正在施工', '禁止通行']

// 档案迁移 + 巡护路线重算：任何入口读写数据前，先保证道路档案已是新版本、路线已重算。
// 迁移按行幂等（看「档案版本」），重算自带变更检测，重复调用是空操作。
function ensureRoadArchiveCurrent(): void {
  const { rows: migrated, changed } = migrateRoadRows(listRows(ROAD_MODULE_KEY))
  if (changed) {
    saveRows(ROAD_MODULE_KEY, migrated)
  }
  recalcPatrolRoutes()
}

// 道路通行结论变化后，引用到这些道路的巡护路线跟着重算。
function recalcPatrolRoutes(): void {
  const blocked = listRows(ROAD_MODULE_KEY).filter((road) =>
    ROUTE_BLOCKING_STATUSES.includes(String(road.status)),
  )
  const patrols = listRows('patrol')
  let touched = false
  const next = patrols.map((task) => {
    const route = `${task['巡护区域'] ?? ''}${task['巡护路线'] ?? ''}`
    const hits = blocked.filter(
      (road) =>
        route.includes(String(road['道路编号'] ?? '')) ||
        route.includes(String(road['道路名称'] ?? '')),
    )
    const result = hits.length
      ? `需绕行：${hits.map((road) => `${road['道路编号']} ${road.status}`).join('、')}`
      : '通行正常'
    const abnormal = hits.length > 0
    if (task['路线重算结果'] === result && task.abnormal === abnormal) {
      return task
    }
    touched = true
    return { ...task, 路线重算结果: result, abnormal, pending: task.pending || abnormal }
  })
  if (touched) {
    saveRows('patrol', next)
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  ensureRoadArchiveCurrent()
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export type VerdictOptions = {
  /** 提交时看到的道路「版本号」；与当前版本不一致说明已有并发提交生效。 */
  expectedRevision?: number
  /** 封闭原因等说明，会写进通行历史。 */
  reason?: string
}

/**
 * 提交一条道路通行结论（巡检 / 施工 / 人工封闭）。
 * 并发守卫：同一条道路只认基于最新「版本号」的提交，过期版本直接拒绝，
 * 保证并发提交时只有一个结论生效。每次提交无论生效与否都追加进通行历史。
 */
export function submitPassageVerdict(
  id: number,
  source: SubmissionSource,
  options: VerdictOptions = {},
): ActionResult {
  ensureRoadArchiveCurrent()
  const rows = listRows(ROAD_MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的林区道路` }
  }
  const row = rows[index]
  const revision = Number(row['版本号'] ?? 1)
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
    return {
      ok: false,
      message: `该道路已有其他提交生效（当前版本 ${revision}），本次提交未生效，请刷新后重试`,
    }
  }
  const incoming = {
    source,
    status: SOURCE_STATUS[source],
    reason: options.reason?.trim() || '未填写原因',
  }
  const current = {
    source: String(row['结论来源'] ?? '迁移回填') as PassageSource,
    status: String(row.status) as PassageStatus,
    reason: String(row['封闭原因'] ?? ''),
  }
  const effective = resolvePassage(current, incoming)
  const nextRevision = revision + 1
  let updated: EntryRow = { ...row, 版本号: nextRevision }
  if (source === '巡检') {
    updated['最近巡检日'] = new Date().toISOString().slice(0, 10)
  }
  if (effective) {
    updated = {
      ...updated,
      status: incoming.status,
      结论来源: source,
      封闭原因: source === '人工封闭' ? incoming.reason : (row['封闭原因'] ?? ''),
      pending: incoming.status !== '正常通行',
      abnormal: incoming.status === '禁止通行',
    }
  }
  updated = appendRoadHistory(updated, {
    ...incoming,
    at: new Date().toISOString(),
    revision: nextRevision,
    effective,
  })
  const next = [...rows]
  next[index] = updated
  saveRows(ROAD_MODULE_KEY, next)
  recalcPatrolRoutes()
  const note = effective
    ? `当前状态「${updated.status}」`
    : `与现有结论冲突，以更严格的「${row.status}」为准，本次仅记入历史`
  return { ok: true, message: `林区道路已登记${source}结论，${note}` }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: VerdictOptions = {},
): ActionResult {
  ensureRoadArchiveCurrent()
  const meta = moduleMeta(key)
  const roadSource = key === ROAD_MODULE_KEY ? ROAD_ACTION_SOURCE[action] : undefined
  if (roadSource) {
    return submitPassageVerdict(id, roadSource, options)
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  ensureRoadArchiveCurrent()
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  ensureRoadArchiveCurrent()
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
