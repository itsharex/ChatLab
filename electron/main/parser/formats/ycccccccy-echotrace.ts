/**
 * ycccccccy/echotrace 微信导出格式解析器
 * 适配项目: https://github.com/ycccccccy/echotrace
 *
 * 特征：
 * - 顶层包含 session 和 messages 字段
 * - session.wxid: 微信ID（群聊以 @chatroom 结尾）
 * - session.type: "群聊" 或 "私聊"
 * - messages[].type: 中文消息类型字符串
 * - messages[].senderUsername: 发送者微信ID
 * - messages[].senderDisplayName: 发送者显示名
 *
 * 注意：localType 字段不可信，不使用
 */

import * as fs from 'fs'
import * as path from 'path'
import { parser } from 'stream-json'
import { pick } from 'stream-json/filters/Pick'
import { streamValues } from 'stream-json/streamers/StreamValues'
import { chain } from 'stream-chain'
import { ChatPlatform, ChatType, MessageType } from '../../../../src/types/chat'
import type {
  FormatFeature,
  FormatModule,
  Parser,
  ParseOptions,
  ParseEvent,
  ParsedMeta,
  ParsedMember,
  ParsedMessage,
} from '../types'
import { getFileSize, createProgress, readFileHeadBytes } from '../utils'

// ==================== 辅助函数 ====================

/**
 * 从文件名提取聊天名称
 */
function extractNameFromFilePath(filePath: string): string {
  const basename = path.basename(filePath)
  const name = basename.replace(/\.json$/i, '')
  return name || '未知聊天'
}

// ==================== 特征定义 ====================

export const feature: FormatFeature = {
  id: 'ycccccccy-echotrace',
  name: 'ycccccccy/echotrace 微信导出',
  platform: ChatPlatform.WECHAT,
  priority: 15,
  extensions: ['.json'],
  signatures: {
    // 检测顶层字段和特征
    head: [/"session"\s*:/, /"senderUsername"\s*:/, /"senderDisplayName"\s*:/],
    requiredFields: ['session', 'messages'],
  },
}

// ==================== 消息结构 ====================

interface EchotraceSession {
  wxid: string
  nickname: string
  remark: string
  displayName: string
  type: '群聊' | '私聊'
  lastTimestamp: number
  messageCount: number
}

interface EchotraceMessage {
  localId: number
  createTime: number // Unix 时间戳（秒）
  formattedTime: string
  type: string // 中文消息类型
  localType: number // 不可信，不使用
  content: string
  isSend: number | null // 0=接收, 1=发送, null=系统
  senderUsername: string // 发送者微信ID
  senderDisplayName: string // 发送者显示名
  source: string
}

// ==================== 消息类型映射 ====================

/**
 * 将 echotrace 中文消息类型转换为标准 MessageType
 */
function convertMessageType(typeStr: string): MessageType {
  switch (typeStr) {
    case '文本消息':
      return MessageType.TEXT
    case '图片消息':
      return MessageType.IMAGE
    case '语音消息':
      return MessageType.VOICE
    case '视频消息':
      return MessageType.VIDEO
    case '文件消息':
      return MessageType.FILE
    case '动画表情':
      return MessageType.EMOJI
    case '名片消息':
      return MessageType.CONTACT
    case '卡片式链接':
    case '图文消息':
      return MessageType.LINK
    case '位置消息':
      return MessageType.LOCATION
    case '红包卡片':
      return MessageType.RED_PACKET
    case '转账卡片':
      return MessageType.TRANSFER
    case '小程序分享':
    case '视频号直播卡片':
      return MessageType.SHARE
    case '引用消息':
      return MessageType.REPLY
    case '聊天记录合并转发':
      return MessageType.FORWARD
    case '系统消息':
      return MessageType.SYSTEM
    default:
      // 未知类型(xxxxx) 或其他
      return MessageType.OTHER
  }
}

// ==================== 成员信息追踪 ====================

interface MemberInfo {
  platformId: string
  accountName: string
}

// ==================== 解析器实现 ====================

async function* parseEchotrace(options: ParseOptions): AsyncGenerator<ParseEvent, void, unknown> {
  const { filePath, batchSize = 5000, onProgress } = options

  const totalBytes = getFileSize(filePath)
  let bytesRead = 0
  let messagesProcessed = 0

  // 发送初始进度
  const initialProgress = createProgress('parsing', 0, totalBytes, 0, '开始解析...')
  yield { type: 'progress', data: initialProgress }
  onProgress?.(initialProgress)

  // 读取文件头获取 session 信息
  const headContent = readFileHeadBytes(filePath, 2000)

  // 解析 session
  let session: EchotraceSession | null = null
  try {
    const sessionMatch = headContent.match(/"session"\s*:\s*(\{[^}]+\})/)
    if (sessionMatch) {
      session = JSON.parse(sessionMatch[1])
    }
  } catch {
    // 使用默认值
  }

  // 确定聊天类型
  // 1. 优先使用 session.type
  // 2. 或者通过 wxid 是否以 @chatroom 结尾判断
  let chatType = ChatType.GROUP
  if (session) {
    if (session.type === '私聊') {
      chatType = ChatType.PRIVATE
    } else if (session.type === '群聊') {
      chatType = ChatType.GROUP
    } else if (session.wxid && !session.wxid.endsWith('@chatroom')) {
      chatType = ChatType.PRIVATE
    }
  }

  // 确定聊天名称
  const chatName = session?.displayName || session?.nickname || extractNameFromFilePath(filePath)

  // 发送 meta
  const meta: ParsedMeta = {
    name: chatName,
    platform: ChatPlatform.WECHAT,
    type: chatType,
  }
  yield { type: 'meta', data: meta }

  // 收集成员和消息
  const memberMap = new Map<string, MemberInfo>()
  let messageBatch: ParsedMessage[] = []

  // 流式解析
  await new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, { encoding: 'utf-8' })

    readStream.on('data', (chunk: string | Buffer) => {
      bytesRead += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    })

    const pipeline = chain([readStream, parser(), pick({ filter: /^messages\.\d+$/ }), streamValues()])

    const processMessage = (msg: EchotraceMessage): ParsedMessage | null => {
      // 验证必要字段
      if (!msg.senderUsername || msg.createTime === undefined) {
        return null
      }

      const platformId = msg.senderUsername
      const accountName = msg.senderDisplayName || platformId

      // 更新成员信息
      if (!memberMap.has(platformId)) {
        memberMap.set(platformId, {
          platformId,
          accountName,
        })
      } else {
        // 更新为最新的显示名
        const existing = memberMap.get(platformId)!
        existing.accountName = accountName
      }

      // 转换消息类型
      const type = convertMessageType(msg.type)

      return {
        senderPlatformId: platformId,
        senderAccountName: accountName,
        // echotrace 格式没有单独的群昵称字段
        senderGroupNickname: undefined,
        timestamp: msg.createTime,
        type,
        content: msg.content || null,
      }
    }

    // 用于收集批次的临时数组
    const batchCollector: ParsedMessage[] = []

    pipeline.on('data', ({ value }: { value: EchotraceMessage }) => {
      const parsed = processMessage(value)
      if (parsed) {
        batchCollector.push(parsed)
        messagesProcessed++

        // 达到批次大小
        if (batchCollector.length >= batchSize) {
          messageBatch.push(...batchCollector)
          batchCollector.length = 0

          const progress = createProgress(
            'parsing',
            bytesRead,
            totalBytes,
            messagesProcessed,
            `已处理 ${messagesProcessed} 条消息...`
          )
          onProgress?.(progress)
        }
      }
    })

    pipeline.on('end', () => {
      // 收集剩余消息
      if (batchCollector.length > 0) {
        messageBatch.push(...batchCollector)
      }
      resolve()
    })

    pipeline.on('error', reject)
  })

  // 发送成员
  const members: ParsedMember[] = Array.from(memberMap.values()).map((m) => ({
    platformId: m.platformId,
    accountName: m.accountName,
  }))
  yield { type: 'members', data: members }

  // 分批发送消息
  for (let i = 0; i < messageBatch.length; i += batchSize) {
    const batch = messageBatch.slice(i, i + batchSize)
    yield { type: 'messages', data: batch }
  }

  // 完成
  const doneProgress = createProgress('done', totalBytes, totalBytes, messagesProcessed, '解析完成')
  yield { type: 'progress', data: doneProgress }
  onProgress?.(doneProgress)

  yield {
    type: 'done',
    data: { messageCount: messagesProcessed, memberCount: memberMap.size },
  }
}

// ==================== 导出解析器 ====================

export const parser_: Parser = {
  feature,
  parse: parseEchotrace,
}

// ==================== 预处理器（预留） ====================

import { echotracePreprocessor } from './echotrace-preprocessor'
export const preprocessor = echotracePreprocessor

// ==================== 导出格式模块 ====================

const module_: FormatModule = {
  feature,
  parser: parser_,
  preprocessor: echotracePreprocessor,
}

export default module_

