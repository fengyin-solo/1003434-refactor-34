<template>
  <section class="page" data-module="forestroad">
    <header class="page-head">
      <div>
        <h2>林区道路管理</h2>
        <p class="page-desc">维护林区道路，围绕道路编号、道路名称、起点位置、终点位置做登记、筛选与状态流转；通行结论按共用通行规则判定并留存历史。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记林区道路</button>
        <button class="btn" type="button" @click="exportRows">导出林区道路清单</button>
      </div>
    </header>

    <p v-if="archiveInfo.legacyCount > 0" class="archive-note">
      旧版档案已留存快照（{{ archiveInfo.legacyCount }} 条），当前为新版档案；历史封闭原因与通行状态见每行的「通行历史」。
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openHistory(row)">通行历史</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无林区道路数据，可先登记林区道路</td>
        </tr>
      </tbody>
    </table>

    <section v-if="historyRoad" class="history-panel">
      <header class="history-head">
        <strong>通行历史：{{ historyRoad['道路名称'] }}（{{ historyRoad['道路编号'] }}）</strong>
        <button class="link" type="button" @click="closeHistory">收起</button>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>版本</th>
            <th>来源</th>
            <th>结论</th>
            <th>封闭原因</th>
            <th>记录时间</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in historyRecords" :key="record.版本">
            <td>{{ record.版本 }}</td>
            <td>{{ record.来源 }}</td>
            <td>{{ record.结论 }}</td>
            <td>{{ record.封闭原因 || '—' }}</td>
            <td>{{ record.记录时间 }}</td>
            <td>{{ record.说明 }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条林区道路记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  roadArchiveInfo,
  roadHistory,
  runRoadAction,
} from '@/api/local-service'
import type { PassageRecord } from '@/data/passage-rule'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('forestroad')
const columns = ["道路编号", "道路名称", "起点位置", "终点位置", "道路等级", "通行宽度", "最近巡检日", "采集序号", "封闭原因", "结论来源"]
const actions = ["安排巡检", "登记施工", "封闭道路"]
const statuses = ["正常通行", "需维护", "正在施工", "禁止通行"]
const stats = [{"label": "道路总里程", "value": 0}, {"label": "需维护段数", "value": 0}, {"label": "施工段数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const archiveInfo = ref({ migrated: false, legacyCount: 0 })
const historyRoad = ref<EntryRow | null>(null)
const historyRecords = ref<PassageRecord[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '林区道路登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  let reason = ''
  if (action === '封闭道路') {
    const input = window.prompt('请填写封闭原因（会随结论一起落档留存）', String(row['封闭原因'] ?? ''))
    if (input === null) {
      return
    }
    reason = input
  }
  // 提交时带上页面读出时的结论版本：同一道路并发提交，只有版本对得上的那份生效。
  const result = runRoadAction(Number(row.id), action, Number(row['结论版本'] ?? 0), reason)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function openHistory(row: EntryRow) {
  historyRoad.value = row
  historyRecords.value = roadHistory(Number(row.id))
}

function closeHistory() {
  historyRoad.value = null
  historyRecords.value = []
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    archiveInfo.value = roadArchiveInfo()
    if (historyRoad.value) {
      historyRecords.value = roadHistory(Number(historyRoad.value.id))
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '林区道路列表读取失败'
  }
}

onMounted(reload)
</script>
