import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Role, UserInfo } from '../../../shared/protocol'
import type { ConnStatus } from '@/ws/wsClient'

/** 会话状态：连接、身份、在线用户、远程光标 */
export const useSessionStore = defineStore('session', () => {
  const joined = ref(false)
  const docId = ref('demo')
  const name = ref('')
  const role = ref<Role>('editor')
  const clientId = ref('')
  const users = ref<UserInfo[]>([])
  const cursors = ref<Record<string, { start: number; end: number }>>({})
  const status = ref<ConnStatus>('offline')
  const reconnectAttempt = ref(0)
  /** 用户手动模拟断网 */
  const simulatedOffline = ref(false)

  const canEdit = computed(() => role.value === 'editor')
  const canAnnotate = computed(() => role.value === 'editor' || role.value === 'commenter')
  const online = computed(() => status.value === 'online')

  function setUsers(list: UserInfo[]) {
    users.value = list
    // 清理已离开用户的光标
    const ids = new Set(list.map((u) => u.clientId))
    for (const id of Object.keys(cursors.value)) {
      if (!ids.has(id)) delete cursors.value[id]
    }
  }

  function $reset() {
    joined.value = false
    clientId.value = ''
    users.value = []
    cursors.value = {}
    status.value = 'offline'
    reconnectAttempt.value = 0
    simulatedOffline.value = false
  }

  return {
    joined,
    docId,
    name,
    role,
    clientId,
    users,
    cursors,
    status,
    reconnectAttempt,
    simulatedOffline,
    canEdit,
    canAnnotate,
    online,
    setUsers,
    $reset,
  }
})
