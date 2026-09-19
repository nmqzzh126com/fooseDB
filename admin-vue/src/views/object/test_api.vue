<script setup lang="ts">
defineOptions({
  name: "ObjectTestApi"
});
import { ObjectDef, testConnection, login, getObjectDetail } from "@/api/foosePureAdmin";
import { extractCn, getClientId } from "@/utils/http";
import Axios from "axios";
import { useTabTestApiDetail } from "@/utils/hooks";
const { initToTestApiDetail, getParameter } = useTabTestApiDetail();
initToTestApiDetail();
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Grid, Delete, Plus, Loading, User, Lock } from "@element-plus/icons-vue";
import testBase from "@/views/object/test_base.vue";
import testList from "@/views/object/test_list.vue";
const activeName = ref('get-page-list')
const objectRow = ref<ObjectDef | null>(null);
const route = useRoute();
const resolvedApiName = computed(() => {
  return objectRow.value?.name || "";
});
const resolvedDbType = computed(() => {
  return objectRow.value?.db_type || "";
});
const resolvedDbUrl = computed(() => {
  return objectRow.value?.db_url || "";
});
const resolvedDbPath = computed(() => {
  return objectRow.value?.db_path || "";
});

const testStatus = ref("");
const testMsg = ref("");

async function onTestConnection() {
  if (!resolvedDbType.value) {
    testStatus.value = "error";
    testMsg.value = "请先选择数据库类型";
    return;
  }
  if (resolvedDbType.value === "sqlite" && !resolvedDbPath.value) {
    testStatus.value = "error";
    testMsg.value = "SQLite 需要填写数据库文件路径";
    return;
  }
  if (resolvedDbType.value !== "sqlite" && !resolvedDbUrl.value) {
    testStatus.value = "error";
    testMsg.value = "需要填写数据库连接串 db_url";
    return;
  }
  testStatus.value = "loading";
  testMsg.value = "正在测试连接...";
  try {
    const res = await testConnection({
      db_type: resolvedDbType.value as ObjectDef["db_type"],
      db_url: resolvedDbUrl.value || null,
      db_path: resolvedDbPath.value || null
    });
    testStatus.value = "success";
    testMsg.value = res.message ?? "连接成功";
  } catch (err: any) {
    testStatus.value = "error";
    testMsg.value = err?.message ?? "连接失败";
  }
}


onMounted(async () => {
  objectRow.value = await getObjectDetail(Number(getParameter?.id || 0));
  if (!objectRow.value) {
    ElMessage.error("未找到接口信息");
    return;
  }
  await nextTick();
  await onTestConnection();
  customClientId.value = getClientId();
});

/* ============ API 地址展示 ============ */
//用正则表达式从http://10.21.67.168:8848/login#/object/test-api?id=1中提取ttp://10.21.67.168:8848 部分
// 说明：
// 1. 匹配 http:// 开头的字符串，直到第一个空格或换行符
// 2. 匹配到的字符串就是 http://ip或域名:端口号 部分
// 3. 也要适配 https:// 开头的字符串
const pageUrl = computed(() => window.location.href.match(/^(https?:\/\/[^/#?]+)/)?.[0] || "");
const routePath = computed(() => route.fullPath);

/* ============ 🔑 客户端模拟：身份参数 ============ */
//const customBaseUrl = ref("/api");
const customBaseUrl = computed(() => pageUrl.value + "/api" || "/api");
const customToken = ref("");
const customClientId = ref("");

/* ============ 👤 业务用户登录（真实客户端场景） ============ */
const bizUsername = ref("");
const bizPassword = ref("");
const loginLoading = ref(false);
/** 登录后解码的 JWT payload — 展示模拟身份 */
const decodedPayload = ref<{
  sub: number;
  username: string;
  nickname: string | null;
  object_id: number;
  scope?: string;
  type?: string;
  exp?: number;
} | null>(null);

async function onLoginAsBusiness() {
  if (!bizUsername.value.trim() || !bizPassword.value) {
    ElMessage.warning("请输入业务用户名和密码");
    return;
  }
  loginLoading.value = true;
  try {
    const res = await login(bizUsername.value.trim(), bizPassword.value);
    customToken.value = res.access_token;
    decodedPayload.value = res.payload;
    ElMessage.success(
      `登录成功 — 用户: ${res.payload.username} (object_id=${res.payload.object_id})`
    );
  } catch (err: any) {
    ElMessage.error(err?.message ?? "登录失败");
  } finally {
    loginLoading.value = false;
  }
}


function onLogoutBusiness() {
  customToken.value = "";
  decodedPayload.value = null;
  ElMessage.info("已清除模拟登录态");
}

function setAnonymous() {
  customToken.value = "";
  decodedPayload.value = null;
  customClientId.value = getClientId();
  ElMessage.info("已切换为匿名访问");
}

/* ============ 本地 axios 实例（动态绑定身份参数） ============ */
const testClient = computed(() => {
  const client = Axios.create({
    baseURL: customBaseUrl.value || "/api",
    timeout: 15000,
    headers: { "Content-Type": "application/json", Accept: "application/json" }
  });

  client.interceptors.request.use(config => {
    config.headers = (config.headers ?? {}) as typeof config.headers;
    config.headers["X-Client-Id"] = customClientId.value?.trim() || getClientId();
    const t = customToken.value?.trim();
    if (t) config.headers["Authorization"] = `Bearer ${t}`;
    return config;
  });

  client.interceptors.response.use(
    res => {
      const body = res.data;
      if (body && typeof body === "object") {
        if ("data" in body && Object.keys(body).length === 1) return body.data;
        if ("ok" in body) return body;
      }
      return body;
    },
    err => {
      const status = err.response?.status ?? 0;
      const raw = err.response?.data?.error ?? err.message;
      const display = extractCn(raw, `请求失败 (${status})`);
      return Promise.reject(new Error(display));
    }
  );

  return client;
});

/* ============ 交互测试：方法 & 参数 ============ */
type Method = "get-list" | "get-id" | "post" | "put" | "delete";

const method = ref<Method>("get-list");
const tableName = ref("");
const idValue = ref<string | number>("");

const paramPage = ref(1);
const paramPageSize = ref(10);
const paramFields = ref("");
const paramOrderBy = ref("");
const paramOrder = ref<"asc" | "desc">("asc");
const paramJoin = ref("");
const paramNopage = ref(false);
const paramOne = ref(false);

interface FilterKV {
  key: string;
  value: string;
}
const filters = ref<FilterKV[]>([{ key: "", value: "" }]);
function addFilter() {
  filters.value.push({ key: "", value: "" });
}
function removeFilter(i: number) {
  filters.value.splice(i, 1);
}

const bodyText = ref('{\n  \n}');

const loading = ref(false);
const response = ref<any>(null);
const errorMsg = ref("");
const responseTab = ref<"table" | "raw" | "object">("table");
const requestUrl = ref("");
const requestMethod = ref("GET");

/* ============ 计算：当前请求 URL（示例展示） ============ */
const exampleUrl = computed(() => {
  const obj = resolvedApiName.value || ":object";
  const tbl = tableName.value.trim() || ":table";
  const base = `${customBaseUrl.value || "/api"}/${obj}/${tbl}`;

  if (method.value === "get-id" && idValue.value !== "") {
    return `${base}/${idValue.value}`;
  }
  if (method.value === "put" || method.value === "delete") {
    return `${base}/${idValue.value || ":id"}`;
  }

  if (method.value === "get-list") {
    const qs: string[] = [];
    if (!paramNopage.value) {
      qs.push(`page=${paramPage.value}`);
      qs.push(`pageSize=${paramPageSize.value}`);
    } else {
      qs.push(`nopage=1`);
    }
    if (paramOne.value) qs.push(`__one=1`);
    if (paramFields.value.trim()) qs.push(`fields=${encodeURIComponent(paramFields.value.trim())}`);
    if (paramOrderBy.value.trim()) qs.push(`orderBy=${encodeURIComponent(paramOrderBy.value.trim())}`);
    if (paramOrder.value && paramOrderBy.value.trim()) qs.push(`order=${paramOrder.value}`);
    if (paramJoin.value.trim()) qs.push(`join=${encodeURIComponent(paramJoin.value.trim())}`);
    for (const f of filters.value) {
      if (f.key.trim()) qs.push(`${encodeURIComponent(f.key.trim())}=${encodeURIComponent(f.value)}`);
    }
    return qs.length ? `${base}?${qs.join("&")}` : base;
  }
  return base;
});

const exampleMethod = computed<"GET" | "POST" | "PUT" | "DELETE">(() => {
  switch (method.value) {
    case "get-list":
    case "get-id":
      return "GET";
    case "post":
      return "POST";
    case "put":
      return "PUT";
    case "delete":
      return "DELETE";
    default:
      return "GET";
  }
});

/* ============ 响应解析 ============ */
const isListResponse = computed(() => {
  if (!response.value) return false;
  if (
    typeof response.value === "object" &&
    response.value !== null &&
    Array.isArray(response.value.data)
  ) {
    return true;
  }
  if (Array.isArray(response.value)) return true;
  return false;
});

const tableData = computed<any[]>(() => {
  if (!response.value) return [];
  if (Array.isArray(response.value)) return response.value;
  if (Array.isArray(response.value.data)) return response.value.data;
  return [];
});

const tableColumns = computed(() => {
  const rows = tableData.value;
  if (!rows.length) return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object") {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
    }
  }
  return keys;
});

const rawJson = computed(() => {
  if (response.value == null) return "";
  try {
    return JSON.stringify(response.value, null, 2);
  } catch {
    return String(response.value);
  }
});

/* ============ 执行请求 ============ */
async function execute() {
  errorMsg.value = "";
  response.value = null;
  requestUrl.value = exampleUrl.value;
  requestMethod.value = exampleMethod.value;

  const objName = resolvedApiName.value;
  const tblName = tableName.value.trim();
  if (!objName) {
    errorMsg.value = "项目名 (apiName) 为空";
    return;
  }
  if (!tblName) {
    errorMsg.value = "请输入表名";
    return;
  }
  if ((method.value === "get-id" || method.value === "put" || method.value === "delete") && idValue.value === "") {
    errorMsg.value = "请输入主键 id";
    return;
  }

  let parsedBody: Record<string, unknown> | null = null;
  if (method.value === "post" || method.value === "put") {
    try {
      parsedBody = JSON.parse(bodyText.value);
      if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
        errorMsg.value = "Body 必须是一个 JSON 对象 {}";
        return;
      }
    } catch (e: any) {
      errorMsg.value = "Body JSON 解析失败：" + e.message;
      return;
    }
  }

  loading.value = true;
  try {
    switch (method.value) {
      case "get-list": {
        const params: Record<string, unknown> = {};
        if (!paramNopage.value) {
          params.page = paramPage.value;
          params.pageSize = paramPageSize.value;
        } else {
          params.nopage = true;
        }
        if (paramOne.value) params.__one = true;
        if (paramFields.value.trim()) params.fields = paramFields.value.trim();
        if (paramOrderBy.value.trim()) {
          params.orderBy = paramOrderBy.value.trim();
          params.order = paramOrder.value;
        }
        if (paramJoin.value.trim()) params.join = paramJoin.value.trim();
        for (const f of filters.value) {
          if (f.key.trim()) params[f.key.trim()] = f.value;
        }
        response.value = await testClient.value.get(`/${objName}/${tblName}`, { params });
        break;
      }
      case "get-id": {
        const params: Record<string, unknown> = {};
        if (paramFields.value.trim()) params.fields = paramFields.value.trim();
        if (paramJoin.value.trim()) params.join = paramJoin.value.trim();
        response.value = await testClient.value.get(`/${objName}/${tblName}/${idValue.value}`, { params });
        break;
      }
      case "post": {
        response.value = await testClient.value.post(`/${objName}/${tblName}`, parsedBody);
        break;
      }
      case "put": {
        response.value = await testClient.value.put(`/${objName}/${tblName}/${idValue.value}`, parsedBody);
        break;
      }
      case "delete": {
        try {
          await ElMessageBox.confirm(
            `确定删除 ${objName}/${tblName}/${idValue.value} 吗？此操作不可撤销。`,
            "删除确认",
            { confirmButtonText: "确定删除", cancelButtonText: "取消", type: "warning" }
          );
        } catch {
          loading.value = false;
          return;
        }
        response.value = await testClient.value.delete(`/${objName}/${tblName}/${idValue.value}`);
        break;
      }
    }

    if (method.value === "delete") ElMessage.success("删除成功");
    else if (method.value === "post") ElMessage.success("创建成功");
    else if (method.value === "put") ElMessage.success("更新成功");
  } catch (err: any) {
    errorMsg.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

watch(method, () => {
  errorMsg.value = "";
  response.value = null;
});
</script>

<template>
  <div>
    <el-splitter layout="vertical" style="height: calc(100vh - 130px)">
      <el-splitter-panel size="20%">
        <div>
          <test-base :page-url="pageUrl" :api-name="resolvedApiName" :db-type="resolvedDbType" :db-path="resolvedDbPath"
            :db-url="resolvedDbUrl" />
        </div>
      </el-splitter-panel>
      <el-splitter-panel>
        <el-splitter>
          <el-splitter-panel size="50%">
            <div class="p-2">
              <h4>接口测试</h4>
              <el-tabs v-model="activeName" tab-position="left" type="border-card">
                <el-tab-pane label="列表" name="get-page-list">
                  <test-list v-model:page="paramPage" v-model:pageSize="paramPageSize" v-model:one="paramOne"
                    v-model:fields="paramFields" v-model:orderBy="paramOrderBy" v-model:order="paramOrder"
                    v-model:join="paramJoin" v-model:filters="filters" v-model:nopage="paramNopage" />
                </el-tab-pane>
                <el-tab-pane label="单条" name="get-one">单条</el-tab-pane>
                <el-tab-pane label="新增" name="add">新增</el-tab-pane>
                <el-tab-pane label="更新" name="update">更新</el-tab-pane>
                <el-tab-pane label="删除" name="delete">删除</el-tab-pane>
              </el-tabs>
              <!-- 第三块：请求配置 -->
              <el-card shadow="never" class="flex flex-col gap-3">
                <div class="flex items-center gap-3 flex-wrap">
                  <el-radio-group v-model="method" size="default">
                    <el-radio-button value="get-list">GET 列表</el-radio-button>
                    <el-radio-button value="get-id">GET 单条</el-radio-button>
                    <el-radio-button value="post">POST 新增</el-radio-button>
                    <el-radio-button value="put">PUT 更新</el-radio-button>
                    <el-radio-button value="delete">DELETE 删除</el-radio-button>
                  </el-radio-group>



                  <el-input v-if="method === 'get-id' || method === 'put' || method === 'delete'" v-model="idValue"
                    placeholder="主键 id" class="w-32" clearable />
                </div>

                <!-- list 参数区 -->
                <div v-if="method === 'get-list'" class="flex flex-col gap-2">
                  222
                </div>

                <!-- body 编辑器 -->
                <div v-if="method === 'post' || method === 'put'" class="flex flex-col gap-1">
                  <div class="text-xs text-gray-500">请求体 (JSON)</div>
                  <el-input v-model="bodyText" type="textarea" :rows="8" class="font-mono text-sm"
                    placeholder='请输入 JSON 对象，如 {"name": "张三", "age": 18}' />
                </div>


              </el-card>
            </div>
          </el-splitter-panel>
          <el-splitter-panel :min="200">
            <div class="demo-panel">
              <!-- 第四块：响应展示 -->
              <!-- 请求预览 URL + 执行按钮 -->
              <div class="flex gap-2 items-center flex-wrap">
                <el-tag :type="method.startsWith('get') ? 'info' : method === 'delete' ? 'danger' : 'success'">
                  {{ exampleMethod }}
                </el-tag>
                <code class="text-xs bg-gray-100 px-2 py-1 rounded flex-1 break-all">{{ exampleUrl }}</code>
                <el-button type="primary" :loading="loading" @click="execute">执行请求</el-button>
              </div>
              <el-card shadow="never" class="flex flex-col gap-3">
                <template #header>
                  <div class="flex items-center gap-2">
                    <span class="font-semibold">响应结果</span>
                    <el-tag v-if="requestMethod" size="small" type="info">{{ requestMethod }}</el-tag>
                    <code v-if="requestUrl" class="text-xs text-gray-500">{{ requestUrl }}</code>
                    <el-tag v-if="response" size="small" :type="isListResponse ? 'success' : 'warning'">
                      {{ isListResponse ? `列表 (${tableData.length} 条)` : "对象" }}
                    </el-tag>
                  </div>
                </template>

                <el-alert v-if="errorMsg" :title="errorMsg" type="error" show-icon :closable="false" />

                <div v-if="!response && !errorMsg && !loading" class="text-center text-gray-400 py-8 text-sm">
                  配置好参数后点击「执行请求」查看真实数据
                </div>

                <div v-if="loading" class="text-center py-8">
                  <el-icon class="is-loading text-xl text-blue-500">
                    <Loading />
                  </el-icon>
                  <div class="text-gray-400 text-sm mt-1">请求中...</div>
                </div>

                <template v-if="response">
                  <el-tabs v-model="responseTab">
                    <el-tab-pane v-if="isListResponse" label="表格视图" name="table">
                      <el-table :data="tableData" border stripe size="small" height="400">
                        <el-table-column v-for="col in tableColumns" :key="col" :prop="col" :label="col" min-width="120"
                          show-overflow-tooltip />
                      </el-table>
                      <div
                        v-if="response && typeof response === 'object' && !Array.isArray(response) && response.total != null"
                        class="text-xs text-gray-500 mt-1">
                        共 {{ response.total }} 条，当前第 {{ response.page }} 页 / {{ response.pageSize }} 条每页
                      </div>
                    </el-tab-pane>

                    <el-tab-pane label="原始 JSON" name="raw">
                      <el-input :model-value="rawJson" type="textarea" :rows="15" readonly class="font-mono text-xs" />
                    </el-tab-pane>

                    <el-tab-pane v-if="response && !isListResponse" label="字段视图" name="object">
                      <el-descriptions v-if="response && typeof response === 'object'" :column="1" border size="small">
                        <el-descriptions-item v-for="(val, key) in response" :key="String(key)" :label="String(key)">
                          <span class="font-mono text-xs">
                            {{ typeof val === "object" ? JSON.stringify(val) : String(val) }}
                          </span>
                        </el-descriptions-item>
                      </el-descriptions>
                    </el-tab-pane>
                  </el-tabs>
                </template>
              </el-card>
            </div>
          </el-splitter-panel>
        </el-splitter>
      </el-splitter-panel>
    </el-splitter>
  </div>
</template>

<style lang="scss" scoped>
code {
  font-family: Consolas, Monaco, "Courier New", monospace;
}
</style>
