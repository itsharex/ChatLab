/**
 * 高级分析查询模块
 * 提供复读、口头禅、夜猫、龙王等复杂分析
 */

import { openDatabase, buildTimeFilter, buildSystemMessageFilter, type TimeFilter } from './dbCore'

// ==================== 复读分析 ====================

/**
 * 获取复读分析数据
 */
export function getRepeatAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  const emptyResult = {
    originators: [],
    initiators: [],
    breakers: [],
    originatorRates: [],
    initiatorRates: [],
    breakerRates: [],
    chainLengthDistribution: [],
    hotContents: [],
    avgChainLength: 0,
    totalRepeatChains: 0,
  }

  if (!db) return emptyResult

  const { clause, params } = buildTimeFilter(filter)

  let whereClause = clause
  if (whereClause.includes('WHERE')) {
    whereClause += " AND m.name != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL AND TRIM(msg.content) != ''"
  } else {
    whereClause = " WHERE m.name != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL AND TRIM(msg.content) != ''"
  }

  const messages = db
    .prepare(
      `
        SELECT
          msg.id,
          msg.sender_id as senderId,
          msg.content,
          msg.ts,
          m.platform_id as platformId,
          m.name
        FROM message msg
        JOIN member m ON msg.sender_id = m.id
        ${whereClause}
        ORDER BY msg.ts ASC, msg.id ASC
      `
    )
    .all(...params) as Array<{
    id: number
    senderId: number
    content: string
    ts: number
    platformId: string
    name: string
  }>

  const originatorCount = new Map<number, number>()
  const initiatorCount = new Map<number, number>()
  const breakerCount = new Map<number, number>()
  const memberMessageCount = new Map<number, number>()
  const memberInfo = new Map<number, { platformId: string; name: string }>()
  const chainLengthCount = new Map<number, number>()
  const contentStats = new Map<
    string,
    { count: number; maxChainLength: number; originatorId: number; lastTs: number }
  >()

  let currentContent: string | null = null
  let repeatChain: Array<{ senderId: number; content: string; ts: number }> = []
  let totalRepeatChains = 0
  let totalChainLength = 0

  const processRepeatChain = (chain: Array<{ senderId: number; content: string; ts: number }>, breakerId?: number) => {
    if (chain.length < 3) return

    totalRepeatChains++
    const chainLength = chain.length
    totalChainLength += chainLength

    const originatorId = chain[0].senderId
    originatorCount.set(originatorId, (originatorCount.get(originatorId) || 0) + 1)

    const initiatorId = chain[1].senderId
    initiatorCount.set(initiatorId, (initiatorCount.get(initiatorId) || 0) + 1)

    if (breakerId !== undefined) {
      breakerCount.set(breakerId, (breakerCount.get(breakerId) || 0) + 1)
    }

    chainLengthCount.set(chainLength, (chainLengthCount.get(chainLength) || 0) + 1)

    const content = chain[0].content
    const chainTs = chain[0].ts
    const existing = contentStats.get(content)
    if (existing) {
      existing.count++
      existing.lastTs = Math.max(existing.lastTs, chainTs)
      if (chainLength > existing.maxChainLength) {
        existing.maxChainLength = chainLength
        existing.originatorId = originatorId
      }
    } else {
      contentStats.set(content, { count: 1, maxChainLength: chainLength, originatorId, lastTs: chainTs })
    }

    // 计算反应时间 (Fastest Follower)
    // 从第二个消息开始，计算与前一条消息的时间差
    for (let i = 1; i < chain.length; i++) {
      const currentMsg = chain[i]
      const prevMsg = chain[i - 1]
      const diff = (currentMsg.ts - prevMsg.ts) * 1000 // 毫秒

      // 只统计 60 秒内的复读，排除间隔过久的“伪复读”
      if (diff <= 60 * 1000) {
        if (!fastestRepeaterStats.has(currentMsg.senderId)) {
          fastestRepeaterStats.set(currentMsg.senderId, { totalDiff: 0, count: 0 })
        }
        const stats = fastestRepeaterStats.get(currentMsg.senderId)!
        stats.totalDiff += diff
        stats.count++
      }
    }
  }

  const fastestRepeaterStats = new Map<number, { totalDiff: number; count: number }>()

  for (const msg of messages) {
    if (!memberInfo.has(msg.senderId)) {
      memberInfo.set(msg.senderId, { platformId: msg.platformId, name: msg.name })
    }

    memberMessageCount.set(msg.senderId, (memberMessageCount.get(msg.senderId) || 0) + 1)

    const content = msg.content.trim()

    if (content === currentContent) {
      const lastSender = repeatChain[repeatChain.length - 1]?.senderId
      if (lastSender !== msg.senderId) {
        repeatChain.push({ senderId: msg.senderId, content, ts: msg.ts })
      }
    } else {
      processRepeatChain(repeatChain, msg.senderId)

      currentContent = content
      repeatChain = [{ senderId: msg.senderId, content, ts: msg.ts }]
    }
  }

  processRepeatChain(repeatChain)

  const buildRankList = (countMap: Map<number, number>, total: number): any[] => {
    const items: any[] = []
    for (const [memberId, count] of countMap.entries()) {
      const info = memberInfo.get(memberId)
      if (info) {
        items.push({
          memberId,
          platformId: info.platformId,
          name: info.name,
          count,
          percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
        })
      }
    }
    return items.sort((a, b) => b.count - a.count)
  }

  const buildRateList = (countMap: Map<number, number>): any[] => {
    const items: any[] = []
    for (const [memberId, count] of countMap.entries()) {
      const info = memberInfo.get(memberId)
      const totalMessages = memberMessageCount.get(memberId) || 0
      if (info && totalMessages > 0) {
        items.push({
          memberId,
          platformId: info.platformId,
          name: info.name,
          count,
          totalMessages,
          rate: Math.round((count / totalMessages) * 10000) / 100,
        })
      }
    }
    return items.sort((a, b) => b.rate - a.rate)
  }

  const buildFastestList = (): any[] => {
    const items: any[] = []
    for (const [memberId, stats] of fastestRepeaterStats.entries()) {
      // 过滤掉偶尔复读的人，至少参与5次复读才统计，避免数据偏差
      if (stats.count < 5) continue

      const info = memberInfo.get(memberId)
      if (info) {
        items.push({
          memberId,
          platformId: info.platformId,
          name: info.name,
          count: stats.count,
          avgTimeDiff: Math.round(stats.totalDiff / stats.count),
        })
      }
    }
    return items.sort((a, b) => a.avgTimeDiff - b.avgTimeDiff) // 越快越好
  }

  const chainLengthDistribution: any[] = []
  for (const [length, count] of chainLengthCount.entries()) {
    chainLengthDistribution.push({ length, count })
  }
  chainLengthDistribution.sort((a, b) => a.length - b.length)

  const hotContents: any[] = []
  for (const [content, stats] of contentStats.entries()) {
    const originatorInfo = memberInfo.get(stats.originatorId)
    hotContents.push({
      content,
      count: stats.count,
      maxChainLength: stats.maxChainLength,
      originatorName: originatorInfo?.name || '未知',
      lastTs: stats.lastTs,
    })
  }
  hotContents.sort((a, b) => b.maxChainLength - a.maxChainLength)
  const top50HotContents = hotContents.slice(0, 50)

  return {
    originators: buildRankList(originatorCount, totalRepeatChains),
    initiators: buildRankList(initiatorCount, totalRepeatChains),
    breakers: buildRankList(breakerCount, totalRepeatChains),
    fastestRepeaters: buildFastestList(),
    originatorRates: buildRateList(originatorCount),
    initiatorRates: buildRateList(initiatorCount),
    breakerRates: buildRateList(breakerCount),
    chainLengthDistribution,
    hotContents: top50HotContents,
    avgChainLength: totalRepeatChains > 0 ? Math.round((totalChainLength / totalRepeatChains) * 100) / 100 : 0,
    totalRepeatChains,
  }
}

// ==================== 口头禅分析 ====================

/**
 * 获取口头禅分析数据
 */
export function getCatchphraseAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  if (!db) return { members: [] }

  const { clause, params } = buildTimeFilter(filter)

  let whereClause = clause
  if (whereClause.includes('WHERE')) {
    whereClause +=
      " AND m.name != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL AND LENGTH(TRIM(msg.content)) >= 2"
  } else {
    whereClause =
      " WHERE m.name != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL AND LENGTH(TRIM(msg.content)) >= 2"
  }

  const rows = db
    .prepare(
      `
        SELECT
          m.id as memberId,
          m.platform_id as platformId,
          m.name,
          TRIM(msg.content) as content,
          COUNT(*) as count
        FROM message msg
        JOIN member m ON msg.sender_id = m.id
        ${whereClause}
        GROUP BY m.id, TRIM(msg.content)
        ORDER BY m.id, count DESC
      `
    )
    .all(...params) as Array<{
    memberId: number
    platformId: string
    name: string
    content: string
    count: number
  }>

  const memberMap = new Map<
    number,
    {
      memberId: number
      platformId: string
      name: string
      catchphrases: Array<{ content: string; count: number }>
    }
  >()

  for (const row of rows) {
    if (!memberMap.has(row.memberId)) {
      memberMap.set(row.memberId, {
        memberId: row.memberId,
        platformId: row.platformId,
        name: row.name,
        catchphrases: [],
      })
    }

    const member = memberMap.get(row.memberId)!
    if (member.catchphrases.length < 5) {
      member.catchphrases.push({
        content: row.content,
        count: row.count,
      })
    }
  }

  const members = Array.from(memberMap.values())
  members.sort((a, b) => {
    const aTotal = a.catchphrases.reduce((sum, c) => sum + c.count, 0)
    const bTotal = b.catchphrases.reduce((sum, c) => sum + c.count, 0)
    return bTotal - aTotal
  })

  return { members }
}

// ==================== 夜猫分析 ====================

/**
 * 根据深夜发言数获取称号
 */
function getNightOwlTitleByCount(count: number): string {
  if (count === 0) return '养生达人'
  if (count <= 20) return '偶尔失眠'
  if (count <= 50) return '经常失眠'
  if (count <= 100) return '夜猫子'
  if (count <= 200) return '秃头预备役'
  if (count <= 500) return '修仙练习生'
  return '守夜冠军'
}

/**
 * 将时间戳转换为"调整后的日期"（以凌晨5点为界）
 */
function getAdjustedDate(ts: number): string {
  const date = new Date(ts * 1000)
  const hour = date.getHours()

  if (hour < 5) {
    date.setDate(date.getDate() - 1)
  }

  return date.toISOString().split('T')[0]
}

/**
 * 格式化分钟数为 HH:MM
 */
function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

/**
 * 获取夜猫分析数据
 */
export function getNightOwlAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  const emptyResult = {
    nightOwlRank: [],
    lastSpeakerRank: [],
    firstSpeakerRank: [],
    consecutiveRecords: [],
    champions: [],
    totalDays: 0,
  }

  if (!db) return emptyResult

  const { clause, params } = buildTimeFilter(filter)
  const clauseWithSystem = buildSystemMessageFilter(clause)

  const messages = db
    .prepare(
      `
        SELECT
          msg.id,
          msg.sender_id as senderId,
          msg.ts,
          m.platform_id as platformId,
          m.name
        FROM message msg
        JOIN member m ON msg.sender_id = m.id
        ${clauseWithSystem}
        ORDER BY msg.ts ASC
      `
    )
    .all(...params) as Array<{
    id: number
    senderId: number
    ts: number
    platformId: string
    name: string
  }>

  if (messages.length === 0) return emptyResult

  const memberInfo = new Map<number, { platformId: string; name: string }>()
  const nightStats = new Map<
    number,
    {
      total: number
      h23: number
      h0: number
      h1: number
      h2: number
      h3to4: number
      totalMessages: number
    }
  >()
  const dailyMessages = new Map<string, Array<{ senderId: number; ts: number; hour: number; minute: number }>>()
  const memberNightDays = new Map<number, Set<string>>()

  for (const msg of messages) {
    if (!memberInfo.has(msg.senderId)) {
      memberInfo.set(msg.senderId, { platformId: msg.platformId, name: msg.name })
    }

    const date = new Date(msg.ts * 1000)
    const hour = date.getHours()
    const minute = date.getMinutes()
    const adjustedDate = getAdjustedDate(msg.ts)

    if (!nightStats.has(msg.senderId)) {
      nightStats.set(msg.senderId, { total: 0, h23: 0, h0: 0, h1: 0, h2: 0, h3to4: 0, totalMessages: 0 })
    }
    const stats = nightStats.get(msg.senderId)!
    stats.totalMessages++

    if (hour === 23) {
      stats.h23++
      stats.total++
    } else if (hour === 0) {
      stats.h0++
      stats.total++
    } else if (hour === 1) {
      stats.h1++
      stats.total++
    } else if (hour === 2) {
      stats.h2++
      stats.total++
    } else if (hour >= 3 && hour < 5) {
      stats.h3to4++
      stats.total++
    }

    if (hour >= 23 || hour < 5) {
      if (!memberNightDays.has(msg.senderId)) {
        memberNightDays.set(msg.senderId, new Set())
      }
      memberNightDays.get(msg.senderId)!.add(adjustedDate)
    }

    if (!dailyMessages.has(adjustedDate)) {
      dailyMessages.set(adjustedDate, [])
    }
    dailyMessages.get(adjustedDate)!.push({ senderId: msg.senderId, ts: msg.ts, hour, minute })
  }

  const totalDays = dailyMessages.size

  // 构建修仙排行榜
  const nightOwlRank: any[] = []
  for (const [memberId, stats] of nightStats.entries()) {
    if (stats.total === 0) continue
    const info = memberInfo.get(memberId)!
    nightOwlRank.push({
      memberId,
      platformId: info.platformId,
      name: info.name,
      totalNightMessages: stats.total,
      title: getNightOwlTitleByCount(stats.total),
      hourlyBreakdown: {
        h23: stats.h23,
        h0: stats.h0,
        h1: stats.h1,
        h2: stats.h2,
        h3to4: stats.h3to4,
      },
      percentage: stats.totalMessages > 0 ? Math.round((stats.total / stats.totalMessages) * 10000) / 100 : 0,
    })
  }
  nightOwlRank.sort((a, b) => b.totalNightMessages - a.totalNightMessages)

  // 最晚/最早发言
  const lastSpeakerStats = new Map<number, { count: number; times: number[] }>()
  const firstSpeakerStats = new Map<number, { count: number; times: number[] }>()

  for (const [, dayMessages] of dailyMessages.entries()) {
    if (dayMessages.length === 0) continue

    const lastMsg = dayMessages[dayMessages.length - 1]
    if (!lastSpeakerStats.has(lastMsg.senderId)) {
      lastSpeakerStats.set(lastMsg.senderId, { count: 0, times: [] })
    }
    const lastStats = lastSpeakerStats.get(lastMsg.senderId)!
    lastStats.count++
    lastStats.times.push(lastMsg.hour * 60 + lastMsg.minute)

    const firstMsg = dayMessages[0]
    if (!firstSpeakerStats.has(firstMsg.senderId)) {
      firstSpeakerStats.set(firstMsg.senderId, { count: 0, times: [] })
    }
    const firstStats = firstSpeakerStats.get(firstMsg.senderId)!
    firstStats.count++
    firstStats.times.push(firstMsg.hour * 60 + firstMsg.minute)
  }

  // 构建排行
  const lastSpeakerRank: any[] = []
  for (const [memberId, stats] of lastSpeakerStats.entries()) {
    const info = memberInfo.get(memberId)!
    const avgMinutes = stats.times.reduce((a, b) => a + b, 0) / stats.times.length
    const maxMinutes = Math.max(...stats.times)
    lastSpeakerRank.push({
      memberId,
      platformId: info.platformId,
      name: info.name,
      count: stats.count,
      avgTime: formatMinutes(avgMinutes),
      extremeTime: formatMinutes(maxMinutes),
      percentage: totalDays > 0 ? Math.round((stats.count / totalDays) * 10000) / 100 : 0,
    })
  }
  lastSpeakerRank.sort((a, b) => b.count - a.count)

  const firstSpeakerRank: any[] = []
  for (const [memberId, stats] of firstSpeakerStats.entries()) {
    const info = memberInfo.get(memberId)!
    const avgMinutes = stats.times.reduce((a, b) => a + b, 0) / stats.times.length
    const minMinutes = Math.min(...stats.times)
    firstSpeakerRank.push({
      memberId,
      platformId: info.platformId,
      name: info.name,
      count: stats.count,
      avgTime: formatMinutes(avgMinutes),
      extremeTime: formatMinutes(minMinutes),
      percentage: totalDays > 0 ? Math.round((stats.count / totalDays) * 10000) / 100 : 0,
    })
  }
  firstSpeakerRank.sort((a, b) => b.count - a.count)

  // 连续修仙天数
  const consecutiveRecords: any[] = []

  for (const [memberId, nightDaysSet] of memberNightDays.entries()) {
    if (nightDaysSet.size === 0) continue

    const info = memberInfo.get(memberId)!
    const sortedDays = Array.from(nightDaysSet).sort()

    let maxStreak = 1
    let currentStreak = 1

    for (let i = 1; i < sortedDays.length; i++) {
      const prevDate = new Date(sortedDays[i - 1])
      const currDate = new Date(sortedDays[i])
      const diffDays = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)

      if (diffDays === 1) {
        currentStreak++
        maxStreak = Math.max(maxStreak, currentStreak)
      } else {
        currentStreak = 1
      }
    }

    const lastDay = sortedDays[sortedDays.length - 1]
    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
    const isCurrentStreak = lastDay === today || lastDay === yesterday

    consecutiveRecords.push({
      memberId,
      platformId: info.platformId,
      name: info.name,
      maxConsecutiveDays: maxStreak,
      currentStreak: isCurrentStreak ? currentStreak : 0,
    })
  }
  consecutiveRecords.sort((a, b) => b.maxConsecutiveDays - a.maxConsecutiveDays)

  // 综合排名
  const championScores = new Map<number, { nightMessages: number; lastSpeakerCount: number; consecutiveDays: number }>()

  for (const item of nightOwlRank) {
    if (!championScores.has(item.memberId)) {
      championScores.set(item.memberId, { nightMessages: 0, lastSpeakerCount: 0, consecutiveDays: 0 })
    }
    championScores.get(item.memberId)!.nightMessages = item.totalNightMessages
  }

  for (const item of lastSpeakerRank) {
    if (!championScores.has(item.memberId)) {
      championScores.set(item.memberId, { nightMessages: 0, lastSpeakerCount: 0, consecutiveDays: 0 })
    }
    championScores.get(item.memberId)!.lastSpeakerCount = item.count
  }

  for (const item of consecutiveRecords) {
    if (!championScores.has(item.memberId)) {
      championScores.set(item.memberId, { nightMessages: 0, lastSpeakerCount: 0, consecutiveDays: 0 })
    }
    championScores.get(item.memberId)!.consecutiveDays = item.maxConsecutiveDays
  }

  const champions: any[] = []
  for (const [memberId, scores] of championScores.entries()) {
    const info = memberInfo.get(memberId)!
    const score = scores.nightMessages * 1 + scores.lastSpeakerCount * 10 + scores.consecutiveDays * 20
    if (score > 0) {
      champions.push({
        memberId,
        platformId: info.platformId,
        name: info.name,
        score,
        nightMessages: scores.nightMessages,
        lastSpeakerCount: scores.lastSpeakerCount,
        consecutiveDays: scores.consecutiveDays,
      })
    }
  }
  champions.sort((a, b) => b.score - a.score)

  return {
    nightOwlRank,
    lastSpeakerRank,
    firstSpeakerRank,
    consecutiveRecords,
    champions,
    totalDays,
  }
}

// ==================== 龙王分析 ====================

/**
 * 获取龙王排名
 */
export function getDragonKingAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  const emptyResult = { rank: [], totalDays: 0 }

  if (!db) return emptyResult

  const { clause, params } = buildTimeFilter(filter)
  const clauseWithSystem = buildSystemMessageFilter(clause)

  const dailyTopSpeakers = db
    .prepare(
      `
        WITH daily_counts AS (
          SELECT
            strftime('%Y-%m-%d', msg.ts, 'unixepoch', 'localtime') as date,
            msg.sender_id,
            m.platform_id,
            m.name,
            COUNT(*) as msg_count
          FROM message msg
          JOIN member m ON msg.sender_id = m.id
          ${clauseWithSystem}
          GROUP BY date, msg.sender_id
        ),
        daily_max AS (
          SELECT date, MAX(msg_count) as max_count
          FROM daily_counts
          GROUP BY date
        )
        SELECT dc.sender_id, dc.platform_id, dc.name, COUNT(*) as dragon_days
        FROM daily_counts dc
        JOIN daily_max dm ON dc.date = dm.date AND dc.msg_count = dm.max_count
        GROUP BY dc.sender_id
        ORDER BY dragon_days DESC
      `
    )
    .all(...params) as Array<{
    sender_id: number
    platform_id: string
    name: string
    dragon_days: number
  }>

  const totalDaysRow = db
    .prepare(
      `
        SELECT COUNT(DISTINCT strftime('%Y-%m-%d', msg.ts, 'unixepoch', 'localtime')) as total
        FROM message msg
        JOIN member m ON msg.sender_id = m.id
        ${clauseWithSystem}
      `
    )
    .get(...params) as { total: number }

  const totalDays = totalDaysRow.total

  const rank = dailyTopSpeakers.map((item) => ({
    memberId: item.sender_id,
    platformId: item.platform_id,
    name: item.name,
    count: item.dragon_days,
    percentage: totalDays > 0 ? Math.round((item.dragon_days / totalDays) * 10000) / 100 : 0,
  }))

  return { rank, totalDays }
}

// ==================== 潜水分析 ====================

/**
 * 获取潜水排名
 */
export function getDivingAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  const emptyResult = { rank: [] }

  if (!db) return emptyResult

  const { clause, params } = buildTimeFilter(filter)
  const clauseWithSystem = buildSystemMessageFilter(clause)

  const lastMessages = db
    .prepare(
      `
        SELECT
          m.id as member_id,
          m.platform_id,
          m.name,
          MAX(msg.ts) as last_ts
        FROM member m
        JOIN message msg ON m.id = msg.sender_id
        ${clauseWithSystem.replace('msg.', 'msg.')}
        GROUP BY m.id
        ORDER BY last_ts ASC
      `
    )
    .all(...params) as Array<{
    member_id: number
    platform_id: string
    name: string
    last_ts: number
  }>

  const now = Math.floor(Date.now() / 1000)

  const rank = lastMessages.map((item) => ({
    memberId: item.member_id,
    platformId: item.platform_id,
    name: item.name,
    lastMessageTs: item.last_ts,
    daysSinceLastMessage: Math.floor((now - item.last_ts) / 86400),
  }))

  return { rank }
}

// ==================== 自言自语分析 ====================

/**
 * 获取自言自语分析
 */
export function getMonologueAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  const emptyResult = { rank: [], maxComboRecord: null }

  if (!db) return emptyResult

  const { clause, params } = buildTimeFilter(filter)

  let whereClause = clause
  if (whereClause.includes('WHERE')) {
    whereClause += " AND m.name != '系统消息' AND msg.type = 0"
  } else {
    whereClause = " WHERE m.name != '系统消息' AND msg.type = 0"
  }

  const messages = db
    .prepare(
      `
        SELECT
          msg.id,
          msg.sender_id as senderId,
          msg.ts,
          m.platform_id as platformId,
          m.name
        FROM message msg
        JOIN member m ON msg.sender_id = m.id
        ${whereClause}
        ORDER BY msg.ts ASC
      `
    )
    .all(...params) as Array<{
    id: number
    senderId: number
    ts: number
    platformId: string
    name: string
  }>

  if (messages.length === 0) return emptyResult

  const memberInfo = new Map<number, { platformId: string; name: string }>()
  const memberStats = new Map<
    number,
    {
      totalStreaks: number
      maxCombo: number
      lowStreak: number
      midStreak: number
      highStreak: number
    }
  >()

  let globalMaxCombo: { memberId: number; comboLength: number; startTs: number } | null = null
  const MAX_INTERVAL = 300

  let currentStreak = {
    senderId: -1,
    count: 0,
    startTs: 0,
    lastTs: 0,
  }

  const finishStreak = () => {
    if (currentStreak.count >= 3) {
      const memberId = currentStreak.senderId

      if (!memberStats.has(memberId)) {
        memberStats.set(memberId, {
          totalStreaks: 0,
          maxCombo: 0,
          lowStreak: 0,
          midStreak: 0,
          highStreak: 0,
        })
      }

      const stats = memberStats.get(memberId)!
      stats.totalStreaks++
      stats.maxCombo = Math.max(stats.maxCombo, currentStreak.count)

      if (currentStreak.count >= 10) {
        stats.highStreak++
      } else if (currentStreak.count >= 5) {
        stats.midStreak++
      } else {
        stats.lowStreak++
      }

      if (!globalMaxCombo || currentStreak.count > globalMaxCombo.comboLength) {
        globalMaxCombo = {
          memberId,
          comboLength: currentStreak.count,
          startTs: currentStreak.startTs,
        }
      }
    }
  }

  for (const msg of messages) {
    if (!memberInfo.has(msg.senderId)) {
      memberInfo.set(msg.senderId, { platformId: msg.platformId, name: msg.name })
    }

    const isSameSender = msg.senderId === currentStreak.senderId
    const isWithinInterval = msg.ts - currentStreak.lastTs <= MAX_INTERVAL

    if (isSameSender && isWithinInterval) {
      currentStreak.count++
      currentStreak.lastTs = msg.ts
    } else {
      finishStreak()
      currentStreak = {
        senderId: msg.senderId,
        count: 1,
        startTs: msg.ts,
        lastTs: msg.ts,
      }
    }
  }

  finishStreak()

  const rank: any[] = []
  for (const [memberId, stats] of memberStats.entries()) {
    const info = memberInfo.get(memberId)!
    rank.push({
      memberId,
      platformId: info.platformId,
      name: info.name,
      totalStreaks: stats.totalStreaks,
      maxCombo: stats.maxCombo,
      lowStreak: stats.lowStreak,
      midStreak: stats.midStreak,
      highStreak: stats.highStreak,
    })
  }
  rank.sort((a, b) => b.totalStreaks - a.totalStreaks)

  let maxComboRecord: any = null
  if (globalMaxCombo) {
    const info = memberInfo.get(globalMaxCombo.memberId)!
    maxComboRecord = {
      memberId: globalMaxCombo.memberId,
      platformId: info.platformId,
      memberName: info.name,
      comboLength: globalMaxCombo.comboLength,
      startTs: globalMaxCombo.startTs,
    }
  }

  return { rank, maxComboRecord }
}

// ==================== @ 互动分析 ====================

/**
 * 获取 @ 互动分析数据
 */
export function getMentionAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  const emptyResult = {
    topMentioners: [],
    topMentioned: [],
    oneWay: [],
    twoWay: [],
    totalMentions: 0,
    memberDetails: [],
  }

  if (!db) return emptyResult

  // 1. 查询所有成员信息
  const members = db
    .prepare(
      `
      SELECT id, platform_id as platformId, name
      FROM member
      WHERE name != '系统消息'
    `
    )
    .all() as Array<{ id: number; platformId: string; name: string }>

  if (members.length === 0) return emptyResult

  // 2. 构建昵称到成员ID的映射（包括历史昵称）
  const nameToMemberId = new Map<string, number>()
  const memberIdToInfo = new Map<number, { platformId: string; name: string }>()

  for (const member of members) {
    memberIdToInfo.set(member.id, { platformId: member.platformId, name: member.name })
    // 当前昵称
    nameToMemberId.set(member.name, member.id)

    // 查询历史昵称
    const history = db
      .prepare(
        `
        SELECT name FROM member_name_history
        WHERE member_id = ?
      `
      )
      .all(member.id) as Array<{ name: string }>

    for (const h of history) {
      if (!nameToMemberId.has(h.name)) {
        nameToMemberId.set(h.name, member.id)
      }
    }
  }

  // 3. 查询所有消息（带时间过滤）
  const { clause, params } = buildTimeFilter(filter)

  let whereClause = clause
  if (whereClause.includes('WHERE')) {
    whereClause += " AND m.name != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL AND msg.content LIKE '%@%'"
  } else {
    whereClause = " WHERE m.name != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL AND msg.content LIKE '%@%'"
  }

  const messages = db
    .prepare(
      `
      SELECT
        msg.sender_id as senderId,
        msg.content
      FROM message msg
      JOIN member m ON msg.sender_id = m.id
      ${whereClause}
    `
    )
    .all(...params) as Array<{ senderId: number; content: string }>

  // 4. 解析 @ 并构建关系矩阵
  // mentionMatrix[fromId][toId] = count
  const mentionMatrix = new Map<number, Map<number, number>>()
  const mentionedCount = new Map<number, number>() // 被 @ 的次数
  const mentionerCount = new Map<number, number>() // 发起 @ 的次数
  let totalMentions = 0

  // @ 正则：匹配 @昵称（昵称不含空格和@）
  const mentionRegex = /@([^\s@]+)/g

  for (const msg of messages) {
    const matches = msg.content.matchAll(mentionRegex)
    const mentionedInThisMsg = new Set<number>() // 避免同一消息重复计数同一人

    for (const match of matches) {
      const mentionedName = match[1]
      const mentionedId = nameToMemberId.get(mentionedName)

      // 只统计能匹配到成员的 @，且不能 @ 自己
      if (mentionedId && mentionedId !== msg.senderId && !mentionedInThisMsg.has(mentionedId)) {
        mentionedInThisMsg.add(mentionedId)
        totalMentions++

        // 更新矩阵
        if (!mentionMatrix.has(msg.senderId)) {
          mentionMatrix.set(msg.senderId, new Map())
        }
        const fromMap = mentionMatrix.get(msg.senderId)!
        fromMap.set(mentionedId, (fromMap.get(mentionedId) || 0) + 1)

        // 更新计数
        mentionerCount.set(msg.senderId, (mentionerCount.get(msg.senderId) || 0) + 1)
        mentionedCount.set(mentionedId, (mentionedCount.get(mentionedId) || 0) + 1)
      }
    }
  }

  if (totalMentions === 0) return emptyResult

  // 5. 构建排行榜
  const topMentioners: any[] = []
  for (const [memberId, count] of mentionerCount.entries()) {
    const info = memberIdToInfo.get(memberId)!
    topMentioners.push({
      memberId,
      platformId: info.platformId,
      name: info.name,
      count,
      percentage: Math.round((count / totalMentions) * 10000) / 100,
    })
  }
  topMentioners.sort((a, b) => b.count - a.count)

  const topMentioned: any[] = []
  for (const [memberId, count] of mentionedCount.entries()) {
    const info = memberIdToInfo.get(memberId)!
    topMentioned.push({
      memberId,
      platformId: info.platformId,
      name: info.name,
      count,
      percentage: Math.round((count / totalMentions) * 10000) / 100,
    })
  }
  topMentioned.sort((a, b) => b.count - a.count)

  // 6. 检测单向关注（舔狗检测）
  // 条件：A @ B 的比例 >= 80%（即 B @ A / A @ B < 20%）
  const oneWay: any[] = []
  const processedPairs = new Set<string>()

  for (const [fromId, toMap] of mentionMatrix.entries()) {
    for (const [toId, fromToCount] of toMap.entries()) {
      const pairKey = `${Math.min(fromId, toId)}-${Math.max(fromId, toId)}`
      if (processedPairs.has(pairKey)) continue
      processedPairs.add(pairKey)

      const toFromCount = mentionMatrix.get(toId)?.get(fromId) || 0
      const total = fromToCount + toFromCount

      // 只有总互动 >= 3 次才考虑
      if (total < 3) continue

      const ratio = fromToCount / total

      // 单向关注：一方占比 >= 80%
      if (ratio >= 0.8) {
        const fromInfo = memberIdToInfo.get(fromId)!
        const toInfo = memberIdToInfo.get(toId)!
        oneWay.push({
          fromMemberId: fromId,
          fromName: fromInfo.name,
          toMemberId: toId,
          toName: toInfo.name,
          fromToCount,
          toFromCount,
          ratio: Math.round(ratio * 100) / 100,
        })
      } else if (ratio <= 0.2) {
        // 反向单向关注
        const fromInfo = memberIdToInfo.get(fromId)!
        const toInfo = memberIdToInfo.get(toId)!
        oneWay.push({
          fromMemberId: toId,
          fromName: toInfo.name,
          toMemberId: fromId,
          toName: fromInfo.name,
          fromToCount: toFromCount,
          toFromCount: fromToCount,
          ratio: Math.round((1 - ratio) * 100) / 100,
        })
      }
    }
  }
  oneWay.sort((a, b) => b.fromToCount - a.fromToCount)

  // 7. 检测双向奔赴（CP检测）
  // 条件：双方互相 @ 总次数 >= 5 次，且比例在 30%-70% 之间
  const twoWay: any[] = []
  processedPairs.clear()

  for (const [fromId, toMap] of mentionMatrix.entries()) {
    for (const [toId, fromToCount] of toMap.entries()) {
      const pairKey = `${Math.min(fromId, toId)}-${Math.max(fromId, toId)}`
      if (processedPairs.has(pairKey)) continue
      processedPairs.add(pairKey)

      const toFromCount = mentionMatrix.get(toId)?.get(fromId) || 0
      const total = fromToCount + toFromCount

      // 总互动 >= 5 次
      if (total < 5) continue

      // 必须双方都有 @
      if (toFromCount === 0 || fromToCount === 0) continue

      const ratio = Math.min(fromToCount, toFromCount) / Math.max(fromToCount, toFromCount)

      // 平衡度 >= 30%（即 30%-100%）
      if (ratio >= 0.3) {
        const member1Info = memberIdToInfo.get(fromId)!
        const member2Info = memberIdToInfo.get(toId)!
        twoWay.push({
          member1Id: fromId,
          member1Name: member1Info.name,
          member2Id: toId,
          member2Name: member2Info.name,
          member1To2: fromToCount,
          member2To1: toFromCount,
          total,
          balance: Math.round(ratio * 100) / 100,
        })
      }
    }
  }
  twoWay.sort((a, b) => b.total - a.total)

  // 8. 构建成员详情（每个成员的 @ 关系 TOP 5）
  const memberDetails: any[] = []

  for (const member of members) {
    const memberId = member.id
    const info = memberIdToInfo.get(memberId)!

    // 该成员最常 @ 的人
    const topMentionedByThis: any[] = []
    const toMap = mentionMatrix.get(memberId)
    if (toMap) {
      for (const [toId, count] of toMap.entries()) {
        const toInfo = memberIdToInfo.get(toId)!
        topMentionedByThis.push({
          fromMemberId: memberId,
          fromName: info.name,
          toMemberId: toId,
          toName: toInfo.name,
          count,
        })
      }
      topMentionedByThis.sort((a, b) => b.count - a.count)
    }

    // 最常 @ 该成员的人
    const topMentionersOfThis: any[] = []
    for (const [fromId, toMap] of mentionMatrix.entries()) {
      const count = toMap.get(memberId)
      if (count) {
        const fromInfo = memberIdToInfo.get(fromId)!
        topMentionersOfThis.push({
          fromMemberId: fromId,
          fromName: fromInfo.name,
          toMemberId: memberId,
          toName: info.name,
          count,
        })
      }
    }
    topMentionersOfThis.sort((a, b) => b.count - a.count)

    // 只有有数据的成员才添加
    if (topMentionedByThis.length > 0 || topMentionersOfThis.length > 0) {
      memberDetails.push({
        memberId,
        name: info.name,
        topMentioned: topMentionedByThis.slice(0, 5),
        topMentioners: topMentionersOfThis.slice(0, 5),
      })
    }
  }

  return {
    topMentioners,
    topMentioned,
    oneWay,
    twoWay,
    totalMentions,
    memberDetails,
  }
}

// ==================== 含笑量分析 ====================

/**
 * 默认笑声关键词列表
 */
const DEFAULT_LAUGH_KEYWORDS = ['哈哈', 'xswl', 'lol', 'ww', '笑死', '233', '🤣']

/**
 * 将关键词转换为正则表达式模式
 */
function keywordToPattern(keyword: string): string {
  // 转义特殊字符
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // 特殊处理一些关键词的变体
  if (keyword === '哈哈') {
    return '哈哈+'
  }
  if (keyword === 'ww') {
    return 'ww+'
  }
  if (keyword === '233') {
    return '2{2,}3{1,}'
  }

  return escaped
}

/**
 * 获取含笑量分析数据
 * @param sessionId 会话ID
 * @param filter 时间过滤
 * @param keywords 自定义关键词列表（可选，默认使用内置列表）
 */
export function getLaughAnalysis(sessionId: string, filter?: TimeFilter, keywords?: string[]): any {
  const db = openDatabase(sessionId)
  const emptyResult = {
    rankByRate: [],
    rankByCount: [],
    typeDistribution: [],
    totalLaughs: 0,
    totalMessages: 0,
    groupLaughRate: 0,
  }

  if (!db) return emptyResult

  // 使用传入的关键词或默认关键词
  const laughKeywords = keywords && keywords.length > 0 ? keywords : DEFAULT_LAUGH_KEYWORDS

  // 构建正则表达式
  const patterns = laughKeywords.map(keywordToPattern)
  const laughRegex = new RegExp(`(${patterns.join('|')})`, 'gi')

  // 查询所有消息
  const { clause, params } = buildTimeFilter(filter)

  let whereClause = clause
  if (whereClause.includes('WHERE')) {
    whereClause += " AND m.name != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL"
  } else {
    whereClause = " WHERE m.name != '系统消息' AND msg.type = 0 AND msg.content IS NOT NULL"
  }

  const messages = db
    .prepare(
      `
      SELECT
        msg.sender_id as senderId,
        msg.content,
        m.platform_id as platformId,
        m.name
      FROM message msg
      JOIN member m ON msg.sender_id = m.id
      ${whereClause}
    `
    )
    .all(...params) as Array<{
    senderId: number
    content: string
    platformId: string
    name: string
  }>

  if (messages.length === 0) return emptyResult

  // 统计数据
  const memberStats = new Map<
    number,
    {
      platformId: string
      name: string
      laughCount: number
      messageCount: number
      keywordCounts: Map<string, number> // 每个关键词的计数
    }
  >()
  const typeCount = new Map<string, number>()
  let totalLaughs = 0

  for (const msg of messages) {
    // 初始化成员统计
    if (!memberStats.has(msg.senderId)) {
      memberStats.set(msg.senderId, {
        platformId: msg.platformId,
        name: msg.name,
        laughCount: 0,
        messageCount: 0,
        keywordCounts: new Map(),
      })
    }

    const stats = memberStats.get(msg.senderId)!
    stats.messageCount++

    // 匹配笑声关键词
    const matches = msg.content.match(laughRegex)
    if (matches) {
      stats.laughCount += matches.length
      totalLaughs += matches.length

      // 统计类型分布
      for (const match of matches) {
        // 归类到对应的关键词类型
        let matchedType = '其他'
        for (const keyword of laughKeywords) {
          const pattern = new RegExp(`^${keywordToPattern(keyword)}$`, 'i')
          if (pattern.test(match)) {
            matchedType = keyword
            break
          }
        }
        typeCount.set(matchedType, (typeCount.get(matchedType) || 0) + 1)
        // 记录到成员的关键词计数
        stats.keywordCounts.set(matchedType, (stats.keywordCounts.get(matchedType) || 0) + 1)
      }
    }
  }

  const totalMessages = messages.length

  if (totalLaughs === 0) return emptyResult

  // 构建排行榜
  const rankItems: any[] = []
  for (const [memberId, stats] of memberStats.entries()) {
    if (stats.laughCount > 0) {
      // 构建该成员的关键词分布（按原始关键词顺序）
      const keywordDistribution: Array<{ keyword: string; count: number; percentage: number }> = []
      for (const keyword of laughKeywords) {
        const count = stats.keywordCounts.get(keyword) || 0
        if (count > 0) {
          keywordDistribution.push({
            keyword,
            count,
            percentage: Math.round((count / stats.laughCount) * 10000) / 100,
          })
        }
      }
      // 处理"其他"类型
      const otherCount = stats.keywordCounts.get('其他') || 0
      if (otherCount > 0) {
        keywordDistribution.push({
          keyword: '其他',
          count: otherCount,
          percentage: Math.round((otherCount / stats.laughCount) * 10000) / 100,
        })
      }

      rankItems.push({
        memberId,
        platformId: stats.platformId,
        name: stats.name,
        laughCount: stats.laughCount,
        messageCount: stats.messageCount,
        laughRate: Math.round((stats.laughCount / stats.messageCount) * 10000) / 100,
        percentage: Math.round((stats.laughCount / totalLaughs) * 10000) / 100,
        keywordDistribution,
      })
    }
  }

  // 按含笑率排序
  const rankByRate = [...rankItems].sort((a, b) => b.laughRate - a.laughRate)
  // 按贡献度（绝对数量）排序
  const rankByCount = [...rankItems].sort((a, b) => b.laughCount - a.laughCount)

  // 构建类型分布
  const typeDistribution: any[] = []
  for (const [type, count] of typeCount.entries()) {
    typeDistribution.push({
      type,
      count,
      percentage: Math.round((count / totalLaughs) * 10000) / 100,
    })
  }
  typeDistribution.sort((a, b) => b.count - a.count)

  return {
    rankByRate,
    rankByCount,
    typeDistribution,
    totalLaughs,
    totalMessages,
    groupLaughRate: Math.round((totalLaughs / totalMessages) * 10000) / 100,
  }
}

// ==================== 斗图分析 ====================

/**
 * 获取斗图分析数据
 * 斗图定义：至少2人参与，总共发了3张图（图片或表情），中间无文本打断
 */
export function getMemeBattleAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  const emptyResult = {
    topBattles: [],
    rankByCount: [],
    rankByImageCount: [],
    totalBattles: 0,
  }

  if (!db) return emptyResult

  const { clause, params } = buildTimeFilter(filter)

  // 排除系统消息 (type=6)
  // 斗图只看图片(1)和表情(5)，其他类型(如文本0, 语音2等)视为打断
  // 我们查询所有非系统消息，在内存中遍历判断
  let whereClause = clause
  if (whereClause.includes('WHERE')) {
    whereClause += ' AND msg.type != 6'
  } else {
    whereClause = ' WHERE msg.type != 6'
  }

  const messages = db
    .prepare(
      `
        SELECT
          msg.sender_id as senderId,
          msg.type,
          msg.ts,
          m.platform_id as platformId,
          m.name
        FROM message msg
        JOIN member m ON msg.sender_id = m.id
        ${whereClause}
        ORDER BY msg.ts ASC
      `
    )
    .all(...params) as Array<{
    senderId: number
    type: number
    ts: number
    platformId: string
    name: string
  }>

  const battles: Array<{
    startTime: number
    endTime: number
    msgs: Array<{ senderId: number; name: string; platformId: string }>
  }> = []

  let currentChain: Array<{ senderId: number; name: string; platformId: string; ts: number }> = []

  // 辅助函数：处理当前链
  const processChain = () => {
    if (currentChain.length >= 3) {
      const senders = new Set(currentChain.map((m) => m.senderId))
      if (senders.size >= 2) {
        // 满足条件：至少3张图，至少2人
        battles.push({
          startTime: currentChain[0].ts,
          endTime: currentChain[currentChain.length - 1].ts,
          msgs: currentChain.map(({ senderId, name, platformId }) => ({ senderId, name, platformId })),
        })
      }
    }
    currentChain = []
  }

  for (const msg of messages) {
    // 1=图片, 5=表情
    if (msg.type === 1 || msg.type === 5) {
      currentChain.push({
        senderId: msg.senderId,
        name: msg.name,
        platformId: msg.platformId,
        ts: msg.ts,
      })
    } else {
      // 其他类型消息（文本、语音等）打断斗图
      processChain()
    }
  }
  // 处理最后一条链
  processChain()

  if (battles.length === 0) return emptyResult

  // 1. 史诗级斗图榜（前30）
  const topBattles = battles
    .map((battle) => ({
      startTime: battle.startTime,
      endTime: battle.endTime,
      totalImages: battle.msgs.length,
      participantCount: new Set(battle.msgs.map((m) => m.senderId)).size,
      participants: Object.values(
        battle.msgs.reduce(
          (acc, curr) => {
            if (!acc[curr.senderId]) {
              acc[curr.senderId] = { memberId: curr.senderId, name: curr.name, imageCount: 0 }
            }
            acc[curr.senderId].imageCount++
            return acc
          },
          {} as Record<number, { memberId: number; name: string; imageCount: number }>
        )
      ).sort((a, b) => b.imageCount - a.imageCount),
    }))
    .sort((a, b) => b.totalImages - a.totalImages)
    .slice(0, 30)

  // 2. 统计达人榜
  const memberStats = new Map<
    number,
    {
      memberId: number
      platformId: string
      name: string
      battleCount: number // 参与场次
      imageCount: number // 发图总数
    }
  >()

  for (const battle of battles) {
    const participantsInBattle = new Set<number>()

    for (const msg of battle.msgs) {
      if (!memberStats.has(msg.senderId)) {
        memberStats.set(msg.senderId, {
          memberId: msg.senderId,
          platformId: msg.platformId,
          name: msg.name,
          battleCount: 0,
          imageCount: 0,
        })
      }
      const stats = memberStats.get(msg.senderId)!
      stats.imageCount++
      participantsInBattle.add(msg.senderId)
    }

    // 参与场次+1
    for (const memberId of participantsInBattle) {
      const stats = memberStats.get(memberId)!
      stats.battleCount++
    }
  }

  const allStats = Array.from(memberStats.values())

  // 按参与场次排名
  const rankByCount = [...allStats]
    .sort((a, b) => b.battleCount - a.battleCount)
    .map((item) => ({
      memberId: item.memberId,
      platformId: item.platformId,
      name: item.name,
      count: item.battleCount,
      percentage: battles.length > 0 ? Math.round((item.battleCount / battles.length) * 10000) / 100 : 0,
    }))

  // 按图片总数排名
  const totalBattleImages = battles.reduce((sum, b) => sum + b.msgs.length, 0)
  const rankByImageCount = [...allStats]
    .sort((a, b) => b.imageCount - a.imageCount)
    .map((item) => ({
      memberId: item.memberId,
      platformId: item.platformId,
      name: item.name,
      count: item.imageCount,
      percentage: totalBattleImages > 0 ? Math.round((item.imageCount / totalBattleImages) * 10000) / 100 : 0,
    }))

  return {
    topBattles,
    rankByCount,
    rankByImageCount,
    totalBattles: battles.length,
  }
}

// ==================== 打卡分析 ====================

/**
 * 获取打卡分析数据（火花榜 + 忠臣榜）
 */
export function getCheckInAnalysis(sessionId: string, filter?: TimeFilter): any {
  const db = openDatabase(sessionId)
  const emptyResult = {
    streakRank: [],
    loyaltyRank: [],
    totalDays: 0,
  }

  if (!db) return emptyResult

  const { clause, params } = buildTimeFilter(filter)
  const whereClause = buildSystemMessageFilter(clause)

  // 1. 获取每个成员每天是否发言的数据
  // 检查时间戳格式：如果 ts > 1e12 则是毫秒，否则是秒
  const sampleTs = db.prepare(`SELECT ts FROM message LIMIT 1`).get() as { ts: number } | undefined
  const tsIsMillis = sampleTs?.ts && sampleTs.ts > 1e12
  const tsExpr = tsIsMillis ? 'msg.ts / 1000' : 'msg.ts'

  const dailyActivity = db
    .prepare(
      `
      SELECT
        msg.sender_id as senderId,
        m.name,
        DATE(${tsExpr}, 'unixepoch', 'localtime') as day
      FROM message msg
      JOIN member m ON msg.sender_id = m.id
      ${whereClause}
      GROUP BY msg.sender_id, day
      ORDER BY msg.sender_id, day
    `
    )
    .all(...params) as Array<{
    senderId: number
    name: string
    day: string
  }>

  if (dailyActivity.length === 0) return emptyResult

  // 2. 获取群聊总天数
  const allDays = new Set(dailyActivity.map((r) => r.day))
  const totalDays = allDays.size

  // 获取最后一天（用于判断当前连续）
  const sortedDays = Array.from(allDays).sort()
  const lastDay = sortedDays[sortedDays.length - 1]

  // 3. 按成员分组
  const memberDays = new Map<number, { name: string; days: Set<string> }>()
  for (const record of dailyActivity) {
    if (!memberDays.has(record.senderId)) {
      memberDays.set(record.senderId, { name: record.name, days: new Set() })
    }
    memberDays.get(record.senderId)!.days.add(record.day)
  }

  // 4. 计算每个成员的连续发言和累计发言
  const streakData: Array<{
    memberId: number
    name: string
    maxStreak: number
    maxStreakStart: string
    maxStreakEnd: string
    currentStreak: number
  }> = []

  const loyaltyData: Array<{
    memberId: number
    name: string
    totalDays: number
  }> = []

  for (const [memberId, data] of memberDays) {
    const sortedMemberDays = Array.from(data.days).sort()
    const totalMemberDays = sortedMemberDays.length

    // 计算最长连续
    let maxStreak = 1
    let maxStreakStart = sortedMemberDays[0]
    let maxStreakEnd = sortedMemberDays[0]

    let currentStreakCount = 1
    let currentStreakStart = sortedMemberDays[0]

    for (let i = 1; i < sortedMemberDays.length; i++) {
      const prevDate = new Date(sortedMemberDays[i - 1])
      const currDate = new Date(sortedMemberDays[i])
      const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24))

      if (diffDays === 1) {
        // 连续
        currentStreakCount++
      } else {
        // 中断，检查是否更新最大值
        if (currentStreakCount > maxStreak) {
          maxStreak = currentStreakCount
          maxStreakStart = currentStreakStart
          maxStreakEnd = sortedMemberDays[i - 1]
        }
        currentStreakCount = 1
        currentStreakStart = sortedMemberDays[i]
      }
    }

    // 检查最后一段连续
    if (currentStreakCount > maxStreak) {
      maxStreak = currentStreakCount
      maxStreakStart = currentStreakStart
      maxStreakEnd = sortedMemberDays[sortedMemberDays.length - 1]
    }

    // 计算当前连续（是否以最后一天结束）
    let finalCurrentStreak = 0
    if (sortedMemberDays[sortedMemberDays.length - 1] === lastDay) {
      // 从最后一天往前数
      finalCurrentStreak = 1
      for (let i = sortedMemberDays.length - 2; i >= 0; i--) {
        const currDate = new Date(sortedMemberDays[i + 1])
        const prevDate = new Date(sortedMemberDays[i])
        const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24))
        if (diffDays === 1) {
          finalCurrentStreak++
        } else {
          break
        }
      }
    }

    streakData.push({
      memberId,
      name: data.name,
      maxStreak,
      maxStreakStart,
      maxStreakEnd,
      currentStreak: finalCurrentStreak,
    })

    loyaltyData.push({
      memberId,
      name: data.name,
      totalDays: totalMemberDays,
    })
  }

  // 5. 排序
  const streakRank = streakData.sort((a, b) => b.maxStreak - a.maxStreak)

  const sortedLoyalty = loyaltyData.sort((a, b) => b.totalDays - a.totalDays)
  const maxLoyaltyDays = sortedLoyalty.length > 0 ? sortedLoyalty[0].totalDays : 1
  const loyaltyRank = sortedLoyalty.map((item) => ({
    ...item,
    percentage: Math.round((item.totalDays / maxLoyaltyDays) * 100),
  }))

  return {
    streakRank,
    loyaltyRank,
    totalDays,
  }
}
