/**
 * AI 对话 Composable
 * 封装 AI 对话的核心逻辑（基于 Agent + Function Calling）
 */

import { ref } from 'vue'

// 工具调用记录
export interface ToolCallRecord {
  name: string
  displayName: string
  status: 'running' | 'done' | 'error'
  timestamp: number
  /** 工具调用参数（如搜索关键词等） */
  params?: Record<string, unknown>
}

// 消息类型
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  dataSource?: {
    toolsUsed: string[]
    toolRounds: number
  }
  /** 工具调用记录（用户消息后显示） */
  toolCalls?: ToolCallRecord[]
  isStreaming?: boolean
}

// 搜索结果消息类型（保留用于数据源面板）
export interface SourceMessage {
  id: number
  senderName: string
  senderPlatformId: string
  content: string
  timestamp: number
  type: number
}

// 工具状态类型
export interface ToolStatus {
  name: string
  displayName: string
  status: 'running' | 'done' | 'error'
  result?: unknown
}

// 工具名称映射（英文 → 中文）
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  search_messages: '搜索聊天记录',
  get_recent_messages: '获取最近消息',
  get_member_stats: '获取成员统计',
  get_time_stats: '获取时间分布',
}

export function useAIChat(sessionId: string, timeFilter?: { startTs: number; endTs: number }) {
  // 状态
  const messages = ref<ChatMessage[]>([])
  const sourceMessages = ref<SourceMessage[]>([])
  const currentKeywords = ref<string[]>([])
  const isLoadingSource = ref(false)
  const isAIThinking = ref(false)
  const currentConversationId = ref<string | null>(null)

  // 工具调用状态
  const currentToolStatus = ref<ToolStatus | null>(null)
  const toolsUsedInCurrentRound = ref<string[]>([])

  // 中止控制
  let isAborted = false
  // 当前请求 ID，用于区分不同请求的响应
  let currentRequestId = ''
  // 当前 Agent 请求 ID，用于中止请求
  let currentAgentRequestId = ''

  // 生成消息 ID
  function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 发送消息（使用 Agent + Function Calling）
   */
  async function sendMessage(content: string): Promise<void> {
    console.log('[AI] ====== 开始处理用户消息 ======')
    console.log('[AI] 用户输入:', content)

    if (!content.trim() || isAIThinking.value) {
      console.log('[AI] 跳过：内容为空或正在思考')
      return
    }

    // 检查是否已配置 LLM
    console.log('[AI] 检查 LLM 配置...')
    const hasConfig = await window.llmApi.hasConfig()
    console.log('[AI] LLM 配置状态:', hasConfig)

    if (!hasConfig) {
      console.log('[AI] 未配置 LLM，显示提示')
      messages.value.push({
        id: generateId('error'),
        role: 'assistant',
        content: '⚠️ 请先配置 AI 服务。点击左下角「设置」按钮前往「AI模型Tab」进行配置。',
        timestamp: Date.now(),
      })
      return
    }

    // 添加用户消息（包含工具调用记录）
    const userMessage: ChatMessage = {
      id: generateId('user'),
      role: 'user',
      content,
      timestamp: Date.now(),
      toolCalls: [], // 工具调用会在这里更新
    }
    messages.value.push(userMessage)
    const userMessageIndex = messages.value.length - 1
    console.log('[AI] 已添加用户消息')

    // 开始处理
    isAIThinking.value = true
    isLoadingSource.value = true
    currentToolStatus.value = null
    toolsUsedInCurrentRound.value = []
    isAborted = false
    // 生成新的请求 ID
    currentRequestId = generateId('req')
    const thisRequestId = currentRequestId
    console.log('[AI] 开始 Agent 处理...', { requestId: thisRequestId })

    // 创建 AI 响应消息占位符
    const aiMessageId = generateId('ai')
    const aiMessage: ChatMessage = {
      id: aiMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    }
    messages.value.push(aiMessage)
    const aiMessageIndex = messages.value.length - 1

    try {
      // 调用 Agent API
      const context = {
        sessionId,
        timeFilter: timeFilter ? { startTs: timeFilter.startTs, endTs: timeFilter.endTs } : undefined,
      }

      console.log('[AI] 调用 Agent API...', context)

      // 获取 requestId 和 promise
      const { requestId: agentReqId, promise: agentPromise } = window.agentApi.runStream(content, context, (chunk) => {
        // 如果已中止或请求 ID 不匹配，忽略后续 chunks
        if (isAborted || thisRequestId !== currentRequestId) {
          console.log('[AI] 已中止或请求已过期，忽略 chunk', {
            isAborted,
            thisRequestId,
            currentRequestId,
          })
          return
        }

        console.log('[AI] Agent chunk:', chunk.type, chunk.toolName || chunk.content?.slice(0, 50))

        switch (chunk.type) {
          case 'content':
            // 流式内容更新
            if (chunk.content) {
              // 清除工具状态，开始显示内容
              currentToolStatus.value = null
              messages.value[aiMessageIndex] = {
                ...messages.value[aiMessageIndex],
                content: messages.value[aiMessageIndex].content + chunk.content,
              }
            }
            break

          case 'tool_start':
            // 工具开始执行 - 更新状态并记录到用户消息（包含参数）
            console.log('[AI] 工具开始执行:', chunk.toolName, chunk.toolParams)
            if (chunk.toolName) {
              const toolRecord: ToolCallRecord = {
                name: chunk.toolName,
                displayName: TOOL_DISPLAY_NAMES[chunk.toolName] || chunk.toolName,
                status: 'running',
                timestamp: Date.now(),
                params: chunk.toolParams as Record<string, unknown>,
              }
              currentToolStatus.value = {
                name: chunk.toolName,
                displayName: TOOL_DISPLAY_NAMES[chunk.toolName] || chunk.toolName,
                status: 'running',
              }
              toolsUsedInCurrentRound.value.push(chunk.toolName)

              // 更新用户消息的工具调用记录
              const userMsg = messages.value[userMessageIndex]
              if (userMsg.toolCalls) {
                userMsg.toolCalls = [...userMsg.toolCalls, toolRecord]
              } else {
                userMsg.toolCalls = [toolRecord]
              }
              messages.value[userMessageIndex] = { ...userMsg }
            }
            break

          case 'tool_result':
            // 工具执行结果 - 更新工具状态为完成
            console.log('[AI] 工具执行结果:', chunk.toolName, chunk.toolResult)
            if (chunk.toolName) {
              // 更新 currentToolStatus
              if (currentToolStatus.value?.name === chunk.toolName) {
                currentToolStatus.value = {
                  ...currentToolStatus.value,
                  status: 'done',
                }
              }

              // 更新用户消息中的工具调用状态
              const userMsg = messages.value[userMessageIndex]
              if (userMsg.toolCalls) {
                const toolIndex = userMsg.toolCalls.findIndex(
                  (t) => t.name === chunk.toolName && t.status === 'running'
                )
                if (toolIndex >= 0) {
                  userMsg.toolCalls[toolIndex] = {
                    ...userMsg.toolCalls[toolIndex],
                    status: 'done',
                  }
                  messages.value[userMessageIndex] = { ...userMsg }
                }
              }
            }
            isLoadingSource.value = false
            break

          case 'done':
            // 完成
            console.log('[AI] Agent 完成')
            currentToolStatus.value = null
            break

          case 'error':
            // 错误
            console.error('[AI] Agent 错误:', chunk.error)
            if (currentToolStatus.value) {
              currentToolStatus.value = {
                ...currentToolStatus.value,
                status: 'error',
              }
            }
            break
        }
      })

      // 存储 Agent 请求 ID（用于中止）
      currentAgentRequestId = agentReqId
      console.log('[AI] Agent 请求已启动，agentReqId:', agentReqId)

      // 等待 Agent 完成
      const result = await agentPromise
      console.log('[AI] Agent 返回结果:', result)

      // 如果请求已过期，不更新
      if (thisRequestId !== currentRequestId) {
        console.log('[AI] 请求已过期，跳过结果处理')
        return
      }

      if (result.success && result.result) {
        // 更新消息的 dataSource
        messages.value[aiMessageIndex] = {
          ...messages.value[aiMessageIndex],
          dataSource: {
            toolsUsed: result.result.toolsUsed,
            toolRounds: result.result.toolRounds,
          },
          isStreaming: false,
        }

        // 保存对话到数据库
        console.log('[AI] 保存对话...')
        await saveConversation(userMessage, messages.value[aiMessageIndex])
        console.log('[AI] 对话已保存')
      } else {
        // 处理错误
        messages.value[aiMessageIndex] = {
          ...messages.value[aiMessageIndex],
          content: `❌ 处理失败：${result.error || '未知错误'}`,
          isStreaming: false,
        }
      }

      console.log('[AI] ====== 处理完成 ======')
    } catch (error) {
      console.error('[AI] ====== 处理失败 ======')
      console.error('[AI] 错误:', error)

      messages.value[aiMessageIndex] = {
        ...messages.value[aiMessageIndex],
        content: `❌ 处理失败：${error instanceof Error ? error.message : '未知错误'}

请检查：
- 网络连接是否正常
- API Key 是否有效
- 配置是否正确`,
        isStreaming: false,
      }
    } finally {
      isAIThinking.value = false
      isLoadingSource.value = false
    }
  }

  /**
   * 保存对话到数据库
   */
  async function saveConversation(userMsg: ChatMessage, aiMsg: ChatMessage): Promise<void> {
    console.log('[AI] saveConversation 调用')

    try {
      // 如果没有当前对话，创建新对话
      if (!currentConversationId.value) {
        const title = userMsg.content.slice(0, 50) + (userMsg.content.length > 50 ? '...' : '')
        const conversation = await window.aiApi.createConversation(sessionId, title)
        currentConversationId.value = conversation.id
        console.log('[AI] 创建了新对话:', conversation.id)
      }

      // 保存用户消息
      await window.aiApi.addMessage(currentConversationId.value, 'user', userMsg.content)

      // 保存 AI 消息
      await window.aiApi.addMessage(
        currentConversationId.value,
        'assistant',
        aiMsg.content,
        undefined, // 不再保存关键词
        undefined
      )
      console.log('[AI] 消息保存完成')
    } catch (error) {
      console.error('[AI] 保存对话失败：', error)
    }
  }

  /**
   * 加载对话历史
   */
  async function loadConversation(conversationId: string): Promise<void> {
    console.log('[AI] 加载对话历史，conversationId:', conversationId)
    try {
      const history = await window.aiApi.getMessages(conversationId)
      currentConversationId.value = conversationId

      messages.value = history.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp * 1000,
      }))
      console.log('[AI] 加载完成，messages.value 数量:', messages.value.length)
    } catch (error) {
      console.error('[AI] 加载对话历史失败：', error)
    }
  }

  /**
   * 创建新对话
   */
  function startNewConversation(welcomeMessage?: string): void {
    currentConversationId.value = null
    messages.value = []
    sourceMessages.value = []
    currentKeywords.value = []

    if (welcomeMessage) {
      messages.value.push({
        id: generateId('welcome'),
        role: 'assistant',
        content: welcomeMessage,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * 加载更多搜索结果（保留兼容性，但不再主动使用）
   */
  async function loadMoreSourceMessages(): Promise<void> {
    // Agent 模式下暂不支持加载更多
  }

  /**
   * 更新配置（保留兼容性）
   */
  async function updateMaxMessages(): Promise<void> {
    // Agent 模式下由工具自行控制
  }

  /**
   * 停止生成
   */
  async function stopGeneration(): Promise<void> {
    if (!isAIThinking.value) return

    console.log('[AI] 用户停止生成')
    isAborted = true
    isAIThinking.value = false
    isLoadingSource.value = false
    currentToolStatus.value = null

    // 调用主进程中止 Agent 请求
    if (currentAgentRequestId) {
      console.log('[AI] 中止 Agent 请求:', currentAgentRequestId)
      try {
        await window.agentApi.abort(currentAgentRequestId)
        console.log('[AI] Agent 请求已中止')
      } catch (error) {
        console.error('[AI] 中止 Agent 请求失败:', error)
      }
      currentAgentRequestId = ''
    }

    // 标记最后一条 AI 消息为已完成
    const lastMessage = messages.value[messages.value.length - 1]
    if (lastMessage && lastMessage.role === 'assistant' && lastMessage.isStreaming) {
      lastMessage.isStreaming = false
      lastMessage.content += '\n\n_（已停止生成）_'
    }
  }

  return {
    // 状态
    messages,
    sourceMessages,
    currentKeywords,
    isLoadingSource,
    isAIThinking,
    currentConversationId,
    currentToolStatus,
    toolsUsedInCurrentRound,

    // 方法
    sendMessage,
    loadConversation,
    startNewConversation,
    loadMoreSourceMessages,
    updateMaxMessages,
    stopGeneration,
  }
}
