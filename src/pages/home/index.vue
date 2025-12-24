<script setup lang="ts">
import { FileDropZone } from '@/components/UI'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AgreementModal from './components/AgreementModal.vue'
import MigrationModal from './components/MigrationModal.vue'
import { useSessionStore } from '@/stores/session'

const sessionStore = useSessionStore()
const { isImporting, importProgress } = storeToRefs(sessionStore)

const importError = ref<string | null>(null)

const features = [
  {
    icon: '🔒',
    title: '隐私至上',
    desc: '聊天记录本地存储本地分析，保护你的隐私。',
    color: 'text-green-500',
    bg: 'bg-green-50',
    delay: '200ms',
  },
  {
    icon: '📊',
    title: '多维度分析',
    desc: '从群榜单到群语录，全方位解读群聊数据，发现隐藏的趣味。',
    color: 'text-blue-500',
    bg: 'bg-blue-50',
    delay: '100ms',
  },
  {
    icon: '🤖',
    title: 'AI 洞察',
    desc: '内置 AI Agent，智能回答关于群聊的一切疑问，挖掘数据背后的趣事。',
    color: 'text-purple-500',
    bg: 'bg-purple-50',
    delay: '300ms',
  },
]

const router = useRouter()

// 根据会话类型导航到对应页面
async function navigateToSession(sessionId: string) {
  const session = await window.chatApi.getSession(sessionId)
  if (session) {
    const routeName = session.type === 'private' ? 'private-chat' : 'group-chat'
    router.push({ name: routeName, params: { id: sessionId } })
  }
}

// 处理文件选择（点击选择）
async function handleClickImport() {
  importError.value = null
  const result = await sessionStore.importFile()
  if (!result.success && result.error && result.error !== '未选择文件') {
    importError.value = result.error
  } else if (result.success && sessionStore.currentSessionId) {
    await navigateToSession(sessionStore.currentSessionId)
  }
}

// 处理文件拖拽
async function handleFileDrop({ paths }: { files: File[]; paths: string[] }) {
  if (paths.length === 0) {
    importError.value = '无法读取文件路径'
    return
  }

  importError.value = null
  const result = await sessionStore.importFileFromPath(paths[0])
  if (!result.success && result.error) {
    importError.value = result.error
  } else if (result.success && sessionStore.currentSessionId) {
    await navigateToSession(sessionStore.currentSessionId)
  }
}

function openTutorial() {
  window.open('https://chatlab.fun/usage/how-to-export.html?utm_source=app', '_blank')
}

function getProgressText(): string {
  if (!importProgress.value) return ''
  switch (importProgress.value.stage) {
    case 'detecting':
      return '正在检测格式...'
    case 'reading':
      return '正在读取文件...'
    case 'parsing':
      return '正在解析消息...'
    case 'saving':
      return '正在写入数据库...'
    case 'done':
      return '导入完成'
    case 'error':
      return '导入中断'
    default:
      return ''
  }
}

function getProgressDetail(): string {
  if (!importProgress.value) return ''
  const { messagesProcessed, totalBytes, bytesRead } = importProgress.value

  if (messagesProcessed && messagesProcessed > 0) {
    return `已处理 ${messagesProcessed.toLocaleString()} 条消息`
  }

  if (totalBytes && bytesRead) {
    const percent = Math.round((bytesRead / totalBytes) * 100)
    const mbRead = (bytesRead / 1024 / 1024).toFixed(1)
    const mbTotal = (totalBytes / 1024 / 1024).toFixed(1)
    return `${mbRead} MB / ${mbTotal} MB (${percent}%)`
  }

  return importProgress.value.message || ''
}
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden bg-gray-50 dark:bg-gray-950">
    <!-- Animated Background -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        class="absolute -top-[20%] -left-[10%] h-[70%] w-[70%] rounded-full bg-purple-200/30 blur-[120px] mix-blend-multiply animate-blob dark:bg-purple-900/20 dark:mix-blend-screen"
      ></div>
      <div
        class="absolute -top-[20%] -right-[10%] h-[70%] w-[70%] rounded-full bg-pink-200/30 blur-[120px] mix-blend-multiply animate-blob animation-delay-2000 dark:bg-pink-900/20 dark:mix-blend-screen"
      ></div>
      <div
        class="absolute -bottom-[20%] left-[20%] h-[70%] w-[70%] rounded-full bg-blue-200/30 blur-[120px] mix-blend-multiply animate-blob animation-delay-4000 dark:bg-blue-900/20 dark:mix-blend-screen"
      ></div>
    </div>

    <!-- Content Container -->
    <div class="relative h-full w-full overflow-y-auto">
      <div class="flex min-h-full w-full flex-col items-center justify-center px-4 py-12">
        <!-- Hero Section -->
        <div class="xl:mb-16 mb-8 text-center">
          <!-- Title -->
          <h1 class="mb-4 text-6xl sm:text-7xl lg:text-8xl font-black tracking-tight text-pink-500">ChatLab</h1>
          <!-- Description -->
          <div class="relative inline-block mb-8">
            <p class="text-lg sm:text-2xl text-gray-600 dark:text-gray-400 font-medium">
              你的本地聊天分析实验室ヾ(*ゝω・*)ノ
            </p>
            <UIcon name="i-heroicons-sparkles" class="absolute -right-6 -top-3 h-5 w-5 animate-bounce text-pink-400" />
          </div>
        </div>

        <!-- Feature Cards -->
        <div class="xl:mb-16 mb-8 grid max-w-4xl grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 px-4">
          <div
            v-for="feature in features"
            :key="feature.title"
            class="group relative overflow-hidden rounded-3xl border border-transparent p-4 transition-all duration-500"
          >
            <div class="relative">
              <div class="mb-3 flex items-center">
                <div
                  class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all duration-500 group-hover:scale-110 group-hover:rotate-3"
                >
                  <span class="text-xl filter drop-shadow-sm">{{ feature.icon }}</span>
                </div>
                <h3 class="text-lg font-bold text-gray-900 dark:text-white">
                  {{ feature.title }}
                </h3>
              </div>
              <p class="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                {{ feature.desc }}
              </p>
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex flex-col items-center space-y-6">
          <!-- Import Drop Zone -->
          <FileDropZone
            :accept="['.json', '.jsonl', '.txt']"
            :disabled="isImporting"
            class="w-full max-w-4xl"
            @files="handleFileDrop"
          >
            <template #default="{ isDragOver }">
              <div
                class="group relative flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-pink-300/50 bg-white/50 px-8 py-8 backdrop-blur-sm transition-all duration-300 hover:border-pink-400 hover:bg-white/80 hover:shadow-lg hover:shadow-pink-500/10 focus:outline-none focus:ring-4 focus:ring-pink-500/20 sm:px-12 sm:py-12 dark:border-pink-700/50 dark:bg-gray-900/50 dark:hover:border-pink-500 dark:hover:bg-gray-900/80"
                :class="{
                  'border-pink-500 bg-pink-50/50 dark:border-pink-400 dark:bg-pink-900/20': isDragOver && !isImporting,
                  'cursor-not-allowed opacity-70': isImporting,
                  'hover:scale-[1.02]': !isImporting,
                }"
                @click="!isImporting && handleClickImport()"
              >
                <!-- Icon -->
                <div
                  class="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-linear-to-br from-pink-100 to-rose-100 transition-transform duration-300 dark:from-pink-900/30 dark:to-rose-900/30"
                  :class="{ 'scale-110': isDragOver && !isImporting, 'animate-pulse': isImporting }"
                >
                  <UIcon
                    v-if="!isImporting"
                    name="i-heroicons-arrow-up-tray"
                    class="h-8 w-8 text-pink-600 transition-transform group-hover:-translate-y-1 dark:text-pink-400"
                  />
                  <UIcon
                    v-else
                    name="i-heroicons-arrow-path"
                    class="h-8 w-8 animate-spin text-pink-600 dark:text-pink-400"
                  />
                </div>

                <!-- Text -->
                <div class="w-full min-w-80 text-center">
                  <template v-if="isImporting && importProgress">
                    <!-- 导入中显示进度 -->
                    <p class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{{ getProgressText() }}</p>
                    <div class="mx-auto w-full max-w-md">
                      <UProgress v-model="importProgress.progress" size="md" />
                    </div>
                    <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">
                      {{ getProgressDetail() }}
                    </p>
                  </template>
                  <template v-else>
                    <!-- 默认状态 -->
                    <p class="text-lg font-semibold text-gray-900 dark:text-white">
                      {{ isDragOver ? '松开鼠标导入文件' : '点击选择或拖拽聊天记录导入' }}
                    </p>
                  </template>
                </div>
              </div>
            </template>
          </FileDropZone>

          <!-- Error Message -->
          <div
            v-if="importError"
            class="flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400"
          >
            <UIcon name="i-heroicons-exclamation-circle" class="h-5 w-5 shrink-0" />
            <span>{{ importError }}</span>
          </div>

          <UButton @click="openTutorial">查看聊天记录导入教程 →</UButton>
        </div>
      </div>
    </div>

    <!-- 用户协议弹窗 -->
    <AgreementModal />

    <!-- 数据库迁移弹窗 -->
    <MigrationModal />
  </div>
</template>
