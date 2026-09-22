<script setup lang="ts">
defineOptions({
  name: "FooseRoles"
});
import { ref, defineAsyncComponent, onMounted, computed, provide } from "vue";
import {
  Search,
  Refresh,
  CirclePlus,
  Remove,
  EditPen,
  Delete
} from "@element-plus/icons-vue";
import { debounce } from "@pureadmin/utils";
import { TableInstance, ElMessage, ElMessageBox } from "element-plus";
import { useRole } from "@/api/foose_user_role/foose_role_api";
import {
  FooseRoleUserRow,
  useRoleUser
} from "@/api/foose_user_role/foose_role_user_api";
import type { FooseListParams } from "@/api/foose_db";
import { FooseTools } from "@/api/foose_db";
const {
  listResult, // Ref<FooseRoleRow[]>   — 列表数据（自动被 getPageList/create/update/remove 同步）
  loading, // Ref<boolean>        — 当前是否正在请求
  errorInfo, // Ref<string | null>   — 最近一次请求的错误信息
  page, // Ref<number>         — 当前页码
  pageSize, // Ref<number>         — 每页大小
  total, // Ref<number>         — 总条数
  getPageList, // (params?) => Promise<FoosePage<FooseRoleRow>>
  getRow, // (id, fields?, join?) => Promise<FooseRoleRow>
  create, // (payload) => Promise<FooseRoleRow>
  creates, // (payloads[], showSql?) => Promise<{ ok, created, rows }>
  update, // (id, payload) => Promise<FooseRoleRow>
  updates, // (rows[], showSql?) => Promise<{ ok, updated, rows }>
  remove, // (id) => Promise<unknown>
  removes, // (ids[], showSql?) => Promise<{ ok, deleted }>
  removesByFilter // (filter, showSql?) => Promise<{ ok, deleted }>
} = useRole();
const {
  listResult: roleUserListResult,
  loading: roleUserLoading,
  errorInfo: roleUserErrorInfo,
  removesByFilter: roleUserRemovesByFilter
} = useRoleUser();

const currentPage = ref(1);
const currentPageSize = ref(10);

const AddEditRole = defineAsyncComponent(async () => {
  return import("@/views/foose_db/roles/edit.vue");
});

const queryRoleName = ref(""); // 查询角色名
// 添加或编辑角色
const addEditDialogVisible = ref(false); // 添加或编辑角色弹窗是否显示
const roleId = ref(0); // 当前角色ID
const dialogTitle = computed(() =>
  roleId.value > 0 ? "编辑角色" : "添加角色"
); // // 弹窗标题

onMounted(async () => {
  debounceLoadList(); // 初始化加载列表
});

// 防抖加载列表，300ms 内只执行一次,第一次立即执行
const debounceLoadList = debounce(
  async () => {
    const params: FooseListParams = {
      page: currentPage.value,
      pageSize: currentPageSize.value
    };
    queryRoleName.value = FooseTools.clearAllSpace(queryRoleName.value);
    if (queryRoleName.value.trim() !== "") {
      params["filter"] = { role_name: { _like: `%${queryRoleName.value}%` } };
    }
    try {
      await getPageList(params); // 加载分页列表
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载列表失败";
      ElMessage.error(msg);
    }
  },
  300,
  true
);

/** 查询 */
async function handleQuery() {
  currentPage.value = 1;
  debounceLoadList();
}
/** 重置查询 */
async function handleResetQuery() {
  queryRoleName.value = "";
  currentPage.value = 1;
  debounceLoadList();
}
/** 通用的确认操作 */
async function confirm(
  message: string,
  title: string = "请确认"
): Promise<boolean> {
  return await ElMessageBox.confirm(message, title, {
    confirmButtonText: "确定",
    cancelButtonText: "取消",
    type: "warning"
  })
    .then(() => {
      return true;
    })
    .catch(() => {
      return false;
    });
}

/** 添加用户 */
async function handleAdd() {
  roleId.value = 0;
  addEditDialogVisible.value = true;
}
/** 编辑用户 */
async function handleEdit(role_id: number) {
  if (!role_id || role_id <= 0) {
    ElMessage.error("角色ID不能为空");
    return;
  }
  roleId.value = role_id;
  addEditDialogVisible.value = true;
}
provide("handle-add-edit-role-close", (reload: boolean) => {
  // console.log("添加编辑角色弹窗关闭", reload);
  addEditDialogVisible.value = false;
  if (reload) {
    debounceLoadList();
  }
});
/** 移除角色 */
async function handleRemove(rowId: number, role_name: string) {
  if (rowId === 0) {
    ElMessage.error("角色ID不能为空");
    return;
  }
  if (!role_name) {
    ElMessage.error("角色名不能为空");
    return;
  }
  const confirmResult = await confirm(`确认删除角色 ${role_name} 吗？`);
  if (!confirmResult) {
    return;
  }
  const { ok, deleted } = await remove(rowId);
  console.log(ok, deleted);
  if (!ok || !deleted) {
    ElMessage.error("删除失败");
    return;
  }
  //角色删除后,同时要把foose_user_role表中的角色删除
  const res = await roleUserRemovesByFilter({ role_id: { _eq: rowId } }, true);
  if (!res || !res.ok) {
    ElMessage.error("删除角色关联失败");
    return;
  }

  debounceLoadList();
  ElMessage.success(`角色 ${role_name} 删除成功`);
}

/** 设置禁用/启用 */
async function handleSetFlag(rowId: number, flag: number) {
  if (rowId === 0) {
    ElMessage.error("用户ID不能为空");
    return;
  }
  if (![0, 1].includes(flag)) {
    ElMessage.error("请选择正确的标志状态");
    return;
  }
  if (flag === 0) {
    flag = 1;
  } else {
    flag = 0;
  }

  const res = await update(rowId, { flag: flag as 0 | 1 });
  if (!res || !res.id) {
    ElMessage.error("设置失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`设置成功`);
}
// 分页大小改变时,重置页码
const handleSizeChange = async (page_size: number) => {
  currentPage.value = 1; // 改变每页大小时,重置页码
  currentPageSize.value = page_size;
  debounceLoadList();
};
// 当前页码改变时,加载分页列表
const handleCurrentChange = async (val: number) => {
  currentPage.value = val;
  debounceLoadList();
};
</script>
<template>
  <div>
    <div class="flex_row mb-3">
      <div class="left">
        <el-row :gutter="8">
          <el-col :span="24">
            <el-input
              v-model="queryRoleName"
              placeholder="角色名"
              clearable
              style="width: 100%"
              @keyup.enter="handleQuery"
              @clear="handleQuery"
            />
          </el-col>
        </el-row>
      </div>
      <div class="right">
        <el-button
          type="primary"
          :loading="loading"
          :icon="Search"
          @click="handleQuery"
          >查询</el-button
        >
        <el-button :icon="Refresh" type="info" @click="handleResetQuery"
          >重置</el-button
        >
        <el-button
          class="ml-5!"
          :icon="CirclePlus"
          plain
          type="primary"
          @click="handleAdd"
          >添加角色</el-button
        >
      </div>
    </div>

    <div class="m-2">
      {{ roleUserErrorInfo }} {{ errorInfo }}
      <el-table
        ref="multipleTableRef"
        :data="listResult"
        row-key="id"
        stripe
        border
        style="width: 100%"
      >
        <el-table-column prop="id" label="ID" width="100" align="center">
          <template #default="scope">
            <el-text type="info" size="small" truncated>
              {{ scope.row.id }}
            </el-text>
          </template>
        </el-table-column>
        <el-table-column
          prop="role_name"
          label="角色名"
          sortable
          min-width="200"
        >
          <template #default="scope">
            <el-text class="mx-1" type="primary">
              {{ scope.row.role_name || "--" }}
            </el-text>
          </template>
        </el-table-column>

        <el-table-column
          prop="role_desc"
          label="角色描述"
          min-width="200"
          show-overflow-tooltip
        >
          <template #default="scope">
            <el-text class="mx-1" type="info">
              {{ scope.row.role_desc || "" }}
            </el-text>
          </template>
        </el-table-column>

        <el-table-column
          prop="flag"
          label="角色状态"
          width="100"
          align="center"
        >
          <template #default="scope">
            <el-tag
              class="mx-1"
              :type="scope.row.flag === 0 ? 'success' : 'danger'"
            >
              {{ scope.row.flag === 0 ? "已启用" : "已禁用" }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column fixed="right" label="操作" width="200" align="center">
          <template #default="scope">
            <el-button
              type="primary"
              class="my-button"
              plain
              :icon="EditPen"
              size="small"
              @click="handleEdit(scope.row.id)"
            >
              编辑
            </el-button>
            <el-button
              :type="scope.row.flag === 0 ? 'warning' : 'success'"
              class="my-button"
              plain
              :icon="Remove"
              size="small"
              @click="handleSetFlag(scope.row.id, scope.row.flag)"
            >
              {{ scope.row.flag === 0 ? "禁用" : "启用" }}
            </el-button>
            <el-button
              :disabled="scope.row.id === 1"
              title="移除角色"
              type="danger"
              class="my-button"
              plain
              :icon="Delete"
              size="small"
              @click="handleRemove(scope.row.id, scope.row.role_name)"
            />
          </template>
        </el-table-column>
      </el-table>
      <div class="mt-3 pagination-container">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          size="default"
          :page-sizes="[5, 10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          :total="total"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </div>
    <!-- 添加或编辑角色 -->
    <el-dialog
      v-model="addEditDialogVisible"
      :title="dialogTitle"
      width="70vw"
      align-center
      :close-on-press-escape="false"
      :close-on-click-modal="false"
      destroy-on-close
      draggable
      :show-close="false"
      :modal-penetrable="false"
    >
      <add-edit-role :role-id="roleId" />
    </el-dialog>
  </div>
</template>
<style lang="scss" scoped>
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
  width: 450px;
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
</style>
