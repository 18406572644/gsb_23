<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useSessionStore } from '@/stores/session'
import { collab } from '@/collab/collab'
import type { Role } from '../../../shared/protocol'

const session = useSessionStore()

const form = reactive({
  docId: 'demo',
  name: `用户${Math.floor(Math.random() * 900 + 100)}`,
  role: 'editor' as Role,
})

const joining = ref(false)

const ROLE_DESCS: Record<Role, string> = {
  editor: '可编辑正文，也可添加与回复批注',
  commenter: '不可修改正文，可选中文字添加批注',
  viewer: '仅可查看文档、批注与他人光标',
}

function join() {
  if (!form.docId.trim() || !form.name.trim()) return
  joining.value = true
  session.joined = true
  collab.join(form.docId.trim(), form.name.trim(), form.role)
}
</script>

<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2 class="login-title">多人协同批注编辑器</h2>
      <p class="login-sub">基于 OT 的实时协同 · 支持只读 / 批注 / 编辑三种身份 · 断网自动重连</p>
      <el-form label-position="top">
        <el-form-item label="文档 ID">
          <el-input v-model="form.docId" placeholder="同一文档 ID 的用户实时协同" />
        </el-form-item>
        <el-form-item label="昵称">
          <el-input v-model="form.name" maxlength="16" placeholder="显示给其他协作者" />
        </el-form-item>
        <el-form-item label="身份">
          <el-radio-group v-model="form.role">
            <el-radio-button value="editor">编辑</el-radio-button>
            <el-radio-button value="commenter">批注</el-radio-button>
            <el-radio-button value="viewer">只读</el-radio-button>
          </el-radio-group>
          <div class="role-desc">{{ ROLE_DESCS[form.role] }}</div>
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="joining" @click="join">
          进入文档
        </el-button>
      </el-form>
      <p class="role-desc" style="margin-top: 16px">
        提示：多开几个浏览器标签页，选择不同身份加入同一文档 ID，即可体验多人实时协同。
      </p>
    </el-card>
  </div>
</template>
