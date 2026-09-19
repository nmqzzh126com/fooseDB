<script setup lang="ts">
import { ref, defineAsyncComponent, onMounted, computed, provide, } from 'vue'
import { useTabObjectTable } from "@/utils/hooks";
const { initToTab, getParameter } = useTabObjectTable();
initToTab();
const object_id = ref(Number(getParameter.object_id));
const object_name = ref(getParameter.object_name || "");
import { Search, Refresh, CirclePlus, Setting, Remove } from "@element-plus/icons-vue";
import { debounce } from "@pureadmin/utils";
const AddTable = defineAsyncComponent(async () => {
  return import("@/views/welcome/object_table/add.vue");
});
import {
  listTableRules,
  deleteTableRule,
  updateTableRule,
  type TableRule,
} from "@/api/foosePureAdmin";
import { TableInstance, ElMessage, ElMessageBox } from "element-plus";


defineOptions({
  name: "ObjectTables"
});
const defautPageIndex = ref(1); // 当前页码
const defaultPageSize = ref(10); // 每页大小
const total = ref(0); // 总记录数
const queryTableName = ref(""); // 查询表名称
const isLoading = ref(false);// 是否加载中
const tableList = ref<TableRule[]>([]);
const multipleTableRef = ref<TableInstance>()
const multipleSelection = ref<TableRule[]>([])//所有选择的表
const selectedTableIds = computed<number[]>(() => multipleSelection.value.map(item => item.id))
// 添加表
const addDialogVisible = ref(false);// 添加表弹窗是否显示
// 批量设置
const batchDialogVisible = ref(false);// 批量设置弹窗是否显示
const batchRow = ref<any>({
  blocked: 0,// 允许或禁止
  allow_select: 1,// 允许或禁止选择
  allow_insert: 1,// 允许或禁止插入
  allow_update: 1,// 允许或禁止更新
  allow_delete: 1,// 允许或禁止删除
  allow_batch_insert: 1,// 允许或禁止批量插入
  allow_batch_update: 1,// 允许或禁止批量更新
  allow_batch_delete: 1,// 允许或禁止批量删除
})

onMounted(async () => {
  debounceLoadList(); // 初始化加载列表
});

// 防抖加载列表，300ms 内只执行一次,第一次立即执行
const debounceLoadList = debounce(
  async () => {
    await loadPageList();
  },
  300,
  true
);
// 加载分页列表
const loadPageList = async () => {
  //console.log("加载分页列表");
  isLoading.value = true;
  const params = {
    page: defautPageIndex.value,
    page_size: defaultPageSize.value,
  };
  try {
    const res = await listTableRules(object_id.value, {
      page: defautPageIndex.value,
      pageSize: defaultPageSize.value,
      // 模糊匹配（自动补 % 前后缀）
      table_name: queryTableName.value?.trim() || undefined
    });
    tableList.value = res.items || [];
    //console.log(res);
    total.value = res.total || 0;
  } catch (e) {
    console.error("加载失败:", e instanceof Error ? e.message : e);
  } finally {
    isLoading.value = false;
  }
};
// 分页大小改变时,重置页码
const handleSizeChange = async (pageSize: number) => {
  defautPageIndex.value = 1; // 改变每页大小时,重置页码
  defaultPageSize.value = pageSize;
  debounceLoadList();
};
// 当前页码改变时,加载分页列表
const handleCurrentChange = async (val: number) => {
  defautPageIndex.value = val;
  debounceLoadList();
};
/** 重置查询 */
async function handleResetQuery() {
  defautPageIndex.value = 1;
  queryTableName.value = "";
  debounceLoadList();
}
/** 通用的确认操作 */
async function confirm(message: string, title: string = '请确认'): Promise<boolean> {
  return await ElMessageBox.confirm(
    message,
    title,
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    }
  )
    .then(() => {
      return true;
    })
    .catch(() => {
      return false;
    })
}


/**哪些不允许选择 */
const selectable = (row: TableRule) => {
  return true;// 允许选择所有表   
}
// 选择改变时,更新选择列表,确定所有选择的表IDs
const handleSelectionChange = (val: TableRule[]) => {
  multipleSelection.value = val
}
/** 添加表 */
async function handleAdd() {
  addDialogVisible.value = true;
}
provide("handle-add-table-close", (reload: boolean) => {
  addDialogVisible.value = false;
  if (reload) {
    debounceLoadList();
  }
});
/** 移除一条数据表 */
async function handleRemove(rowId: number, tableName: string) {
  if (rowId === 0) {
    ElMessage.error("数据表ID不能为空");
    return;
  }
  if (!tableName) {
    ElMessage.error("数据表名称不能为空");
    return;
  }
  const confirmResult = await confirm(`确认删除数据表 ${tableName} 吗？`);
  if (!confirmResult) {
    return;
  }
  const { ok, changes } = await deleteTableRule(rowId);
  if (!ok) {
    ElMessage.error("删除失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`删除成功,影响行数:${changes}`);
}

/** 批量设置 */
async function handleBatchSet() {
  if (selectedTableIds.value.length <= 1) {
    ElMessage.error("请选择要设置的数据表");
    return;
  }
  // 初始化批量设置表单
  batchRow.value.blocked = 0;
  batchRow.value.allow_select = 1;
  batchRow.value.allow_insert = 1;
  batchRow.value.allow_update = 1;
  batchRow.value.allow_delete = 1;
  batchRow.value.allow_batch_insert = 1;
  batchRow.value.allow_batch_update = 1;
  batchRow.value.allow_batch_delete = 1;
  batchDialogVisible.value = true;
}
/** 设置禁用/启用 */
async function handleSetBlock(rowId: number, blocked: number) {
  if (rowId === 0) {
    ElMessage.error("数据表ID不能为空");
    return;
  }
  if (![0, 1].includes(blocked)) {
    ElMessage.error("请选择正确的访问权限状态");
    return;
  }
  const res: TableRule = await updateTableRule(rowId, { blocked: blocked as 0 | 1 });
  if (!res || !res.id) {
    ElMessage.error("设置失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`设置成功`);
}

async function handleSetAllowOption(rowId: number, value: number, fieldName: string) {
  if (rowId === 0) {
    ElMessage.error("数据表ID不能为空");
    return;
  }
  if (![0, 1].includes(value)) {
    ElMessage.error("请选择正确的状态");
    return;
  }
  if (!fieldName) {
    ElMessage.error("数据表字段名称不能为空");
    return;
  }
  const row = {
    //allow_select: value as 0 | 1,     
  }
  row[fieldName] = value as 0 | 1;

  if (Object.keys(row).length === 0) {
    ElMessage.error("请选择要设置的选项");
    return;
  }
  const res: TableRule = await updateTableRule(rowId, row);
  if (!res || !res.id) {
    ElMessage.error("设置失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`设置成功`);
}
async function handleBatchSetConfirm() {
  if (selectedTableIds.value.length === 0) {
    ElMessage.error("请选择要设置的数据表");
    return;
  }
  const confirmResult = await confirm(`确认批量设置 ${selectedTableIds.value.length} 张数据表吗？`);
  if (!confirmResult) {
    return;
  }
  let errorCount = 0;
  for (const rowId of selectedTableIds.value) {
    const row = {
      ...batchRow.value,
    }
    const res: TableRule = await updateTableRule(rowId, row);
    if (!res || !res.id) {
      ElMessage.error("设置失败");
      errorCount++;
      continue;
    }
  }
  if (errorCount > 0) {
    ElMessage.error(`设置失败的数量:${errorCount}`);
  } else {
    ElMessage.success(`设置成功 ${selectedTableIds.value.length} 张数据表`);
  }
  batchDialogVisible.value = false;
  debounceLoadList();
}
/** 批量移除 */
async function handleBatchRemove() {
  if (selectedTableIds.value.length === 0) {
    ElMessage.error("请选择要移除的数据表");
    return;
  }
  const confirmResult = await confirm(`确认批量移除 ${selectedTableIds.value.length} 张数据表吗？`);
  if (!confirmResult) {
    return;
  }
  let errorCount = 0;
  for (const rowId of selectedTableIds.value) {
    const { ok, changes } = await deleteTableRule(rowId);
    if (!ok) {
      ElMessage.error("移除失败");
      errorCount++;
      continue;
    }
  }
  if (errorCount > 0) {
    ElMessage.error(`移除失败的数量:${errorCount}`);
  } else {
    ElMessage.success(`移除成功 ${selectedTableIds.value.length} 张数据表`);
  }
  debounceLoadList();
}

</script>
<template>
  <div>
    <div class="flex_row mb-3">
      <div class="left">
        <el-row :gutter="8">
          <el-col :span="8" class="pt-1">
            <el-text type="info" truncated>
              {{ object_name }}
            </el-text>
          </el-col>
          <el-col :span="16">
            <el-input v-model="queryTableName" placeholder="数据表名称" clearable style="width: 100%"
              @keyup.enter="debounceLoadList" @clear="debounceLoadList" />
          </el-col>
        </el-row>
      </div>
      <div class="right">
        <el-button type="primary" :loading="isLoading" :icon="Search" @click="debounceLoadList">查询</el-button>
        <el-button :icon="Refresh" type="info" @click="handleResetQuery">重置</el-button>
        <el-button class="ml-5!" :disabled="selectedTableIds.length <= 1" plain :icon="Setting" type="warning"
          @click="handleBatchSet">批量设置</el-button>
        <el-button :disabled="selectedTableIds.length <= 1" plain :icon="Remove" type="danger"
          @click="handleBatchRemove">批量移除</el-button>
        <el-button :icon="CirclePlus" plain type="primary" @click="handleAdd">添加表</el-button>
      </div>
    </div>
    <div class="m-2">
      <el-table ref="multipleTableRef" :data="tableList" row-key="id" stripe border style="width: 100%"
        @selection-change="handleSelectionChange">
        <el-table-column type="selection" :selectable="selectable" width="50" align="center" />
        <el-table-column prop="id" label="ID" width="70" align="center">
          <template #default="scope">
            <el-text type="info" size="small" truncated>
              {{ scope.row.id }}
            </el-text>
          </template>
        </el-table-column>

        <el-table-column prop="table_name" label="数据表名称" sortable width="200">
          <template #default="scope">
            <el-text class="mx-1" type="primary">
              {{ scope.row.table_name || "--" }}
            </el-text>
          </template>
        </el-table-column>
        <el-table-column prop="blocked" label="允许或禁用" width="130" sortable align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.blocked" inline-prompt size="small"
              style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="0"
              :inactive-value="1" active-text="允许" inactive-text="禁止"
              @change="handleSetBlock(scope.row.id, scope.row.blocked)" />
          </template>
        </el-table-column>
        <el-table-column prop="allow_select" label="查询" width="85" sortable align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.allow_select" :disabled="scope.row.blocked === 1" inline-prompt size="small"
              style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
              :inactive-value="0" active-text="允许" inactive-text="禁止"
              @change="handleSetAllowOption(scope.row.id, scope.row.allow_select, 'allow_select')" />
          </template>
        </el-table-column>
        <el-table-column prop="allow_insert" label="添加" width="85" sortable align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.allow_insert" :disabled="scope.row.blocked === 1" inline-prompt size="small"
              style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
              :inactive-value="0" active-text="允许" inactive-text="禁止"
              @change="handleSetAllowOption(scope.row.id, scope.row.allow_insert, 'allow_insert')" />
          </template>
        </el-table-column>
        <el-table-column prop="allow_update" label="更新" width="85" sortable align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.allow_update" :disabled="scope.row.blocked === 1" inline-prompt size="small"
              style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
              :inactive-value="0" active-text="允许" inactive-text="禁止"
              @change="handleSetAllowOption(scope.row.id, scope.row.allow_update, 'allow_update')" />
          </template>
        </el-table-column>
        <el-table-column prop="allow_delete" label="删除" width="85" sortable align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.allow_delete" :disabled="scope.row.blocked === 1" inline-prompt size="small"
              style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
              :inactive-value="0" active-text="允许" inactive-text="禁止"
              @change="handleSetAllowOption(scope.row.id, scope.row.allow_delete, 'allow_delete')" />
          </template>
        </el-table-column>
        <el-table-column prop="allow_batch_insert" label="批量添加" width="110" sortable align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.allow_batch_insert" :disabled="scope.row.blocked === 1" inline-prompt
              size="small" style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
              :inactive-value="0" active-text="允许" inactive-text="禁止"
              @change="handleSetAllowOption(scope.row.id, scope.row.allow_batch_insert, 'allow_batch_insert')" />
          </template>
        </el-table-column>
        <el-table-column prop="allow_batch_update" label="批量更新" width="110" sortable align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.allow_batch_update" :disabled="scope.row.blocked === 1" inline-prompt
              size="small" style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
              :inactive-value="0" active-text="允许" inactive-text="禁止"
              @change="handleSetAllowOption(scope.row.id, scope.row.allow_batch_update, 'allow_batch_update')" />
          </template>
        </el-table-column>
        <el-table-column prop="allow_batch_delete" label="批量删除" width="110" sortable align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.allow_batch_delete" :disabled="scope.row.blocked === 1" inline-prompt
              size="small" style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
              :inactive-value="0" active-text="允许" inactive-text="禁止"
              @change="handleSetAllowOption(scope.row.id, scope.row.allow_batch_delete, 'allow_batch_delete')" />
          </template>
        </el-table-column>
        <el-table-column fixed="right" label="操作" width="100" align="center">
          <template #default="scope">
            <el-button type="danger" class="my-button" plain :icon="Remove" size="small"
              @click="handleRemove(scope.row.id, scope.row.table_name)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div class="mt-3 pagination-container">
      <el-pagination v-model:current-page="defautPageIndex" v-model:page-size="defaultPageSize" size="default"
        :page-sizes="[5, 10, 20, 50, 100]" layout="total, sizes, prev, pager, next, jumper" :total="total"
        @size-change="handleSizeChange" @current-change="handleCurrentChange" />
    </div>
    <!-- 批量设置 -->
    <el-dialog v-model="batchDialogVisible" title="批量设置" width="70vw" align-center>
      <div class="p-2">
        <el-form :model="batchRow" label-width="auto" width="100%">
          <div>
            <el-form-item label="允许或禁用(总开关)">
              <el-switch v-model="batchRow.blocked" inline-prompt
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="0"
                :inactive-value="1" active-text="允许" inactive-text="禁止" />
              <el-text type="danger" class="ml-5!"> 批量设置 {{ selectedTableIds.length }} 张数据表</el-text>
            </el-form-item>
          </div>
          <div>
            <el-row>
              <el-col :xs="12" :sm="8" :md="6">
                <el-form-item label="查询">
                  <el-switch v-model="batchRow.allow_select" :disabled="batchRow.blocked === 1" inline-prompt
                    style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
                    :inactive-value="0" active-text="允许" inactive-text="禁止" />
                </el-form-item>
              </el-col>
              <el-col :xs="12" :sm="8" :md="6">
                <el-form-item label="添加">
                  <el-switch v-model="batchRow.allow_insert" :disabled="batchRow.blocked === 1" inline-prompt
                    style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
                    :inactive-value="0" active-text="允许" inactive-text="禁止" />
                </el-form-item>
              </el-col>
              <el-col :xs="12" :sm="8" :md="6">
                <el-form-item label="更新">
                  <el-switch v-model="batchRow.allow_update" :disabled="batchRow.blocked === 1" inline-prompt
                    style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
                    :inactive-value="0" active-text="允许" inactive-text="禁止" />
                </el-form-item>
              </el-col>
              <el-col :xs="12" :sm="8" :md="6">
                <el-form-item label="删除">
                  <el-switch v-model="batchRow.allow_delete" :disabled="batchRow.blocked === 1" inline-prompt
                    style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
                    :inactive-value="0" active-text="允许" inactive-text="禁止" />
                </el-form-item>
              </el-col>
              <el-col :xs="12" :sm="8" :md="6">
                <el-form-item label="批量添加">
                  <el-switch v-model="batchRow.allow_batch_insert" :disabled="batchRow.blocked === 1" inline-prompt
                    style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
                    :inactive-value="0" active-text="允许" inactive-text="禁止" />
                </el-form-item>
              </el-col>
              <el-col :xs="12" :sm="8" :md="6">
                <el-form-item label="批量更新">
                  <el-switch v-model="batchRow.allow_batch_update" :disabled="batchRow.blocked === 1" inline-prompt
                    style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
                    :inactive-value="0" active-text="允许" inactive-text="禁止" />
                </el-form-item>
              </el-col>
              <el-col :xs="12" :sm="8" :md="6">
                <el-form-item label="批量删除">
                  <el-switch v-model="batchRow.allow_batch_delete" :disabled="batchRow.blocked === 1" inline-prompt
                    style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="1"
                    :inactive-value="0" active-text="允许" inactive-text="禁止" />
                </el-form-item>
              </el-col>
            </el-row>
          </div>
        </el-form>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="batchDialogVisible = false">取消</el-button>
          <el-button type="primary" @click="handleBatchSetConfirm">
            确认设置
          </el-button>
        </div>
      </template>
    </el-dialog>
    <!-- 添加表弹窗 -->
    <el-dialog v-model="addDialogVisible" title="添加表" width="70vw" align-center :close-on-press-escape="false"
      :close-on-click-modal="false" destroy-on-close draggable :show-close="false" :modal-penetrable="false">
      <add-table :object-id="object_id" />
    </el-dialog>
  </div>
</template>
<style lang='scss' scoped>
.flex_row {
  display: flex;
  width: 100%;
  gap: 0;
}

.left {
  flex: 1;
}

.right {
  padding-left: 10px;
  width: 600px;
  text-align: left;
}

.pagination-container {
  display: flex;
  justify-content: center;
  align-items: center;
}

.my-button {
  padding-left: 8px;
  padding-right: 8px;
}

:deep(.el-switch.is-disabled) {
  opacity: 0.3;
}
</style>