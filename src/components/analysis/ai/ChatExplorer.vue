<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useChatStore } from '@/stores/chat'
import ConversationList from './ConversationList.vue'
import DataSourcePanel from './DataSourcePanel.vue'
import ChatMessage from './ChatMessage.vue'
import ChatInput from './ChatInput.vue'
import { useAIChat } from '@/composables/useAIChat'

// Props
const props = defineProps<{
  sessionId: string
  sessionName: string
  timeFilter?: { startTs: number; endTs: number }
}>()

// 使用 AI 对话 Composable
const {
  messages,
  sourceMessages,
  currentKeywords,
  isLoadingSource,
  isAIThinking,
  currentConversationId,
  currentToolStatus,
  toolsUsedInCurrentRound,
  sendMessage,
  loadConversation,
  startNewConversation,
  loadMoreSourceMessages,
  updateMaxMessages,
  stopGeneration,
} = useAIChat(props.sessionId, props.timeFilter)

// Store
const chatStore = useChatStore()

// UI 状态
const isSourcePanelCollapsed = ref(false)
const hasLLMConfig = ref(false)
const isCheckingConfig = ref(true)
const messagesContainer = ref<HTMLElement | null>(null)
const conversationListRef = ref<InstanceType<typeof ConversationList> | null>(null)

// 检查 LLM 配置
async function checkLLMConfig() {
  isCheckingConfig.value = true
  try {
    hasLLMConfig.value = await window.llmApi.hasConfig()
  } catch (error) {
    console.error('检查 LLM 配置失败：', error)
    hasLLMConfig.value = false
  } finally {
    isCheckingConfig.value = false
  }
}

// 刷新配置状态（供外部调用）
async function refreshConfig() {
  await checkLLMConfig()
  if (hasLLMConfig.value) {
    await updateMaxMessages()
  }
  // 更新欢迎消息
  const welcomeMsg = messages.value.find((m) => m.id.startsWith('welcome'))
  if (welcomeMsg) {
    welcomeMsg.content = generateWelcomeMessage()
  }
}

// 暴露方法供父组件调用
defineExpose({
  refreshConfig,
})

// 生成欢迎消息
function generateWelcomeMessage() {
  const configHint = hasLLMConfig.value
    ? '✅ AI 服务已配置，可以开始对话了！'
    : '**注意**：使用前请先在侧边栏底部的「设置」中配置 AI 服务 ⚙️'

  return `👋 你好！我是 AI 助手，可以帮你探索「${props.sessionName}」的聊天记录。

你可以这样问我：
- 大家最近聊了什么有趣的话题
- 谁是群里最活跃的人
- 帮我找一下群里讨论买房的记录

${configHint}`
}

// 发送消息
async function handleSend(content: string) {
  await sendMessage(content)
  // 滚动到底部
  scrollToBottom()
  // 刷新对话列表
  conversationListRef.value?.refresh()
}

// 滚动到底部
function scrollToBottom() {
  setTimeout(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  }, 100)
}

// 切换数据源面板
function toggleSourcePanel() {
  isSourcePanelCollapsed.value = !isSourcePanelCollapsed.value
}

// 加载更多数据源
async function handleLoadMore() {
  await loadMoreSourceMessages()
}

// 选择对话
async function handleSelectConversation(convId: string) {
  await loadConversation(convId)
  scrollToBottom()
}

// 创建新对话
function handleCreateConversation() {
  startNewConversation(generateWelcomeMessage())
}

// 删除对话
function handleDeleteConversation(convId: string) {
  // 如果删除的是当前对话，创建新对话
  if (currentConversationId.value === convId) {
    startNewConversation(generateWelcomeMessage())
  }
}

// 格式化时间戳
function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000)
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

// 初始化
onMounted(async () => {
  await checkLLMConfig()
  await updateMaxMessages()

  // 初始化欢迎消息
  startNewConversation(generateWelcomeMessage())
})

// 组件卸载时停止生成
onBeforeUnmount(() => {
  stopGeneration()
})

// 处理停止按钮
function handleStop() {
  stopGeneration()
}

// 监听消息变化，自动滚动
watch(
  () => messages.value.length,
  () => {
    scrollToBottom()
  }
)

// 监听 AI 响应流式更新
watch(
  () => messages.value[messages.value.length - 1]?.content,
  () => {
    scrollToBottom()
  }
)

// 监听全局 AI 配置变化（从设置弹窗保存时触发）
watch(
  () => (chatStore as unknown as { aiConfigVersion: number }).aiConfigVersion,
  async () => {
    await refreshConfig()
  }
)
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <!-- 左侧：对话记录列表 -->
    <div class="w-64 shrink-0 border-r border-gray-200 bg-gray-50/50 dark:border-gray-800 dark:bg-gray-900/50">
      <ConversationList
        ref="conversationListRef"
        :session-id="sessionId"
        :active-id="currentConversationId"
        @select="handleSelectConversation"
        @create="handleCreateConversation"
        @delete="handleDeleteConversation"
        class="h-full"
      />
    </div>

    <!-- 中间：对话区域 -->
    <div class="flex h-full flex-1">
      <div class="flex min-w-[480px] flex-1 flex-col overflow-hidden">
        <!-- 消息列表 -->
        <div ref="messagesContainer" class="min-h-0 flex-1 overflow-y-auto p-4">
          <div class="mx-auto max-w-3xl space-y-4">
            <template v-for="msg in messages" :key="msg.id">
              <!-- 聊天消息 -->
              <ChatMessage
                v-if="msg.role === 'user' || msg.content"
                :role="msg.role"
                :content="msg.content"
                :timestamp="msg.timestamp"
                :is-streaming="msg.isStreaming"
              />

              <!-- 工具调用链（显示在用户消息后面） -->
              <div
                v-if="msg.role === 'user' && msg.toolCalls && msg.toolCalls.length > 0"
                class="ml-11 space-y-2 rounded-lg border border-gray-200 bg-gray-50/80 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50"
              >
                <!-- 工具链标题 -->
                <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <UIcon name="i-heroicons-wrench-screwdriver" class="h-3.5 w-3.5" />
                  <span>工具调用</span>
                </div>
                <!-- 工具列表 -->
                <div class="space-y-1.5">
                  <div v-for="(tool, idx) in msg.toolCalls" :key="tool.name + idx" class="flex items-start gap-2">
                    <!-- 状态图标 -->
                    <UIcon
                      :name="
                        tool.status === 'running'
                          ? 'i-heroicons-arrow-path'
                          : tool.status === 'done'
                            ? 'i-heroicons-check-circle'
                            : 'i-heroicons-x-circle'
                      "
                      class="mt-0.5 h-4 w-4 shrink-0"
                      :class="[
                        tool.status === 'running'
                          ? 'animate-spin text-violet-500'
                          : tool.status === 'done'
                            ? 'text-green-500'
                            : 'text-red-500',
                      ]"
                    />
                    <div class="min-w-0 flex-1">
                      <!-- 工具名称 -->
                      <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {{ tool.displayName }}
                      </span>
                      <!-- 参数详情 -->
                      <div v-if="tool.params" class="mt-0.5 space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
                        <template v-if="tool.name === 'search_messages' && tool.params.keywords">
                          <div>
                            <span class="text-gray-400">关键词:</span>
                            <span
                              v-for="(kw, kwIdx) in tool.params.keywords as string[]"
                              :key="kwIdx"
                              class="ml-1 inline-flex rounded bg-violet-100 px-1.5 py-0.5 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                            >
                              {{ kw }}
                            </span>
                          </div>
                          <!-- 时间范围（LLM 指定的年/月） -->
                          <div v-if="tool.params.year" class="text-gray-400">
                            <span>时间范围:</span>
                            <span class="ml-1 text-gray-600 dark:text-gray-300">
                              {{ tool.params.year }}年{{ tool.params.month ? `${tool.params.month}月` : '' }}
                            </span>
                          </div>
                          <!-- 时间范围（用户筛选） -->
                          <div v-else-if="tool.params._timeFilter" class="text-gray-400">
                            <span>时间范围:</span>
                            <span class="ml-1 text-gray-600 dark:text-gray-300">
                              {{ formatTimestamp((tool.params._timeFilter as { startTs: number }).startTs) }}
                            </span>
                            <span class="mx-1">至</span>
                            <span class="text-gray-600 dark:text-gray-300">
                              {{ formatTimestamp((tool.params._timeFilter as { endTs: number }).endTs) }}
                            </span>
                          </div>
                          <div v-else class="text-gray-400">
                            <span>时间范围:</span>
                            <span class="ml-1 text-gray-600 dark:text-gray-300">全部时间</span>
                          </div>
                        </template>
                        <template v-else-if="tool.name === 'get_recent_messages'">
                          <div>
                            <span class="text-gray-400">获取</span>
                            <span class="ml-1 text-gray-600 dark:text-gray-300">{{ tool.params.limit || 100 }}</span>
                            <span class="text-gray-400">条消息</span>
                          </div>
                          <!-- 时间范围（LLM 指定的年/月） -->
                          <div v-if="tool.params.year" class="text-gray-400">
                            <span>时间范围:</span>
                            <span class="ml-1 text-gray-600 dark:text-gray-300">
                              {{ tool.params.year }}年{{ tool.params.month ? `${tool.params.month}月` : '' }}
                            </span>
                          </div>
                          <!-- 时间范围（用户筛选） -->
                          <div v-else-if="tool.params._timeFilter" class="text-gray-400">
                            <span>时间范围:</span>
                            <span class="ml-1 text-gray-600 dark:text-gray-300">
                              {{ formatTimestamp((tool.params._timeFilter as { startTs: number }).startTs) }}
                            </span>
                            <span class="mx-1">至</span>
                            <span class="text-gray-600 dark:text-gray-300">
                              {{ formatTimestamp((tool.params._timeFilter as { endTs: number }).endTs) }}
                            </span>
                          </div>
                        </template>
                        <template v-else-if="tool.name === 'get_member_stats'">
                          <span class="text-gray-400">查询成员统计（前</span>
                          <span class="mx-0.5 text-gray-600 dark:text-gray-300">{{ tool.params.top_n || 10 }}</span>
                          <span class="text-gray-400">名）</span>
                        </template>
                        <template v-else-if="tool.name === 'get_time_stats'">
                          <span class="text-gray-400">统计类型:</span>
                          <span class="ml-1 text-gray-600 dark:text-gray-300">
                            {{
                              tool.params.type === 'hourly'
                                ? '按小时'
                                : tool.params.type === 'weekday'
                                  ? '按星期'
                                  : '按日期'
                            }}
                          </span>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>

            <!-- AI 思考中指示器 -->
            <div v-if="isAIThinking && !messages[messages.length - 1]?.content" class="flex items-start gap-3">
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-violet-500 to-purple-600"
              >
                <UIcon name="i-heroicons-sparkles" class="h-4 w-4 text-white" />
              </div>
              <div class="rounded-2xl rounded-tl-sm bg-gray-100 px-4 py-3 dark:bg-gray-800">
                <!-- 工具执行状态 -->
                <div v-if="currentToolStatus" class="space-y-2">
                  <div class="flex items-center gap-2">
                    <span
                      class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
                      :class="[
                        currentToolStatus.status === 'running'
                          ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
                          : currentToolStatus.status === 'done'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                            : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
                      ]"
                    >
                      <UIcon
                        :name="
                          currentToolStatus.status === 'running'
                            ? 'i-heroicons-cog-6-tooth'
                            : currentToolStatus.status === 'done'
                              ? 'i-heroicons-check-circle'
                              : 'i-heroicons-x-circle'
                        "
                        class="h-3 w-3"
                        :class="{ 'animate-spin': currentToolStatus.status === 'running' }"
                      />
                      {{ currentToolStatus.displayName }}
                    </span>
                    <span v-if="currentToolStatus.status === 'running'" class="flex gap-1">
                      <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:0ms]" />
                      <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:150ms]" />
                      <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:300ms]" />
                    </span>
                    <span
                      v-else-if="currentToolStatus.status === 'done'"
                      class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
                    >
                      <span>处理结果中</span>
                      <span class="flex gap-1">
                        <span class="h-1 w-1 animate-bounce rounded-full bg-gray-400 [animation-delay:0ms]" />
                        <span class="h-1 w-1 animate-bounce rounded-full bg-gray-400 [animation-delay:150ms]" />
                        <span class="h-1 w-1 animate-bounce rounded-full bg-gray-400 [animation-delay:300ms]" />
                      </span>
                    </span>
                  </div>
                  <!-- 已使用的工具列表 -->
                  <div v-if="toolsUsedInCurrentRound.length > 1" class="flex flex-wrap gap-1">
                    <span class="text-xs text-gray-400">已调用:</span>
                    <span
                      v-for="tool in toolsUsedInCurrentRound.slice(0, -1)"
                      :key="tool"
                      class="inline-flex items-center gap-1 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-400"
                    >
                      <UIcon name="i-heroicons-check" class="h-3 w-3 text-green-500" />
                      {{ tool }}
                    </span>
                  </div>
                </div>
                <!-- 默认状态 -->
                <div v-else class="flex items-center gap-2">
                  <span class="text-sm text-gray-600 dark:text-gray-400">正在分析问题...</span>
                  <span class="flex gap-1">
                    <span class="h-2 w-2 animate-bounce rounded-full bg-violet-500 [animation-delay:0ms]" />
                    <span class="h-2 w-2 animate-bounce rounded-full bg-violet-500 [animation-delay:150ms]" />
                    <span class="h-2 w-2 animate-bounce rounded-full bg-violet-500 [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 输入框区域 -->
        <div class="p-4 pt-0">
          <div class="mx-auto max-w-3xl">
            <ChatInput
              :disabled="isAIThinking"
              :status="isAIThinking ? 'streaming' : 'ready'"
              @send="handleSend"
              @stop="handleStop"
            />

            <!-- 底部状态栏 -->
            <div class="mt-2 flex items-center justify-between px-1">
              <div class="flex items-center gap-2 text-xs text-gray-400">
                <UIcon name="i-heroicons-sparkles" class="h-3.5 w-3.5" />
                <span>AI 对话探索</span>
              </div>

              <div class="flex items-center gap-3">
                <!-- 配置状态指示 -->
                <div
                  v-if="!isCheckingConfig"
                  class="flex items-center gap-1.5 text-xs transition-colors"
                  :class="[hasLLMConfig ? 'text-gray-400' : 'text-amber-500 font-medium']"
                >
                  <span class="h-1.5 w-1.5 rounded-full" :class="[hasLLMConfig ? 'bg-green-500' : 'bg-amber-500']" />
                  {{ hasLLMConfig ? '服务已连接' : '请在全局设置中配置 AI 服务' }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 右侧：数据源面板 -->
    <Transition name="slide-fade">
      <div
        v-if="sourceMessages.length > 0 && !isSourcePanelCollapsed"
        class="w-80 shrink-0 border-l border-gray-200 bg-gray-50/50 p-4 dark:border-gray-800 dark:bg-gray-900/50"
      >
        <DataSourcePanel
          :messages="sourceMessages"
          :keywords="currentKeywords"
          :is-loading="isLoadingSource"
          :is-collapsed="isSourcePanelCollapsed"
          class="h-full"
          @toggle="toggleSourcePanel"
          @load-more="handleLoadMore"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* Transition styles for slide-fade */
.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.3s ease-out;
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  transform: translateX(20px);
  opacity: 0;
}

/* Transition styles for slide-up (status bar) */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease-out;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(10px);
  opacity: 0;
}
</style>
