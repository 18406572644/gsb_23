<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { collab } from '@/collab/collab'
import type { Annotation } from '../../../shared/protocol'

const session = useSessionStore()
const doc = useDocStore()

const filter = ref<'all' | 'open' | 'resolved'>('all')
const replyDrafts = reactive<Record<string, string>>({})

const filtered = computed(() => {
  if (filter.value === 'open') return doc.sortedAnnotations.filter((a) => !a.resolved)
  if (filter.value === 'resolved') return doc.sortedAnnotations.filter((a) => a.resolved)
  return doc.sortedAnnotations
})

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function locate(ann: Annotation) {
  doc.locate(ann.id)
}

function toggleResolve(ann: Annotation) {
  collab.resolveAnnotation(ann.id, !ann.resolved)
}

async function remove(ann: Annotation) {
  try {
    await ElMessageBox.confirm('确定删除这条批注吗？', '删除批注', { type: 'warning' })
  } catch {
    return
  }
  collab.deleteAnnotation(ann.id)
}

function canDelete(ann: Annotation) {
  return ann.authorId === session.clientId || session.canEdit
}

function reply(ann: Annotation) {
  const text = (replyDrafts[ann.id] || '').trim()
  if (!text) return
  collab.replyAnnotation(ann.id, text)
  replyDrafts[ann.id] = ''
}
</script>

<template>
  <div class="ann-panel">
    <div class="ann-panel-header">
      <div style="display: flex; align-items: center; margin-bottom: 8px">
        <span style="font-weight: 600">批注</span>
        <el-tag size="small" effect="plain" style="margin-left: 8px">
          {{ doc.unresolvedCount }} 未解决
        </el-tag>
        <div class="spacer" style="flex: 1" />
        <el-radio-group v-model="filter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="open">未解决</el-radio-button>
          <el-radio-button value="resolved">已解决</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <div class="ann-list">
      <div v-if="filtered.length === 0" class="ann-empty">
        <template v-if="session.canAnnotate">选中正文文字即可添加批注</template>
        <template v-else>暂无批注</template>
      </div>

      <div
        v-for="ann in filtered"
        :key="ann.id"
        class="ann-card"
        :class="{ active: doc.activeAnnId === ann.id, resolved: ann.resolved }"
        @click="locate(ann)"
      >
        <p class="ann-quote">
          <template v-if="ann.orphan">📌 原文已被删除：{{ ann.quote || '（空）' }}</template>
          <template v-else>{{ ann.quote || '（空）' }}</template>
        </p>
        <p class="ann-text">{{ ann.text }}</p>
        <div class="ann-meta">
          <span>{{ ann.authorName }}</span>
          <span>{{ fmtTime(ann.createdAt) }}</span>
          <el-tag v-if="ann.resolved" size="small" type="success" effect="plain">已解决</el-tag>
        </div>

        <div v-if="ann.replies.length" class="ann-replies">
          <div v-for="r in ann.replies" :key="r.id" class="ann-reply-item">
            <b>{{ r.authorName }}：</b>{{ r.text }}
            <span style="color: #c0c4cc">　{{ fmtTime(r.createdAt) }}</span>
          </div>
        </div>

        <div class="ann-actions" @click.stop>
          <el-button size="small" text @click="locate(ann)">定位</el-button>
          <el-button v-if="session.canAnnotate" size="small" text type="success" @click="toggleResolve(ann)">
            {{ ann.resolved ? '重开' : '解决' }}
          </el-button>
          <el-button v-if="canDelete(ann)" size="small" text type="danger" @click="remove(ann)">删除</el-button>
        </div>

        <div v-if="session.canAnnotate" class="ann-replies" @click.stop>
          <el-input
            v-model="replyDrafts[ann.id]"
            size="small"
            placeholder="回复…（回车发送）"
            @keydown.enter="reply(ann)"
          >
            <template #append>
              <el-button size="small" @click="reply(ann)">回复</el-button>
            </template>
          </el-input>
        </div>
      </div>
    </div>
  </div>
</template>
