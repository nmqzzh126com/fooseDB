<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, type UploadUserFile } from "element-plus";
import { UploadFilled } from "@element-plus/icons-vue";
import {
  createFooseClient,
  type FooseClient,
  type FooseListParams,
  type FooseLastRequest
} from "@fooseDB/sdk";

defineOptions({ name: "Welcome" });

// —— 操作类型枚举 ——
type Operation =
  | "login"
  | "list"
  | "getById"
  | "create"
  | "update"
  | "remove"
  | "upload"
  | "download"
  | "fileList"
  | "fileDelete"
  | "fileInfo"
  | "getValue"
  | "incDec";
const OPERATIONS: { key: Operation; label: string; desc: string }[] = [
  {
    key: "login",
    label: "用户登录",
    desc: "POST /api/auth/login — 登录认证并获取 token"
  },
  {
    key: "list",
    label: "列表查询",
    desc: "返回 data[] + meta{total, page, pageSize, totalPages}"
  },
  { key: "getById", label: "按 ID 查询", desc: "返回单行数据" },
  { key: "create", label: "新增", desc: "POST 单行" },
  { key: "update", label: "更新", desc: "PATCH 单行" },
  { key: "remove", label: "删除", desc: "DELETE 单行" },
  {
    key: "upload",
    label: "文件上传",
    desc: "POST /api/files/:object/:folder — multipart"
  },
  {
    key: "download",
    label: "文件下载",
    desc: "GET /api/files/:object/:file_id — 支持 Range"
  },
  {
    key: "fileList",
    label: "文件列表",
    desc: "GET /api/files/:object/:folder/:page — 分页元数据"
  },
  {
    key: "fileDelete",
    label: "文件删除",
    desc: "DELETE /api/files/:object/:folder/:file_id"
  },
  {
    key: "fileInfo",
    label: "文件信息",
    desc: "GET /api/files/:object/info/:file_id — 元数据 + 下载 URL"
  },
  {
    key: "getValue",
    label: "取单字段值",
    desc: "GET /api/:object/:table/value/:field — 返回 JSON 裸值（保持原始类型）"
  },
  {
    key: "incDec",
    label: "自增/自减",
    desc: "POST /api/:object/:table/inc-dec — 原子 + / -，支持多字段 + 延迟"
  }
];

// —— 状态 ——
const baseURL = ref(
  import.meta.env.VITE_FOOSE_DB_BASE_URL ?? "http://127.0.0.1:8858"
);
const authRequired = ref(false); // 是否启用认证, 默认不启用
const username = ref("demo");
const password = ref("admin123456!@#");
const fooseClient = ref<FooseClient | null>(null);
const clientReady = ref(false);

const operation = ref<Operation>("list");
const objectName = ref("sqlite_demo");
const tableName = ref("foose_users");

// —— 各操作参数 ——
const paginationEnabled = ref(true);
watch(paginationEnabled, enabled => {
  listParams.noPage = !enabled;
});

// —— filter JSON 实时解析 ——
const parseFilterJson = (): {
  data: Record<string, unknown>;
  error: string;
} => {
  const v = listParams.filterJson.trim();
  if (!v || v === "{}") return { data: {}, error: "" };
  try {
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed, error: "" };
    }
    return { data: {}, error: "filter 必须是 JSON 对象（{...}）" };
  } catch (e) {
    return {
      data: {},
      error: e instanceof Error ? e.message : "JSON 解析失败"
    };
  }
};

const listFilter = computed<Record<string, unknown>>(
  () => parseFilterJson().data
);
const filterParseError = computed<string>(() => parseFilterJson().error);

const listParams = reactive<{
  page: number;
  pageSize: number;
  noPage: boolean;
  showSql: boolean;
  orderBy: string;
  filterJson: string;
}>({
  page: 1,
  pageSize: 10,
  noPage: false,
  showSql: false,
  orderBy: "id:desc",
  filterJson: "{}"
});

const idInput = ref("");
const dataJson = ref("{\n  \n}");

// —— 文件操作参数 ——
const foldername = ref("docs-images");
const fileListPage = ref(1);
const uploadFileList = ref<UploadUserFile[]>([]);
const downloadFileId = ref("");
const deleteFileIds = ref("");

// —— getValue / incDec 参数 ——
const gvField = ref("username"); // 取哪个字段
const gvFilterJson = ref('{"id":1}'); // filter JSON
const incBodyJson = ref('{"inc":{"flag":1}}'); // inc-dec body JSON
const incFilterJson = ref('{"id":1}'); // filter JSON
const incDelayMs = ref(0); // 延迟执行毫秒

// —— 运行状态 ——
const running = ref(false);
const lastRequest = ref<string>("");
const lastHttpRequest = ref<FooseLastRequest | null>(null);
const lastResponse = ref<string>("");
const lastError = ref<string>("");
const lastDurationMs = ref<number>(0);
const requestDetailCollapsed = ref(true); // 默认折叠，省空间

// —— 计算属性 ——
const constructedListParams = computed<FooseListParams>(() => {
  const p: FooseListParams = {
    noPage: listParams.noPage,
    orderBy: listParams.orderBy || undefined,
    showSql: listParams.showSql
  };
  if (!listParams.noPage) {
    p.page = listParams.page;
    p.pageSize = listParams.pageSize;
  }
  if (Object.keys(listFilter.value).length > 0) {
    p.filter = listFilter.value;
  }
  return p;
});

// —— 登录 ——
const login = async () => {
  if (!username.value.trim() || !password.value) {
    ElMessage.warning("请输入用户名和密码");
    return;
  }
  running.value = true;
  lastError.value = "";
  lastResponse.value = "";
  try {
    fooseClient.value = await createFooseClient({
      baseURL: baseURL.value,
      username: username.value.trim(),
      password: password.value
    });
    clientReady.value = true;
    // 登录成功 → 把完整 auth info 显示到返回结果
    const authInfo = fooseClient.value.fooseGetAuthInfo();
    if (authInfo) {
      lastResponse.value = JSON.stringify(authInfo, null, 2);
    }
    ElMessage.success(`✓ 登录成功（${username.value}）`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastError.value = msg;
    ElMessage.error(`登录失败: ${msg}`);
  } finally {
    running.value = false;
    if (fooseClient.value) {
      lastHttpRequest.value = fooseClient.value.fooseGetLastRequest();
    }
  }
};

const logout = async () => {
  const fc = fooseClient.value;
  lastError.value = "";
  try {
    await fc?.fooseLogout();
    // 登出请求也记录到请求详情 + 返回结果
    if (fc) {
      lastHttpRequest.value = fc.fooseGetLastRequest();
    }
    lastResponse.value = JSON.stringify(
      {
        ok: true,
        message: "已退出登录",
        cleared: ["access_token", "refresh_token", "user"]
      },
      null,
      2
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastError.value = msg;
    lastResponse.value = `// 登出请求失败\n${msg}`;
    if (fc) lastHttpRequest.value = fc.fooseGetLastRequest();
  }
  fooseClient.value = null;
  clientReady.value = false;
  ElMessage.info("已登出");
};

// —— 文件操作不再需要 buildFileHeaders / recordFileRequest ——
// 全部改用 SDK 方法（fooseUpload / fooseDownload 等），SDK 拦截器自动注入
// 正确的 Authorization + X-Client-Id（与登录签发 JWT 时用的 fingerprint 一致）

// —— 运行当前操作 ——
const runOperation = async () => {
  lastError.value = "";
  lastResponse.value = "";

  // login 操作本身就是认证，跳过前置自动登录
  if (operation.value !== "login" && !fooseClient.value) {
    if (username.value.trim() && password.value) {
      // 有凭据 → 始终创建认证 client（不管项目是否要求登录，登录了不会有坏处）
      await login();
      if (!fooseClient.value) return; // 登录失败
    } else {
      // 无凭据 → 创建匿名 client（仅当项目 auth_required=0 时可用）
      try {
        fooseClient.value = await createFooseClient({
          baseURL: baseURL.value,
          username: "",
          password: ""
        });
        clientReady.value = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastError.value = `匿名 client 创建失败: ${msg}`;
        ElMessage.error(msg);
        return;
      }
    }
  }

  // —— SDK 版本健康检查：如果有旧 client 实例且缺新方法，强制重建 ——
  const fcBeforeCheck = fooseClient.value;
  if (fcBeforeCheck) {
    const requiredMethods = [
      "fooseList",
      "fooseGet",
      "fooseCreate",
      "fooseUpdate",
      "fooseRemove",
      "fooseGetValue",
      "fooseIncDec",
      "fooseUpload",
      "fooseDownload",
      "fooseFileList",
      "fooseFileDelete",
      "fooseFileInfo"
    ];
    const missing = requiredMethods.filter(
      m => typeof (fcBeforeCheck as any)?.[m] !== "function"
    );
    if (missing.length > 0) {
      console.warn(
        "[SDK 版本检查] 检测到旧 client 实例，强制重建。缺失:",
        missing
      );
      fooseClient.value = null;
      clientReady.value = false;
      ElMessage.info(`⚠ 旧 client 已清除，用新 SDK 重新登录中...`);

      // 重新触发自动创建（与 runOperation 开头同一段逻辑）
      if (operation.value !== "login") {
        if (username.value.trim() && password.value) {
          await login();
        } else {
          fooseClient.value = await createFooseClient({
            baseURL: baseURL.value,
            username: "",
            password: ""
          });
          clientReady.value = true;
        }
      }
    }
  }

  const fc = fooseClient.value;
  if (!fc) {
    ElMessage.error("client 未就绪，请稍候重试");
    return;
  }

  const start = performance.now();
  running.value = true;

  try {
    let result: unknown;

    switch (operation.value) {
      case "login": {
        if (!username.value.trim() || !password.value) {
          throw new Error("请在上方接口配置区填写用户名和密码");
        }
        // 创建匿名 client 作为登录通道（无论成功失败都能拿到请求详情）
        const tmp = await createFooseClient({
          baseURL: baseURL.value,
          username: "",
          password: ""
        });
        fooseClient.value = tmp; // 先占坑，finally 块能抓到请求详情
        clientReady.value = false;

        const tokenData = await tmp.fooseLogin(
          username.value.trim(),
          password.value
        );
        clientReady.value = true;
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseLogin",
            username: username.value.trim(),
            password: "***(已发送)"
          },
          null,
          2
        );
        result = {
          message: "登录成功",
          token_type: tokenData.token_type,
          expires: tokenData.expires,
          refresh_expires: tokenData.refresh_expires,
          user: {
            id: tokenData.user.id,
            username: tokenData.user.username,
            nickname: tokenData.user.nickname,
            roles: tokenData.user.roles
          }
        };
        break;
      }
      case "list": {
        const params = constructedListParams.value;
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseList",
            object: objectName.value,
            table: tableName.value,
            params
          },
          null,
          2
        );
        result = await fc.fooseList(objectName.value, tableName.value, params);
        break;
      }
      case "getById": {
        if (!idInput.value.trim()) throw new Error("请输入 ID");
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseGet",
            object: objectName.value,
            table: tableName.value,
            id: idInput.value
          },
          null,
          2
        );
        result = await fc.fooseGet(
          objectName.value,
          tableName.value,
          idInput.value.trim()
        );
        break;
      }
      case "create": {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataJson.value);
        } catch {
          throw new Error("data 不是合法 JSON");
        }
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseCreate",
            object: objectName.value,
            table: tableName.value,
            data
          },
          null,
          2
        );
        result = await fc.fooseCreate(objectName.value, tableName.value, data);
        break;
      }
      case "update": {
        if (!idInput.value.trim()) throw new Error("请输入 ID");
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataJson.value);
        } catch {
          throw new Error("data 不是合法 JSON");
        }
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseUpdate",
            object: objectName.value,
            table: tableName.value,
            id: idInput.value,
            data
          },
          null,
          2
        );
        result = await fc.fooseUpdate(
          objectName.value,
          tableName.value,
          idInput.value.trim(),
          data
        );
        break;
      }
      case "remove": {
        if (!idInput.value.trim()) throw new Error("请输入 ID");
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseRemove",
            object: objectName.value,
            table: tableName.value,
            id: idInput.value
          },
          null,
          2
        );
        result = await fc.fooseRemove(
          objectName.value,
          tableName.value,
          idInput.value.trim()
        );
        break;
      }
      // —— 文件操作：使用 SDK 方法，拦截器自动注入正确的 token + fingerprint ——
      case "upload": {
        if (uploadFileList.value.length === 0) throw new Error("请先选择文件");
        const rawFiles = uploadFileList.value.map(f => f.raw as File);
        const names = uploadFileList.value.map(f => f.name);
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseUpload",
            object: objectName.value,
            foldername: foldername.value,
            files: names
          },
          null,
          2
        );
        result = await fc.fooseUpload(
          objectName.value,
          foldername.value,
          rawFiles,
          names
        );
        uploadFileList.value = [];
        const body = result as any;
        ElMessage.success(`✓ 上传 ${body.count ?? "?"} 个文件`);
        break;
      }
      case "download": {
        if (!downloadFileId.value.trim()) throw new Error("请输入文件 ID");
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseDownload",
            object: objectName.value,
            fileId: downloadFileId.value.trim()
          },
          null,
          2
        );
        const { blob, filename, contentType } = await fc.fooseDownload(
          objectName.value,
          downloadFileId.value.trim()
        );
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        result = {
          message: "文件已下载",
          filename,
          size: blob.size,
          type: contentType
        };
        ElMessage.success(`✓ 下载 ${filename}（${blob.size} bytes）`);
        break;
      }
      case "fileList": {
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseFileList",
            object: objectName.value,
            foldername: foldername.value,
            page: fileListPage.value
          },
          null,
          2
        );
        result = await fc.fooseFileList(
          objectName.value,
          foldername.value,
          fileListPage.value
        );
        break;
      }
      case "fileDelete": {
        if (!deleteFileIds.value.trim())
          throw new Error("请输入文件 ID（逗号分隔）");
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseFileDelete",
            object: objectName.value,
            foldername: foldername.value,
            fileIds: deleteFileIds.value.trim()
          },
          null,
          2
        );
        result = await fc.fooseFileDelete(
          objectName.value,
          foldername.value,
          deleteFileIds.value.trim()
        );
        const body = result as any;
        ElMessage.success(`✓ 删除 ${body.count ?? "?"} 个文件`);
        break;
      }
      case "fileInfo": {
        if (!downloadFileId.value.trim()) throw new Error("请输入文件 ID");
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseFileInfo",
            object: objectName.value,
            fileId: downloadFileId.value.trim()
          },
          null,
          2
        );
        const d = await fc.fooseFileInfo(
          objectName.value,
          downloadFileId.value.trim()
        );
        result = d;
        ElMessage.success(
          `✓ 文件：${d.original_name}（${d.file_size} B）${d.physical_exists === false ? " ⚠ 物理文件缺失" : ""}`
        );
        break;
      }
      case "getValue": {
        if (!gvField.value.trim()) throw new Error("请输入目标字段名");
        let filterObj: Record<string, unknown> = {};
        try {
          filterObj = gvFilterJson.value.trim()
            ? JSON.parse(gvFilterJson.value)
            : {};
        } catch {
          throw new Error("filter JSON 格式错误");
        }
        if (Object.keys(filterObj).length === 0)
          throw new Error("filter 不能为空");
        const val = await fc.fooseGetValue(
          objectName.value,
          tableName.value,
          gvField.value.trim(),
          filterObj
        );
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseGetValue",
            field: gvField.value.trim(),
            filter: filterObj
          },
          null,
          2
        );
        result = { field: gvField.value.trim(), value: val };
        break;
      }
      case "incDec": {
        let bodyObj: {
          inc?: Record<string, number>;
          dec?: Record<string, number>;
        } = {};
        let filterObj: Record<string, unknown> = {};
        try {
          bodyObj = incBodyJson.value.trim()
            ? JSON.parse(incBodyJson.value)
            : {};
          filterObj = incFilterJson.value.trim()
            ? JSON.parse(incFilterJson.value)
            : {};
        } catch {
          throw new Error("JSON 格式错误");
        }
        if (!bodyObj.inc && !bodyObj.dec)
          throw new Error("body 中必须有 inc 或 dec");
        if (Object.keys(filterObj).length === 0)
          throw new Error("filter 不能为空");
        const r = await fc.fooseIncDec(
          objectName.value,
          tableName.value,
          bodyObj,
          filterObj,
          incDelayMs.value
        );
        lastRequest.value = JSON.stringify(
          {
            operation: "fooseIncDec",
            body: bodyObj,
            filter: filterObj,
            delayMs: incDelayMs.value
          },
          null,
          2
        );
        result = r;
        break;
      }
    }

    lastDurationMs.value = Math.round((performance.now() - start) * 100) / 100;
    lastResponse.value = JSON.stringify(result, null, 2);
    ElMessage.success(`✓ 完成（${lastDurationMs.value} ms）`);
  } catch (e) {
    lastDurationMs.value = Math.round((performance.now() - start) * 100) / 100;
    const msg = e instanceof Error ? e.message : String(e);
    lastError.value = msg;
    lastResponse.value = `// 运行错误\n// ${msg}\n\n${lastResponse.value}`;
    ElMessage.error(`请求失败: ${msg}`);
  } finally {
    running.value = false;
    // 所有操作都走 SDK，lastRequestInfo 由 SDK 拦截器自动记录
    if (fooseClient.value) {
      lastHttpRequest.value = fooseClient.value.fooseGetLastRequest();
    }
  }
};

// —— Demo 快捷填充 ——
const fillFilterDemo = () => {
  listParams.filterJson = `{
  "flag": 0,
  "username[_like]": "demo%"
}`;
  listParams.orderBy = "id:desc,username:ASC";
};
const fillFilterFull = () => {
  lastResponse.value = `使用示例:\n  {  
    "flag": 0,
    "username[_like]": "demo%",
    "qty[_gt]": 30,
  }
生成 SQL 语句: WHERE flag = 0 AND username LIKE 'demo%' AND qty > 30

支持的运算符:
  _eq          对应 =               例如:{"status": "paid"}  或 {"status[_eq]": "paid"}
  _neq         对应 <>              例如:{"status[_neq]": "cancelled"}
  _gt          对应 >               例如:{"price[_gt]": "100"} 
  _gte         对应 >=              例如:{"price[_gte]": "50"} 
  _lt          对应 <               例如:{"price[_lt]": "200"} 
  _lte         对应 <=              例如:{"price[_lte]": "150"} 
  _like        对应 LIKE            例如:{"name[_like]": "A%"} (通配符自己写)
  _nlike       对应 NOT LIKE        例如:{"name[_nlike]": "%delete%"}
  _contains    对应 LIKE            例如:{"name[_contains]": "Apple"} (自动包:%Apple%)
  _starts_with 对应 LIKE            例如:{"name[_starts_with]": "Cherry"} (自动包:Cherry%)
  _ends_with   对应 LIKE            例如:{"name[_ends_with]": "Cake"} (自动包:Cake%)
  _in          对应 IN              例如:{"status[_in]": "paid,cancelled"}
  _nin         对应 NOT IN          例如:{"status[_nin]": "draft,cancelled"}
  _between     对应 BETWEEN a AND b 例如:{"qty[_between]": "20,40"}
  _null        对应 IS NULL         例如:{"deleted_at[_null]": "true"} 或 {"status[_nnull]": "1"} 或 {"status[_null]": "0"}
  _nnull       对应 IS NOT NULL     例如:{"status[_nnull]": "1"} 或 {"status[_nnull]": "0"} 或 {"status[_nnull]": "1"}

OR / AND 嵌套
第一层 OR 分组：_or[idx][field][op],每个 _or[idx] 内部的多字段是 AND，不同 _or[idx] 之间是 OR
{
  "_or[0][name][_eq]": "Apple Pie",
  "_or[0][qty][_lt]": 30,
  "_or[1][name][_eq]": "Banana Smoothie"
}
生成 SQL 语句: WHERE (name = 'Apple Pie' AND qty < 30) OR (name = 'Banana Smoothie')

AND 分组：_and[idx][field][op],显式声明 AND 组（顶层多 key 本身已经是 AND，一般用于嵌套在 OR 内部）
{
  "_or[0][_and][0][status][_eq]": "paid",
  "_or[0][_and][1][qty][_gte]": "45",
  "_or[1][status][_eq]": "draft"
}
生成 SQL 语句: WHERE (status = 'paid' AND qty >= 45) OR (status = 'draft')

完全嵌套示例：
{
  "_or[0][_and][0][a][_eq]": "1",
  "_or[0][_or][0][b][_eq]": "2",
  "_or[0][_or][1][c][_eq]": "3",
  "_or[1][d][_eq]": "4"
}
索引 [0],[1] 只是排序用的，跳号也无妨，但必须从 0 开始且唯一
生成 SQL 语句: WHERE (a = 1 AND (b = 2 OR c = 3)) OR d = 4

  `;
};

const fillCreateDemo = () => {
  dataJson.value =
    '{\n  "username": "test_user_' +
    Date.now() +
    '",\n  "nickname": "SDK 测试用户",\n  "password": "123456",\n  "flag": 0\n}';
};

const fillUpdateDemo = () => {
  idInput.value = "1";
  dataJson.value = '{\n  "nickname": "更新后的昵称"\n}';
};

// —— 切换认证开关时自动登出 ——
watch(authRequired, enabled => {
  if (!enabled && clientReady.value) {
    fooseClient.value = null;
    clientReady.value = false;
    lastHttpRequest.value = null;
    lastResponse.value = "";
    lastError.value = "";
    ElMessage.info("已关闭认证，自动登出");
  }
});

onMounted(() => {
  // 不自动登录 —— 用户手动点 🔓 登录按钮触发
});
</script>

<template>
  <div class="foose-test">
    <!-- 认证区（全宽，独立一行） -->
    <div class="panel">
      <div class="panel-title">🔐 接口配置</div>
      <el-row :gutter="10">
        <el-col :span="6">
          <el-input v-model="baseURL" size="small" placeholder="baseURL">
            <template #prefix>接口地址&nbsp;&nbsp;</template>
          </el-input>
        </el-col>
        <el-col :span="6">
          <el-input
            v-model="objectName"
            size="small"
            placeholder="填写接口名称"
          >
            <template #prefix>接口名称&nbsp;&nbsp;</template>
          </el-input>
        </el-col>
        <el-col :span="6">
          <el-input
            v-model="tableName"
            size="small"
            placeholder="填写数据表名称"
          >
            <template #prefix>数据表名称&nbsp;&nbsp;</template>
          </el-input>
        </el-col>
        <el-col :span="6">
          <el-switch
            v-model="authRequired"
            inline-prompt
            style="
              --el-switch-on-color: #13ce66;
              --el-switch-off-color: #e6a23c;
            "
            active-text="启用认证"
            inactive-text="匿名模式 (接口需关闭认证)"
          />
        </el-col>
      </el-row>
      <el-row :gutter="10" align="middle" class="mt-1">
        <el-col :span="6">
          <el-input
            v-model="username"
            size="small"
            placeholder="用户名"
            :disabled="!authRequired"
          >
            <template #prefix>用户名&nbsp;&nbsp;</template>
          </el-input>
        </el-col>
        <el-col :span="6">
          <el-input
            v-model="password"
            size="small"
            placeholder="密码"
            :disabled="!authRequired"
            @keyup.enter="runOperation"
          >
            <template #prefix>密码&nbsp;&nbsp;</template>
          </el-input>
        </el-col>
        <el-col :span="6">
          <el-button
            v-if="!clientReady"
            type="primary"
            size="small"
            :loading="running"
            @click="login"
          >
            登录认证
          </el-button>
          <el-button v-else size="small" @click="logout">退出登录</el-button>
          <el-tag
            v-if="clientReady"
            type="success"
            effect="plain"
            size="small"
            class="ml-2"
          >
            已登录（{{ username || "匿名" }}）
          </el-tag>
          <el-tag
            v-else-if="authRequired"
            type="info"
            effect="plain"
            size="small"
            class="ml-2"
          >
            未登录
          </el-tag>
          <el-tag
            v-else
            type="warning"
            effect="plain"
            size="small"
            class="ml-2"
          >
            匿名模式
          </el-tag>
        </el-col>
      </el-row>
    </div>
    <!-- 主体：左操作区 | 右请求+结果 -->
    <div class="main-body">
      <!-- 左侧：操作区 + 请求参数 -->
      <div class="left-col">
        <div class="panel op-panel">
          <div class="panel-title">⚙️ 操作</div>
          <el-row :gutter="10" align="top">
            <el-col :span="16">
              <el-select
                v-model="operation"
                size="default"
                class="w-full"
                @change="
                  () => {
                    lastRequest = '';
                    lastResponse = '';
                    lastError = '';
                    lastHttpRequest = null;
                  }
                "
              >
                <el-option
                  v-for="op in OPERATIONS"
                  :key="op.key"
                  :label="op.label"
                  :value="op.key"
                >
                  <div class="op-option">
                    <span class="op-label">{{ op.label }}</span>
                    <span class="op-desc">{{ op.desc }}</span>
                  </div>
                </el-option>
              </el-select>
            </el-col>
            <el-col :span="8">
              <el-button
                type="primary"
                size="small"
                :loading="running"
                @click="runOperation"
              >
                执行
              </el-button>
              <span v-if="lastDurationMs" class="duration-hint">
                {{ lastDurationMs }} ms
              </span>
            </el-col>
          </el-row>

          <!-- 动态参数区 -->
          <el-divider class="divider-gap" />
          <!-- 分页查询参数 -->
          <div v-if="operation === 'list'" class="op-params-vertical">
            <el-row :gutter="5">
              <el-col :span="4">
                <el-checkbox
                  v-model="paginationEnabled"
                  label="分页"
                  size="small"
                />
              </el-col>
              <el-col :span="10">
                <el-input-number
                  v-model="listParams.page"
                  controls-position="right"
                  :min="1"
                  size="small"
                  style="width: 100%"
                  :disabled="!paginationEnabled"
                >
                  <template #prefix>
                    <span>当前页 page</span>
                  </template>
                </el-input-number>
              </el-col>
              <el-col :span="10">
                <el-input-number
                  v-model="listParams.pageSize"
                  controls-position="right"
                  :min="1"
                  :max="500"
                  size="small"
                  style="width: 100%"
                  :disabled="!paginationEnabled"
                >
                  <template #prefix>
                    <span>页大小 pageSize</span>
                  </template>
                </el-input-number>
              </el-col>
            </el-row>

            <el-input
              v-model="listParams.orderBy"
              size="small"
              clearable
              placeholder="例如: id:desc,name:ASC"
            >
              <template #prefix>
                <span>排序(orderBy)</span>
              </template>
            </el-input>
            <div class="op-params-row">
              <el-checkbox
                v-model="listParams.showSql"
                label="返回 SQL 语句"
                size="small"
              />
              <el-button
                size="small"
                type="primary"
                plain
                @click="fillFilterDemo"
              >
                填充 orderBy和filter 示例
              </el-button>
              <el-button
                size="small"
                type="primary"
                plain
                @click="fillFilterFull"
              >
                filter 使用说明
              </el-button>
            </div>
          </div>

          <!-- 用户登录参数提示 -->
          <div v-else-if="operation === 'login'" class="op-params-vertical">
            <el-alert
              type="info"
              :closable="false"
              show-icon
              title="登录使用上方『接口配置』面板中的用户名和密码"
              description="⚠ 登录不使用『接口名称』和『数据表名称』！认证是全局的，业务用户的数据源由后端 .env USER_DS_NAME（默认 sqlite_demo）固定指定。admin 账号（如 admin/admin123）登录后可跨所有项目访问。"
            />
          </div>

          <!-- 按 ID 参数 -->
          <div
            v-else-if="operation === 'getById' || operation === 'remove'"
            class="op-params-vertical"
          >
            <el-input v-model="idInput" size="default" placeholder="row id" />
          </div>

          <!-- 更新参数 -->
          <div v-else-if="operation === 'update'" class="op-params-vertical">
            <el-input v-model="idInput" size="default" placeholder="row id" />
            <el-button size="small" text @click="fillUpdateDemo">
              填充更新示例
            </el-button>
          </div>

          <!-- 新增参数 -->
          <div v-else-if="operation === 'create'" class="op-params-vertical">
            <el-button size="small" text @click="fillCreateDemo">
              填充新增示例
            </el-button>
          </div>

          <!-- 文件上传参数 -->
          <div v-else-if="operation === 'upload'" class="op-params-vertical">
            <el-input
              v-model="foldername"
              size="small"
              clearable
              placeholder="foldername（- 分隔最多 3 层，如 docs-images）"
            >
              <template #prefix>文件夹名</template>
            </el-input>
            <el-upload
              v-model:file-list="uploadFileList"
              :auto-upload="false"
              :limit="5"
              multiple
              drag
              :on-exceed="() => ElMessage.warning('最多 5 个文件')"
            >
              <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
              <div class="el-upload__text">
                拖拽文件到此处 或 <em>点击选择</em>
              </div>
              <template #tip>
                <div class="el-upload__tip">
                  支持 jpg/jpeg/png/pdf/docx/txt，单个 ≤ 1MB，最多 5 个
                </div>
              </template>
            </el-upload>
          </div>

          <!-- 文件下载 / 文件信息 参数（共用 file_id 输入） -->
          <div
            v-else-if="operation === 'download' || operation === 'fileInfo'"
            class="op-params-vertical"
          >
            <el-input
              v-model="downloadFileId"
              size="small"
              clearable
              placeholder="file_id（单个数字）"
            >
              <template #prefix>文件 ID</template>
            </el-input>
            <div v-if="operation === 'fileInfo'" class="hint-text">
              查询文件元数据（大小、物理存在性、下载 URL 等），
              <strong>不</strong>需要 foldername。
            </div>
          </div>

          <!-- 文件列表参数 -->
          <div v-else-if="operation === 'fileList'" class="op-params-vertical">
            <el-input
              v-model="foldername"
              size="small"
              clearable
              placeholder="foldername"
            >
              <template #prefix>文件夹名</template>
            </el-input>
            <el-input-number
              v-model="fileListPage"
              controls-position="right"
              :min="1"
              size="small"
              style="width: 100%"
            >
              <template #prefix>
                <span>页码</span>
              </template>
            </el-input-number>
          </div>

          <!-- 文件删除参数 -->
          <div
            v-else-if="operation === 'fileDelete'"
            class="op-params-vertical"
          >
            <el-input
              v-model="foldername"
              size="small"
              clearable
              placeholder="foldername"
            >
              <template #prefix>文件夹名</template>
            </el-input>
            <el-input
              v-model="deleteFileIds"
              size="small"
              clearable
              placeholder="file_id（逗号分隔多个，如 1,2,3）"
            >
              <template #prefix>文件 ID</template>
            </el-input>
          </div>

          <!-- 取单字段值参数 -->
          <div v-else-if="operation === 'getValue'" class="op-params-vertical">
            <el-input
              v-model="gvField"
              size="small"
              clearable
              placeholder="字段名，如 username / flag / id"
            >
              <template #prefix>字段</template>
            </el-input>
            <el-input
              v-model="gvFilterJson"
              type="textarea"
              :rows="3"
              size="small"
              placeholder='{ "id": 1 } 或 { "username": "demo" }'
            />
            <div class="hint-text">
              返回 JSON 裸值（保持原始类型）：
              <code>"demo"</code> / <code>1</code> / <code>true</code> /
              <code>null</code>（零匹配）。多行取第一行。
            </div>
            <el-alert
              type="info"
              :closable="false"
              show-icon
              title="后端自动 JSON 序列化"
              description="getValue 端点返回 Content-Type: application/json 的裸值，可直接 .json() 解析，无需额外处理字符串引号。"
            />
          </div>

          <!-- 自增/自减参数 -->
          <div v-else-if="operation === 'incDec'" class="op-params-vertical">
            <el-input
              v-model="incBodyJson"
              type="textarea"
              :rows="3"
              size="small"
              placeholder='{ "inc": { "flag": 1 }, "dec": { "stock": 5 } }'
            />
            <el-input
              v-model="incFilterJson"
              type="textarea"
              :rows="3"
              size="small"
              placeholder='{ "id": 1 } 或 { "flag": 0 }'
            />
            <div class="op-params-horizontal">
              <el-input-number
                v-model="incDelayMs"
                :min="0"
                :max="30000"
                :step="100"
                size="small"
              />
              <span class="hint-text">延迟执行 (ms, 上限 30000)</span>
            </div>
            <div class="hint-text">
              inc 原子 +，dec 原子 −；filter 匹配多行时全部更新；
              操作后自动回查并返回最新行数据。
            </div>
          </div>

          <!-- JSON 参数编辑区（filter / data） -->
          <div
            v-if="
              operation === 'list' ||
              operation === 'create' ||
              operation === 'update'
            "
            class="json-edit-area"
          >
            <template v-if="operation === 'list'">
              <div class="json-label">filter (JSON 对象，空 = 无过滤)</div>
              <el-input
                v-model="listParams.filterJson"
                type="textarea"
                :rows="6"
                placeholder='{ "username[_like]": "demo%" }'
              />
              <div v-if="filterParseError" class="error-hint">
                ⚠ JSON 解析错误：{{ filterParseError }}
              </div>
              <div
                v-else-if="listFilter && Object.keys(listFilter).length > 0"
                class="filter-ok-hint"
              >
                ✓ 已解析 {{ Object.keys(listFilter).length }} 个条件
              </div>
            </template>
            <template v-else>
              <div class="json-label">data (JSON 对象 — 要创建/更新的字段)</div>
              <el-input
                v-model="dataJson"
                type="textarea"
                :rows="8"
                placeholder='{ "field1": "value1", "field2": 123 }'
              />
            </template>
          </div>
        </div>
        <!-- 请求参数：SDK 调用的原始参数 -->
        <div class="panel request-params-panel">
          <div class="panel-title">📤 请求参数</div>
          <pre
            class="json-block"
          ><code>{{ lastRequest || "// 点击 ▶ 运行后显示 SDK 调用参数" }}</code></pre>
        </div>

        <!-- 请求详情：实际 HTTP 请求的完整信息（可折叠） -->
        <div class="panel request-detail-panel">
          <div
            class="panel-title collapsible"
            @click="requestDetailCollapsed = !requestDetailCollapsed"
          >
            <span>📡 请求详情</span>
            <span v-if="lastHttpRequest" class="collapse-hint">
              {{ lastHttpRequest.method }}
              {{ lastHttpRequest.url.split("?")[0] }}
            </span>
            <el-icon
              class="collapse-icon"
              :class="{ expanded: !requestDetailCollapsed }"
            >
              <svg viewBox="0 0 1024 1024" width="14" height="14">
                <path
                  d="M512 682.667c-8.533 0-17.067-2.134-23.467-8.534L147.2 332.8c-12.8-12.8-12.8-34.133 0-46.933s34.133-12.8 46.933 0L512 601.6l317.867-315.733c12.8-12.8 34.133-12.8 46.933 0s12.8 34.133 0 46.933L535.467 674.133c-6.4 6.4-14.934 8.534-23.467 8.534z"
                  fill="currentColor"
                />
              </svg>
            </el-icon>
          </div>
          <div v-show="!requestDetailCollapsed">
            <div v-if="lastHttpRequest" class="request-detail">
              <div class="req-row">
                <span class="req-label">Method</span>
                <span
                  class="req-method"
                  :class="`method-${lastHttpRequest.method.toLowerCase()}`"
                >
                  {{ lastHttpRequest.method }}
                </span>
              </div>
              <div class="req-row">
                <span class="req-label">URL</span>
                <span class="req-url">{{ lastHttpRequest.url }}</span>
              </div>
              <div v-if="lastHttpRequest.queryString" class="req-row">
                <span class="req-label">Query</span>
                <span class="req-url">{{ lastHttpRequest.queryString }}</span>
              </div>
              <div class="req-row">
                <span class="req-label">Headers</span>
                <pre class="req-headers">{{
                  JSON.stringify(lastHttpRequest.headers, null, 2)
                }}</pre>
              </div>
              <div v-if="lastHttpRequest.data" class="req-row">
                <span class="req-label">Body</span>
                <pre class="req-body">{{ lastHttpRequest.data }}</pre>
              </div>
              <div
                v-if="
                  lastHttpRequest.rawParams &&
                  Object.keys(lastHttpRequest.rawParams).length > 0
                "
                class="req-row"
              >
                <span class="req-label">SDK 参数</span>
                <pre class="req-body">{{
                  JSON.stringify(lastHttpRequest.rawParams, null, 2)
                }}</pre>
              </div>
            </div>
            <div v-else class="req-empty">
              // 点击 ▶ 运行后显示实际 HTTP 请求详情
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧：返回结果（独占） -->
      <div class="right-col">
        <div class="panel result-panel">
          <div class="panel-title">
            📥 返回结果
            <span
              v-if="lastHttpRequest?.status !== undefined"
              class="status-badge"
              :class="{
                ok: lastHttpRequest.ok,
                warn:
                  lastHttpRequest.status >= 400 && lastHttpRequest.status < 500,
                err:
                  lastHttpRequest.status >= 500 || lastHttpRequest.status === 0
              }"
            >
              {{ lastHttpRequest.ok ? "✓" : "✗" }}
              {{ lastHttpRequest.status || "ERR" }}
            </span>
            <span
              v-if="lastHttpRequest?.durationMs !== undefined"
              class="duration-badge"
            >
              ⏱ {{ lastHttpRequest.durationMs }}ms
            </span>
          </div>
          <pre
            class="json-block"
            :class="{ error: !!lastError && !lastResponse }"
          ><code>{{ lastResponse || lastError || "// 暂无结果" }}</code></pre>
          <div v-if="lastError && lastResponse" class="error-footer">
            ⚠ {{ lastError }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.foose-test {
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  height: calc(100vh - 150px);
}

.panel {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 5px;
  padding: 10px 15px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 3px;
  letter-spacing: 0.5px;
}

.main-body {
  display: flex;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.left-col {
  width: 500px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow: auto;
}

.right-col {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  min-width: 0;
}

.op-panel {
  display: flex;
  flex-direction: column;
}

.request-params-panel {
  flex-shrink: 0;
}

.request-detail-panel {
  flex-shrink: 0;
}

.result-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.small-label {
  margin-left: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.ml-2 {
  margin-left: 8px;
}

.w-full {
  width: 100%;
}

.op-option {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.op-label {
  font-weight: 500;
}
.op-desc {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.divider-gap {
  margin: 12px 0;
}

.op-params-vertical {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 4px;
}

.op-params-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.label-sm {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 0 2px;
}

.json-edit-area {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.json-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.error-hint {
  font-size: 12px;
  color: var(--el-color-warning);
}

.filter-ok-hint {
  font-size: 12px;
  color: var(--el-color-success);
}

.run-bar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.duration-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.json-block {
  margin: 0;
  padding: 12px;
  background: #1e1e1e;
  border-radius: 6px;
  overflow: auto;
  font-family: "Consolas", "Monaco", "Fira Code", monospace;
  font-size: 12px;
  line-height: 1.55;
  color: #d4d4d4;
  flex: 1;
  min-height: 0;

  &.half-height {
    max-height: none;
  }

  &.error {
    color: #f56c6c;
  }

  code {
    white-space: pre;
  }
}

.error-footer {
  margin-top: 8px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
  border-radius: 4px;
}

/* —— Status / Duration Badges（panel-title 内联） —— */
.status-badge,
.duration-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  padding: 1px 8px;
  border-radius: 10px;
  margin-left: 8px;
  font-family: "Consolas", "Monaco", monospace;
  letter-spacing: 0.5px;
}
.status-badge.ok {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}
.status-badge.warn {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}
.status-badge.err {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}
.duration-badge {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}

/* —— 请求详情面板样式 —— */
.request-detail-panel {
  flex-shrink: 0;
}

.panel-title.collapsible {
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 0;
  padding-bottom: 0;
}

.collapse-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-family: "Consolas", "Monaco", monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 360px;
}

.collapse-icon {
  margin-left: auto;
  color: var(--el-text-color-secondary);
  transition: transform 0.2s ease;

  &.expanded {
    transform: rotate(180deg);
  }
}

.request-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-family: "Consolas", "Monaco", "Fira Code", monospace;
  font-size: 12px;
}

.req-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.req-label {
  flex-shrink: 0;
  width: 60px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  font-family: inherit;
  font-size: 12px;
  padding-top: 2px;
}

.req-method {
  font-weight: 700;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  letter-spacing: 0.5px;

  &.method-get {
    background: var(--el-color-success-light-9);
    color: var(--el-color-success);
  }
  &.method-post {
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
  }
  &.method-patch {
    background: var(--el-color-warning-light-9);
    color: var(--el-color-warning);
  }
  &.method-delete {
    background: var(--el-color-danger-light-9);
    color: var(--el-color-danger);
  }
  &.method-put {
    background: var(--el-color-info-light-9);
    color: var(--el-color-info);
  }
}

.req-url {
  color: var(--el-color-primary);
  word-break: break-all;
  font-family: inherit;
  font-size: 12px;
}

.req-headers,
.req-body {
  margin: 0;
  padding: 6px 8px;
  background: #1e1e1e;
  border-radius: 4px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.5;
  color: #ce9178;
  white-space: pre-wrap;
  word-break: break-all;
  flex: 1;
}

.req-body {
  color: #dcdcaa;
}

.req-empty {
  color: var(--el-text-color-placeholder);
  font-family: "Consolas", "Monaco", monospace;
  font-size: 12px;
}
</style>
