<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Refresh,
  Delete,
  CircleCheck,
  CircleClose,
  Warning,
  InfoFilled,
  DocumentCopy
} from "@element-plus/icons-vue";
import {
  listDebugLogs,
  listDebugLogObjects,
  clearDebugLogs,
  type DebugLogEntry
} from "@/api/foosePureAdmin";

const props = defineProps({
  objectId: {
    type: Number,
    default: 0
  },
  objectName: {
    type: String,
    default: ""
  }
});

// ========== 状态 ==========
const loading = ref(false);
const objects = ref<Array<{ name: string; count: number }>>([]);
const selectedObject = ref(props.objectName);
const logs = ref<DebugLogEntry[]>([]);
const total = ref(0);
const warning = ref("");

const autoRefresh = ref(false);
const refreshInterval = ref(3000);
let timer: ReturnType<typeof setInterval> | null = null;

// 详情抽屉
const detailLog = ref<DebugLogEntry | null>(null);
const detailVisible = ref(false);
const activeTab = ref<"request" | "response">("request");

// ========== 项目下拉 ==========
async function fetchObjects() {
  try {
    const res = await listDebugLogObjects();
    //console.log(res);
    objects.value = res.objects ?? [];
    // 如果选的项目已不在列表中，自动切到第一个
    if (!selectedObject.value && objects.value.length > 0) {
      selectedObject.value = objects.value[0].name;
    }
  } catch (e: any) {
    console.warn("获取 debug 项目列表失败:", e?.message);
  }
}

// ========== 拉日志 ==========
async function fetchLogs() {
  if (!selectedObject.value) return;
  loading.value = true;
  try {
    const res = await listDebugLogs(selectedObject.value, 200);
    logs.value = res.items ?? [];
    total.value = res.total ?? logs.value.length;
    warning.value = res.warning ?? "";
  } catch (e: any) {
    ElMessage.error(e?.message ?? "获取日志失败");
  } finally {
    loading.value = false;
  }
}

function onObjectChange() {
  fetchLogs();
}

// ========== 自动刷新 ==========
function startAutoRefresh() {
  stopAutoRefresh();
  if (!autoRefresh.value || !selectedObject.value) return;
  timer = setInterval(() => {
    fetchLogs();
  }, refreshInterval.value);
}
function stopAutoRefresh() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
watch([autoRefresh, refreshInterval, selectedObject], () => {
  if (autoRefresh.value && selectedObject.value) startAutoRefresh();
  else stopAutoRefresh();
});

// ========== 清空 ==========
async function handleClear() {
  if (!selectedObject.value) return;
  try {
    await ElMessageBox.confirm(
      `确定清空项目 "${selectedObject.value}" 的全部 debug 日志吗？此操作不可恢复。`,
      "清空日志",
      { type: "warning", confirmButtonText: "确定清空", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    await clearDebugLogs(selectedObject.value);
    logs.value = [];
    total.value = 0;
    ElMessage.success("已清空");
    // 刷新项目列表里的 count
    await fetchObjects();
  } catch (e: any) {
    ElMessage.error(e?.message ?? "清空失败");
  }
}

// ========== 详情 ==========
function showDetail(row: DebugLogEntry | Record<string, unknown>) {
  detailLog.value = row as DebugLogEntry;
  activeTab.value = "request";
  detailVisible.value = true;
}
function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(2)}ms`;
}
function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${(d.getMilliseconds() + "").padStart(3, "0")}`;
}
function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(ts)}`;
}
function jsonPreview(val: unknown): string {
  if (val === undefined) return "（无）";
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

// ========== 状态码 tag ==========
function statusTagType(code: number): "success" | "warning" | "danger" | "info" {
  if (code >= 200 && code < 300) return "success";
  if (code >= 300 && code < 400) return "info";
  if (code >= 400 && code < 500) return "warning";
  return "danger";
}

// ========== 方法 tag ==========
const methodColor: Record<string, string> = {
  GET: "#67c23a",
  POST: "#409eff",
  PUT: "#e6a23c",
  PATCH: "#9b59b6",
  DELETE: "#f56c6c",
  OPTIONS: "#909399"
};
function methodStyle(m: string) {
  return { backgroundColor: methodColor[m] ?? "#909399", color: "#fff" };
}

// ========== 拷贝 ==========
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("浏览器不支持剪贴板 API");
  }
}

// ========== 生命周期 ==========
onMounted(async () => {
  await fetchObjects();
  if (selectedObject.value) await fetchLogs();
});
onBeforeUnmount(() => stopAutoRefresh());

// ========== 过滤 ==========
const keyword = ref("");
const filteredLogs = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return logs.value;
  return logs.value.filter(
    l =>
      l.url.toLowerCase().includes(k) ||
      l.path.toLowerCase().includes(k) ||
      l.table?.toLowerCase().includes(k) ||
      l.object?.toLowerCase().includes(k) ||
      l.error?.toLowerCase().includes(k) ||
      String(l.statusCode).includes(k)
  );
});
</script>

<template>
  <div>
    <el-row :gutter="10">
      <el-col :span="6">
        <el-select v-model="selectedObject" placeholder="请选择项目" @change="onObjectChange">
          <el-option
            v-for="o in objects"
            :key="o.name"
            :label="`${o.name} (${o.count}条)`"
            :value="o.name"
            :disabled="o.count === 0"
          />
        </el-select>
      </el-col>
      <el-col :span="6">
        <el-input v-model="keyword" placeholder="过滤 URL / 表名 / 状态码" clearable />
      </el-col>
      <el-col :span="12">
        <el-button :icon="Refresh" :loading="loading" @click="fetchLogs"> 刷新 </el-button>
        <el-button
          :icon="Delete"
          type="danger"
          plain
          :disabled="!selectedObject || logs.length === 0"
          @click="handleClear"
        >
          清空
        </el-button>
        <el-switch
          v-model="autoRefresh"
          active-text="自动刷新"
          inactive-text="手动刷新"
          inline-prompt
          class="ml-3"
        />
        <el-input-number
          v-if="autoRefresh"
          v-model="refreshInterval"
          :min="500"
          :max="30000"
          :step="500"
          :precision="0"
          controls-position="right"
          class="ml-8"
          style="width: 130px"
        >
          <template #suffix>ms</template>
        </el-input-number>
        <el-tag v-if="warning" type="warning" class="ml-12" effect="light">
          {{ warning }}
        </el-tag>
      </el-col>
    </el-row>
    <!-- 表格 -->
    <el-table
      v-loading="loading"
      :data="filteredLogs"
      size="small"
      stripe
      border
      max-height="400"
      empty-text="暂无 debug 日志（请先在项目管理中开启 debug 开关，然后发请求即可自动记录）"
    >
      <el-table-column label="时间" width="160" fixed>
        <template #default="{ row }">
          {{ formatTime(row.timestamp) }}
        </template>
      </el-table-column>

      <el-table-column label="方法" width="90" align="center">
        <template #default="{ row }">
          <el-tag type="info" size="small">{{ row.method }}</el-tag>
        </template>
      </el-table-column>

      <el-table-column prop="url" label="URL(点击跳转)" min-width="300"  >
        <template #default="{ row }">          
          <el-link type="primary" :href="row.url" target="_blank" underline="never">{{ row.url }}</el-link>
        </template>
      </el-table-column>
      <!--
      <el-table-column label="表名" width="300">
        <template #default="{ row }">
          <el-tag v-if="row.table" size="small" effect="plain">{{ row.table }}</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      -->

      <el-table-column label="状态" width="80" align="center">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.statusCode)" size="small" effect="dark">
            {{ row.statusCode }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="耗时" width="80" align="right">
        <template #default="{ row }">
          <span :class="{ fast: row.durationMs < 50, slow: row.durationMs >= 500 }">
            {{ formatDuration(row.durationMs) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="ip" label="IP" width="130" />
      <el-table-column label="详情" width="80" fixed="right" align="center">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="showDetail(row)"> 查看 </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="footer-info">
      共 {{ filteredLogs.length }} 条
      <span v-if="total !== filteredLogs.length">（Redis 共 {{ total }} 条，显示过滤后）</span>
      <span class="muted"> · 最多保留最近 1000 条</span>
    </div>

    <!-- 详情抽屉 -->
    <el-drawer
      v-model="detailVisible"
      title="请求详情"
      size="60vw"
      direction="rtl"
    >     
      <template v-if="detailLog">
        <div>请求时间: {{ formatDate(detailLog.timestamp) }}</div>
        <div class="mt-1">接口名称: {{ selectedObject }}</div>
        <div class="mt-1">请求方法:
          <el-tag type="primary" size="small">{{ detailLog.method }}</el-tag>
          &nbsp;请求IP: {{ detailLog.ip }}
          &nbsp;状态码: 
          <el-tag :type="statusTagType(detailLog.statusCode)" size="small" effect="dark">
            {{ detailLog.statusCode }}
          </el-tag> 
          &nbsp;响应时间: {{ formatDuration(detailLog.durationMs) }}
        </div>        
        <div v-if="detailLog.error" class="mt-1">
          <el-text type="danger" size="small" :icon="CircleClose" >
            {{ detailLog.error }}
          </el-text>
          </div>
        
        <div class="auto-wrap mt-1">请求URL: 
          <el-link type="primary" :href="detailLog.url" target="_blank" underline="never">{{ detailLog.url }}</el-link>
        </div>         
        
        <el-tabs v-model="activeTab" class="detail-tabs">
          <el-tab-pane label="请求" name="request">
            <el-collapse accordion>
              <el-collapse-item name="url" title="URL & 路由">
                <div class="kv-row">
                  <span class="kv-k">URL</span><span class="kv-v mono">{{ detailLog.url }}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-k">路由模板</span
                  ><span class="kv-v mono">{{ detailLog.path }}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-k">项目</span
                  ><span class="kv-v">{{ detailLog.object || "—" }}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-k">表</span><span class="kv-v">{{ detailLog.table || "—" }}</span>
                </div>
              </el-collapse-item>

              <el-collapse-item name="headers" title="请求头">
                <div v-for="(v, k) in detailLog.request.headers" :key="k" class="kv-row">
                  <span class="kv-k">{{ k }}</span>
                  <span class="kv-v mono">{{ v }}</span>
                </div>
              </el-collapse-item>

              <el-collapse-item
                v-if="detailLog.request.query && Object.keys(detailLog.request.query).length"
                name="query"
                title="Query 参数"
              >
                <div v-for="(v, k) in detailLog.request.query" :key="k" class="kv-row">
                  <span class="kv-k">{{ k }}</span>
                  <span class="kv-v mono">{{ v }}</span>
                </div>
              </el-collapse-item>

              <el-collapse-item
                v-if="detailLog.request.params && Object.keys(detailLog.request.params).length"
                name="params"
                title="Path 参数"
              >
                <div v-for="(v, k) in detailLog.request.params" :key="k" class="kv-row">
                  <span class="kv-k">{{ k }}</span>
                  <span class="kv-v mono">{{ v }}</span>
                </div>
              </el-collapse-item>

              <el-collapse-item
                v-if="detailLog.request.body !== undefined && detailLog.request.body !== null"
                name="body"
                title="请求 Body"
              >
                <pre class="code-block">{{ jsonPreview(detailLog.request.body) }}</pre>
              </el-collapse-item>
            </el-collapse>
          </el-tab-pane>

          <el-tab-pane label="响应" name="response">
            <el-collapse accordion>
              <el-collapse-item name="status" title="状态 & 耗时">
                <div class="kv-row">
                  <span class="kv-k">状态码</span
                  ><span class="kv-v">{{ detailLog.statusCode }}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-k">耗时</span
                  ><span class="kv-v">{{ formatDuration(detailLog.durationMs) }}</span>
                </div>
                <div v-if="detailLog.error" class="kv-row">
                  <span class="kv-k">错误</span
                  ><span class="kv-v error-text">{{ detailLog.error }}</span>
                </div>
              </el-collapse-item>
            </el-collapse>
            <div v-if="!detailLog.error && !detailLog.response" class="muted hint">
              （响应体在 onSend 阶段已发出，debug 日志不额外记录以避免 Redis 膨胀）
            </div>
            <pre v-if="detailLog.response" class="code-block">{{
              jsonPreview(detailLog.response)
            }}</pre>
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-drawer>
  </div>
</template>

<style lang="scss" scoped>
:deep(.el-drawer__header){
margin-bottom: 0;
}
.auto-wrap {
  word-break: break-word;
  overflow-wrap: break-word;
}

.debug-log-page {
  padding: 16px;
  background: var(--el-bg-color);
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;

  .toolbar-left,
  .toolbar-right {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }
  .label {
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }
  .ml-8 {
    margin-left: 8px;
  }
  .ml-12 {
    margin-left: 12px;
  }
}

.method-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  min-width: 54px;
  text-align: center;
}

.fast {
  color: #67c23a;
  font-weight: 600;
}
.slow {
  color: #f56c6c;
  font-weight: 600;
}

.muted {
  color: var(--el-text-color-placeholder, #909399);
}

.footer-info {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.detail-header {
  margin-bottom: 16px;

  .detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;
  }
  .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
  }
  .meta-icon {
    font-size: 14px;
    &.ok {
      color: #67c23a;
    }
    &.error {
      color: #f56c6c;
    }
  }
  .detail-error {
    margin-top: 10px;
    padding: 10px 12px;
    background: var(--el-color-danger-light-9);
    border-radius: 6px;
    color: var(--el-color-danger);
    font-size: 13px;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    .error-icon {
      flex-shrink: 0;
      margin-top: 2px;
    }
  }
}

.detail-tabs {
  margin-top: 8px;
}

.kv-row {
  display: flex;
  align-items: flex-start;
  padding: 5px 0;
  border-bottom: 1px dashed var(--el-border-color-lighter);

  .kv-k {
    flex-shrink: 0;
    width: 110px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
  .kv-v {
    flex: 1;
    font-size: 13px;
    word-break: break-all;
    &.mono {
      font-family: Menlo, Monaco, Consolas, monospace;
    }
    &.error-text {
      color: var(--el-color-danger);
    }
  }
}

.code-block {
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12.5px;
  font-family: Menlo, Monaco, Consolas, monospace;
  max-height: 360px;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.hint {
  padding: 8px 0;
  font-size: 12px;
}
</style>
