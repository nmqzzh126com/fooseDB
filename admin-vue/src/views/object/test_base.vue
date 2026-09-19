<script setup lang="ts">
import { ObjectDef, testConnection } from '@/api/foosePureAdmin';
import { ref, reactive, onMounted } from 'vue'
import { Grid, Delete, Plus, Loading, User, Lock } from "@element-plus/icons-vue";
const props = defineProps({
  pageUrl: {
    type: String,
    default: ''
  },
  apiName: {
    type: String,
    default: ''
  },
  dbType: {
    type: String,
    default: ''
  },
  dbPath: {
    type: String,
    default: ''
  },
  dbUrl: {
    type: String,
    default: ''
  }
})
const testStatus = ref("");
const testMsg = ref("");
const tableName = ref("");
onMounted(async () => {
  await onTestConnection();
})
async function onTestConnection() {
  if (!props.dbType) {
    testStatus.value = "error";
    testMsg.value = "数据库类型未配置";
    return;
  }
  if (props.dbType === "sqlite" && !props.dbPath) {
    testStatus.value = "error";
    testMsg.value = "SQLite 需要填写数据库文件路径";
    return;
  }
  if (props.dbType !== "sqlite" && !props.dbUrl) {
    testStatus.value = "error";
    testMsg.value = "需要填写数据库连接串 db_url";
    return;
  }
  testStatus.value = "loading";
  testMsg.value = "正在测试连接...";
  try {
    const res = await testConnection({
      db_type: props.dbType as ObjectDef["db_type"],
      db_url: props.dbUrl || null,
      db_path: props.dbPath || null
    });
    testStatus.value = "success";
    testMsg.value = res.message ?? "连接成功";
  } catch (err: any) {
    testStatus.value = "error";
    testMsg.value = err?.message ?? "连接失败";
  }
}
</script>
<template>
  <div class="p-2">

    <el-text type="info"> 接口前缀: </el-text>
    <el-text type="primary">
      {{ pageUrl }}/{{ apiName }}
    </el-text>
    <!--
     <span v-if="dbUrl">
      <el-text type="info"> 数据库连接字符: </el-text>
      <el-text type="warning">db_url: {{ dbUrl }}</el-text>
    </span>
    <span v-if="dbPath">
      <el-text type="info"> 数据库路径: </el-text>
      <el-text type="info">{{ dbPath }}</el-text>
    </span>
    -->
    <el-text v-if="testStatus === 'success'" type="success">
      ✅ {{ testMsg }}
    </el-text>
    <el-text v-else type="danger">❌ {{ testMsg }}</el-text>

    <el-button class="ml-5!" type="primary" size="small" plain :loading="testStatus === 'loading'"
      @click="onTestConnection">
      测试连接&nbsp;({{ dbType }})
    </el-button>
    <div>
      <el-input v-model="tableName" placeholder="输入表名，如 users / posts" class="w-64" clearable>
        <template #prefix>
          <el-icon>
            <Grid />
          </el-icon>
        </template>
      </el-input>
      <!-- 业务用户登录表单 

      <div class="demo-panel">
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center gap-2">
              <span class="font-semibold text-sm">� 模拟客户端身份</span>
              <el-tag size="small" :type="decodedPayload ? 'success' : 'info'">
                {{ decodedPayload ? "已登录（业务用户）" : "未登录（匿名）" }}
              </el-tag>
            </div>
          </template>
          <div class="flex flex-col gap-3">
            
            <div class="flex items-center gap-2 flex-wrap">
              <el-input v-model="bizUsername" size="small" placeholder="业务用户名" class="w-40" :prefix-icon="User"
                clearable />
              <el-input v-model="bizPassword" size="small" type="password" placeholder="密码" class="w-40"
                :prefix-icon="Lock" show-password clearable @keyup.enter="onLoginAsBusiness" />
              <el-button size="small" type="primary" :loading="loginLoading" @click="onLoginAsBusiness">
                业务用户登录
              </el-button>
              <el-button v-if="decodedPayload" size="small" plain @click="onLogoutBusiness">
                清除登录态
              </el-button>
              <el-button size="small" plain @click="setAnonymous">匿名访问</el-button>
            </div>

         
      <div v-if="decodedPayload" class="bg-gray-50 rounded p-2 text-xs flex flex-wrap gap-3">
        <span>🆔 sub: <strong>{{ decodedPayload.sub }}</strong></span>
        <span>👤 username: <strong>{{ decodedPayload.username }}</strong></span>
        <span v-if="decodedPayload.nickname">
          📛 nickname: <strong>{{ decodedPayload.nickname }}</strong>
        </span>
        <span>
          🏷️ object_id:
          <el-tag size="small"
            :type="decodedPayload.object_id > 0 ? 'success' : decodedPayload.object_id === -1 ? 'warning' : 'info'">
            {{ decodedPayload.object_id }}
          </el-tag>
        </span>
        <span v-if="decodedPayload.scope">
          🛡️ scope: <strong>{{ decodedPayload.scope }}</strong>
        </span>
        <span v-if="decodedPayload.exp">
          ⏰ 过期:
          <strong>{{ new Date(decodedPayload.exp * 1000).toLocaleString() }}</strong>
        </span>
      </div>
      <div v-else class="bg-gray-50 rounded p-2 text-xs text-gray-500">
        未登录状态下请求接口将以匿名身份发送；仅当项目的 auth_required=0 或表级规则允许匿名访问时才可成功。
      </div>

     
      <el-collapse>
        <el-collapse-item name="advanced">
          <template #title>
            <span class="text-xs text-gray-500">高级：手动覆盖 Token / API 地址 / 指纹</span>
          </template>
          <div class="flex flex-col gap-2 pt-1">
            <div class="flex gap-2 items-center">
              <el-text size="small" class="w-28 shrink-0">API 基础地址</el-text>
              <el-input v-model="customBaseUrl" size="small" placeholder="/api 或 http://192.168.1.100:8858/api"
                clearable />
              <el-text size="small" type="info">默认同源 /api</el-text>
            </div>
            <div class="flex gap-2 items-center">
              <el-text size="small" class="w-28 shrink-0">Bearer Token</el-text>
              <el-input v-model="customToken" size="small" placeholder="可手动粘贴外部 token（通常由上方登录自动填充）" show-password
                clearable />
            </div>
            <div class="flex gap-2 items-center">
              <el-text size="small" class="w-28 shrink-0">X-Client-Id 指纹</el-text>
              <el-input v-model="customClientId" size="small" placeholder="留空则用当前浏览器默认指纹" clearable />
              <el-button size="small" text type="primary" @click="customClientId = getClientId()">
                重置为默认
              </el-button>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>
    </el-card>
  </div>
  -->
    </div>
  </div>
</template>
<style lang='scss' scoped></style>