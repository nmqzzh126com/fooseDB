<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { useRenderIcon } from "@/components/ReIcon/src/hooks";
import { message } from "@/utils/message";
import {
  listObjects,
  createObject,
  updateObject,
  deleteObject,
  testConnection,
  type ObjectDef
} from "@/api/foosePureAdmin";
import { useTabTestApiDetail } from "@/utils/hooks";
import {
  Delete,
  EditPen,
  MagicStick,
  Refresh,
  Plus,
  Search,
  Setting,
  Connection,
  CircleCheck,
  CircleClose
} from "@element-plus/icons-vue";
defineOptions({
  name: "ObjectIndex"
});
const { toTabTestApiByQuery } = useTabTestApiDetail();
const formRef = ref();
const tableRef = ref();
const loading = ref(false);
const dataList = ref<ObjectDef[]>([]);

// 测试 API 组件
import testApi from "@/views/object/test_api.vue";
const dialogTestApiVisible = ref(false);
const apiName = ref("");
const dbType = ref("");
const dbUrl = ref("");
const dbPath = ref("");

/** 搜索表单 */
const form = reactive({
  name: ""
});

/** 分页（listObjects 返回完整数组，前端按需分页） */
const pagination = reactive({
  total: 0,
  pageSize: 10,
  currentPage: 1
});

const pageSizes = [10, 20, 50, 100];

/** 选中行 */
const selectedRows = ref<ObjectDef[]>([]);

/** 前端分页切片 */
const pagedList = computed(() => {
  const start = (pagination.currentPage - 1) * pagination.pageSize;
  return dataList.value.slice(start, start + pagination.pageSize);
});

/** 弹框状态（Element Plus 原生 el-dialog） */
const dialogVisible = ref(false);
const dialogLoading = ref(false);
const dialogTitle = ref("新增接口");
const isEdit = ref(false);
/** 测试连接状态（弹框 footer 内联显示） */
const testStatus = ref<"idle" | "loading" | "success" | "error">("idle");
const testMsg = ref("");

/** 编辑表单数据（直接在主页面定义，不依赖 form 子组件） */
const dialogForm = reactive({
  id: undefined as number | undefined,
  name: "",
  description: "",
  db_type: "sqlite" as ObjectDef["db_type"],
  db_url: "",
  db_path: "",
  cors_origins: "*",
  cors_methods: "GET,POST,PUT,DELETE,OPTIONS",
  auth_required: 1 as 0 | 1,
  custom_sql_enabled: 0 as 0 | 1
});

/** dialog 内的 el-form ref（通过 template ref 访问其 validate） */
const dialogFormRef = ref();

/** dialog 表单校验规则（和 form/index.vue 之前那份一致） */
const dialogRules = {
  name: [
    { required: true, message: "请输入接口标识", trigger: "blur" },
    { min: 2, max: 50, message: "长度在 2 到 50 个字符", trigger: "blur" },
    {
      pattern: /^[a-zA-Z0-9_-]+$/,
      message: "只能包含字母、数字、下划线和连字符",
      trigger: "blur"
    }
  ],
  db_type: [{ required: true, message: "请选择数据库类型", trigger: "change" }],
  db_url: [{ required: true, message: "请输入数据库连接串", trigger: "change" }]
};

/** 加载列表 */
async function onSearch() {
  loading.value = true;
  try {
    const all = await listObjects();
    // 前端按 name 过滤（后端 /config/objects 无 search 参数）
    const filtered = form.name
      ? all.filter(o => o.name.toLowerCase().includes(form.name!.toLowerCase()))
      : all;
    dataList.value = filtered;
    pagination.total = filtered.length;
    pagination.currentPage = 1;
  } catch (err: any) {
    message(err?.message ?? "加载接口列表失败", { type: "error" });
  } finally {
    loading.value = false;
  }
}

function resetForm(formEl: any) {
  formEl?.resetFields?.();
  form.name = "";
  onSearch();
}

function handleSizeChange(size: number) {
  pagination.pageSize = size;
  pagination.currentPage = 1;
}
function handleCurrentChange(cur: number) {
  pagination.currentPage = cur;
}
function handleSelectionChange(selection: ObjectDef[]) {
  selectedRows.value = selection;
}
function onSelectionCancel() {
  tableRef.value?.clearSelection?.();
}

/** 重置 dialogForm */
function resetDialogForm() {
  Object.assign(dialogForm, {
    id: undefined,
    name: "",
    description: "",
    db_type: "sqlite",
    db_url: "",
    db_path: "",
    cors_origins: "*",
    cors_methods: "GET,POST,PUT,DELETE,OPTIONS",
    auth_required: 1,
    custom_sql_enabled: 0
  });
}

/** 打开新增/编辑弹框 */
function openDialog(title = "新增", row?: ObjectDef) {
  isEdit.value = !!row;
  dialogTitle.value = `${title}接口`;
  if (isEdit.value && row) {
    Object.assign(dialogForm, {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      db_type: row.db_type,
      db_url: row.db_url ?? "",
      db_path: row.db_path ?? "",
      cors_origins: row.cors_origins,
      cors_methods: row.cors_methods,
      auth_required: row.auth_required,
      custom_sql_enabled: row.custom_sql_enabled
    });
  } else {
    resetDialogForm();
  }
  dialogVisible.value = true;
}

/** dialog 提交 */
async function handleSubmit() {
  if (!dialogFormRef.value) return;
  await dialogFormRef.value.validate(async (valid: boolean) => {
    if (!valid) return;
    dialogLoading.value = true;
    try {
      if (isEdit.value) {
        const updateRes = await updateObject(dialogForm.id!, {
          description: dialogForm.description,
          db_type: dialogForm.db_type,
          db_url: dialogForm.db_url || null,
          db_path: dialogForm.db_path || null,
          cors_origins: dialogForm.cors_origins,
          cors_methods: dialogForm.cors_methods,
          auth_required: dialogForm.auth_required,
          custom_sql_enabled: dialogForm.custom_sql_enabled
        });
        //console.log(updateRes);
        if (updateRes && updateRes.id) {
          message(`修改接口 ${dialogForm.name} 成功`, { type: "success" });
        } else {
          message(`修改接口 ${dialogForm.name} 失败`, { type: "error" });
        }
      } else {
        const createRes = await createObject({
          name: dialogForm.name,
          description: dialogForm.description || null,
          db_type: dialogForm.db_type,
          db_url: dialogForm.db_url || null,
          db_path: dialogForm.db_path || null,
          cors_origins: dialogForm.cors_origins || "*",
          cors_methods: dialogForm.cors_methods || "GET,POST,PUT,DELETE,OPTIONS",
          auth_required: dialogForm.auth_required,
          custom_sql_enabled: dialogForm.custom_sql_enabled
        });
        console.log(createRes);
        if (createRes && createRes.id) {
          message(`新增接口 ${dialogForm.name} 成功`, { type: "success" });
        } else {
          message(`新增接口 ${dialogForm.name} 失败`, { type: "error" });
        }
      }
      dialogVisible.value = false;
      onSearch();
    } catch (err: any) {
      message(err?.message ?? "操作失败", { type: "error" });
    } finally {
      dialogLoading.value = false;
    }
  });
}

/** 删除单条 */
async function handleDelete(row: ObjectDef) {
  try {
    await deleteObject(row.id);
    message(`删除接口 ${row.name} 成功`, { type: "success" });
    onSearch();
  } catch (err: any) {
    message(err?.message ?? "删除失败", { type: "error" });
  }
}

/** 批量删除 */
async function onbatchDel() {
  if (!selectedRows.value.length) return;
  try {
    for (const row of selectedRows.value) {
      await deleteObject(row.id);
    }
    message(`已删除 ${selectedRows.value.length} 项`, { type: "success" });
    onSearch();
  } catch (err: any) {
    message(err?.message ?? "批量删除失败", { type: "error" });
  }
}

/** dialog 关闭前重置表单校验状态 */
function handleDialogClose() {
  dialogFormRef.value?.resetFields?.();
  testStatus.value = "idle";
  testMsg.value = "";
}



async function onTestConnection() {
  // 先做基本校验
  if (!dialogForm.db_type) {
    testStatus.value = "error";
    testMsg.value = "请先选择数据库类型";
    return;
  }
  if (dialogForm.db_type === "sqlite" && !dialogForm.db_path) {
    testStatus.value = "error";
    testMsg.value = "SQLite 需要填写数据库文件路径";
    return;
  }
  if (dialogForm.db_type !== "sqlite" && !dialogForm.db_url) {
    testStatus.value = "error";
    testMsg.value = "需要填写数据库连接串 db_url";
    return;
  }

  testStatus.value = "loading";
  testMsg.value = "正在测试连接...";
  try {
    const res = await testConnection({
      db_type: dialogForm.db_type,
      db_url: dialogForm.db_url || null,
      db_path: dialogForm.db_path || null
    });
    testStatus.value = "success";
    testMsg.value = res.message ?? "连接成功";
  } catch (err: any) {
    testStatus.value = "error";
    testMsg.value = err?.message ?? "连接失败";
  }
}

/** 测试API */
async function handleTestApi(row: ObjectDef) {
  apiName.value = row.name || "";
  dbType.value = row.db_type || "";
  dbUrl.value = row.db_url || "";
  dbPath.value = row.db_path || "";
  dialogTestApiVisible.value = true;
}



onMounted(() => {
  onSearch();
});
</script>

<template>
  <div>
    <div class="main-content">
      <el-form ref="formRef" :inline="true" :model="form"
        class="search-form bg-bg_color w-full pl-8 pt-3 overflow-auto">
        <el-form-item label="接口名称：" prop="name">
          <el-input v-model="form.name" placeholder="请输入接口名称" clearable class="w-50!" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="useRenderIcon(Search)" :loading="loading" @click="onSearch">
            搜索
          </el-button>
          <el-button :icon="useRenderIcon(Refresh)" @click="resetForm(formRef)"> 重置 </el-button>
          <el-button class="ml-10!" type="primary" plain :icon="useRenderIcon(Plus)" @click="openDialog()">
            新增接口
          </el-button>
        </el-form-item>
      </el-form>

      <div class="table-card bg-bg_color">
        <!-- 工具栏 
        <div class="table-toolbar flex  justify-between px-4 py-2.5">
          <span class="text-sm font-medium">&nbsp;</span>
          <el-button type="primary" :icon="useRenderIcon(Plus)" @click="openDialog()">
            新增接口
          </el-button>
        </div>
-->
        <!-- 批量操作栏 -->
        <transition name="fade">
          <div v-if="selectedRows.length > 0"
            class="batch-bar flex  justify-between px-4 py-2 border-y border-solid border-(--el-border-color-lighter) bg-(--el-fill-color-light)">
            <span class="text-sm text-(--el-text-color-secondary)">已选 {{ selectedRows.length }} 项</span>
            <div class="flex items-center gap-2">
              <el-button text type="primary" @click="onSelectionCancel">取消选择</el-button>
              <el-popconfirm title="是否确认删除选中的接口？" @confirm="onbatchDel">
                <template #reference>
                  <el-button text type="danger">批量删除</el-button>
                </template>
              </el-popconfirm>
            </div>
          </div>
        </transition>

        <!-- 表格 -->
        <el-table ref="tableRef" row-key="id" border stripe :data="pagedList" :loading="loading"
          @selection-change="handleSelectionChange">
          <el-table-column type="selection" width="40" />
          <el-table-column prop="id" label="ID" width="100" />
          <el-table-column prop="name" label="接口名称" min-width="140" show-overflow-tooltip />
          <el-table-column prop="description" label="接口描述" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <span>{{ row.description || "—" }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="db_type" label="数据库类型" width="120">
            <template #default="{ row }">
              <span v-if="row.db_type === 'sqlite'">SQLite</span>
              <span v-else-if="row.db_type === 'mysql'">MySQL</span>
              <span v-else-if="row.db_type === 'postgres'">PostgreSQL</span>
              <span v-else>{{ row.db_type }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="auth_required" label="鉴权" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.auth_required ? 'success' : 'info'" size="small">
                {{ row.auth_required ? "开启" : "关闭" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="custom_sql_enabled" label="自定义 SQL" width="120" align="center">
            <template #default="{ row }">
              <el-tag :type="row.custom_sql_enabled ? 'warning' : 'info'" size="small">
                {{ row.custom_sql_enabled ? "开启" : "关闭" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="250" fixed="right" align="left">
            <template #default="{ row }">
              <el-button size="small" plain type="primary" :icon="useRenderIcon(Setting)"
                @click="openDialog('配置', row as ObjectDef)">
                配置
              </el-button>
              <el-button size="small" type="primary" :icon="useRenderIcon(EditPen)"
                @click="toTabTestApiByQuery({ id: row.id })">
                接口测试
              </el-button>
              <el-popconfirm v-if="row.name !== 'sqlite_demo'" :title="`是否确认删除接口 ${row.name}？`"
                @confirm="handleDelete(row as ObjectDef)">
                <template #reference>
                  <el-button size="small" plain type="danger" :icon="useRenderIcon(Delete)" />
                </template>
              </el-popconfirm>
            </template>
          </el-table-column>
        </el-table>

        <!-- 分页 -->
        <div class="flex justify-end px-4 py-3">
          <el-pagination v-model:current-page="pagination.currentPage" v-model:page-size="pagination.pageSize"
            :page-sizes="pageSizes" :total="pagination.total" layout="total, sizes, prev, pager, next, jumper"
            @size-change="handleSizeChange" @current-change="handleCurrentChange" />
        </div>
      </div>

      <!-- 新增/编辑弹框（Element Plus 原生 el-dialog + el-form） -->
      <el-dialog v-model="dialogVisible" :title="dialogTitle" width="85vw" :close-on-click-modal="false"
        :close-on-press-escape="false" draggable destroy-on-close @close="handleDialogClose">
        <el-form ref="dialogFormRef" :model="dialogForm" :rules="dialogRules" label-width="150px"
          label-position="right">
          <el-row :gutter="24">
            <el-col :span="12">
              <el-form-item label="接口标识" prop="name">
                <el-input v-model="dialogForm.name" clearable placeholder="英文唯一标识，如 blog / shop" :disabled="isEdit" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="数据库类型" prop="db_type">
                <el-select v-model="dialogForm.db_type" placeholder="请选择数据库类型" class="w-full">
                  <el-option label="SQLite" value="sqlite" />
                  <el-option label="MySQL" value="mysql" />
                  <el-option label="PostgreSQL" value="postgres" />
                </el-select>
              </el-form-item>
            </el-col>

            <!-- sqlite 用 db_path -->
            <el-col v-if="dialogForm.db_type === 'sqlite'" :span="20">
              <el-form-item label="数据库文件路径" prop="db_path">
                <el-input v-model="dialogForm.db_path" clearable placeholder="留空使用默认路径；或填写绝对/相对路径" />
              </el-form-item>
            </el-col>

            <!-- mysql/postgres 用 db_url -->
            <el-col v-if="dialogForm.db_type !== 'sqlite'" :span="20">
              <el-form-item label="数据库连接串" prop="db_url">
                <el-input v-model="dialogForm.db_url" clearable :placeholder="dialogForm.db_type === 'mysql'
                  ? 'mysql://user:pass@host:3306/dbname'
                  : 'postgres://user:pass@host:5432/dbname'
                  " />
              </el-form-item>
            </el-col>
            <el-col :span="4" class="text-right">
              <el-button type="warning" plain :icon="useRenderIcon(Connection)" :loading="testStatus === 'loading'"
                @click="onTestConnection">
                测试连接
              </el-button>
            </el-col>

            <el-col :span="24">
              <el-form-item label="接口描述" prop="description">
                <el-input v-model="dialogForm.description" clearable type="textarea" :rows="2"
                  placeholder="可选，对该接口的简短描述" />
              </el-form-item>
            </el-col>

            <el-col :span="12">
              <el-form-item label="CORS origins" prop="cors_origins">
                <el-input v-model="dialogForm.cors_origins" clearable placeholder="多个用逗号分隔，* 表示全部" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="CORS methods" prop="cors_methods">
                <el-input v-model="dialogForm.cors_methods" clearable placeholder="GET,POST,PUT,DELETE,OPTIONS" />
              </el-form-item>
            </el-col>

            <el-col :span="12">
              <el-form-item label="需要登录鉴权" prop="auth_required">
                <el-switch v-model="dialogForm.auth_required" :active-value="1" :inactive-value="0" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="启用自定义 SQL" prop="custom_sql_enabled">
                <el-switch v-model="dialogForm.custom_sql_enabled" :active-value="1" :inactive-value="0" />
              </el-form-item>
            </el-col>
          </el-row>
        </el-form>

        <template #footer>
          <div class="flex items-end gap-3 flex-1">
            <transition name="fade">
              <div v-if="testStatus === 'success'" class="flex items-center gap-1 text-(--el-color-success) text-sm">
                <el-icon>
                  <CircleCheck />
                </el-icon>
                <span>{{ testMsg }}</span>
              </div>
              <div v-else-if="testStatus === 'error'" class="flex items-center gap-1 text-(--el-color-danger) text-sm">
                <el-icon>
                  <CircleClose />
                </el-icon>
                <span>{{ testMsg }}</span>
              </div>
            </transition>
          </div>
          <div class="flex items-end gap-2">
            <el-button @click="dialogVisible = false">取消</el-button>
            <el-button type="primary" :loading="dialogLoading" @click="handleSubmit">
              确定
            </el-button>
            如果修改配置, 请重启服务生效
          </div>
        </template>
      </el-dialog>
      <!-- 测试API弹框（Element Plus 原生 el-dialog + el-form） -->
      <el-dialog v-model="dialogTestApiVisible" :title="dialogTitle" width="85vw" :close-on-click-modal="false"
        :close-on-press-escape="false" draggable destroy-on-close>
        <test-api :api-name="apiName" :db-type="dbType" :db-url="dbUrl" :db-path="dbPath" />
      </el-dialog>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.main-content {
  margin: 20px 20px 0 !important;
}

.search-form {
  :deep(.el-form-item) {
    margin-bottom: 12px;
  }
}

.table-card {
  border-radius: 4px;
}

.table-toolbar {
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
