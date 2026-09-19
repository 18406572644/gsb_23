import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Annotation } from '../../../shared/protocol'

export type SyncState = 'synced' | 'pending' | 'resyncing'

/** 文档状态：正文、版本、批注、当前选区 */
export const useDocStore = defineStore('doc', () => {
  const text = ref('')
  const revision = ref(0)
  const annotations = ref<Annotation[]>([])
  const syncState = ref<SyncState>('synced')
  /** 当前编辑器选区（用于创建批注） */
  const selection = ref<{ start: number; end: number } | null>(null)
  /** 面板点击「定位」时编辑器滚动到该批注（计数器触发 watch） */
  const locateTarget = ref<{ annId: string; n: number } | null>(null)
  /** 当前高亮（激活）的批注 */
  const activeAnnId = ref<string | null>(null)

  const sortedAnnotations = computed(() =>
    [...annotations.value].sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1
      return a.start - b.start
    }),
  )
  const unresolvedCount = computed(() => annotations.value.filter((a) => !a.resolved).length)

  function upsertAnnotation(ann: Annotation) {
    const i = annotations.value.findIndex((a) => a.id === ann.id)
    if (i >= 0) annotations.value[i] = ann
    else annotations.value.push(ann)
  }

  function removeAnnotation(annId: string) {
    annotations.value = annotations.value.filter((a) => a.id !== annId)
    if (activeAnnId.value === annId) activeAnnId.value = null
  }

  function locate(annId: string) {
    activeAnnId.value = annId
    locateTarget.value = { annId, n: (locateTarget.value?.n ?? 0) + 1 }
  }

  function $reset() {
    text.value = ''
    revision.value = 0
    annotations.value = []
    syncState.value = 'synced'
    selection.value = null
    locateTarget.value = null
    activeAnnId.value = null
  }

  return {
    text,
    revision,
    annotations,
    syncState,
    selection,
    locateTarget,
    activeAnnId,
    sortedAnnotations,
    unresolvedCount,
    upsertAnnotation,
    removeAnnotation,
    locate,
    $reset,
  }
})
