<script setup lang="ts">
defineOptions({
  name: "ObjectUsers"
});
import { ref, defineAsyncComponent, onMounted, computed, provide } from "vue";

import {
  Search,
  Refresh,
  CirclePlus,
  Setting,
  Remove,
  EditPen,
  Delete
} from "@element-plus/icons-vue";
import { debounce } from "@pureadmin/utils";
import { TableInstance, ElMessage, ElMessageBox } from "element-plus";
import { FooseUserRow, useUser } from "@/api/foose_user_role/foose_user_api";
import type { FooseListParams } from "@/api/foose_db";
import { FooseTools } from "@/api/foose_db";
const {
  listResult: userList, // Ref<FooseUserRow[]>   — 列表数据（自动被 getPageList/create/update/remove 同步）
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
} = useUser();
//import { generatePassword, validatePassword } from "../utils";

const AddEditUser = defineAsyncComponent(async () => {
  return import("@/views/foose_db/users/edit.vue");
});
const defautPageIndex = ref(1); // 当前页码
const defaultPageSize = ref(10); // 每页大小
const queryUserName = ref(""); // 查询用户名
const queryNickname = ref(""); // 查询昵称

const multipleTableRef = ref<TableInstance>();
const multipleSelection = ref<FooseUserRow[]>([]); //所有选择的表
const selectedUserIds = computed<number[]>(() =>
  multipleSelection.value.map(item => item.id)
);
// 添加或编辑用户
const addEditDialogVisible = ref(false); // 添加或编辑用户弹窗是否显示
const userId = ref(0); // 当前用户ID
const dialogTitle = computed(() =>
  userId.value > 0 ? "编辑用户" : "添加用户"
); // // 弹窗标题
// 批量设置用户
const batchDialogVisible = ref(false); // 批量设置用户弹窗是否显示
const batchRow = ref({
  flag: -1,
  new_password: ""
  //confirm_password: "",
}); // 批量设置用户列表
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
  const params: FooseListParams = {
    page: defautPageIndex.value,
    pageSize: defaultPageSize.value,
    orderBy: ["id DESC"]
  };
  queryUserName.value = FooseTools.clearAllSpace(queryUserName.value || "");
  queryNickname.value = FooseTools.clearAllSpace(queryNickname.value || "");
  const filter = {};
  if (queryUserName.value.length > 0) {
    filter["username"] = { _like: `%${queryUserName.value?.trim() || ""}%` };
  }
  if (queryNickname.value.length > 0) {
    filter["nickname"] = { _like: `%${queryNickname.value?.trim() || ""}%` };
  }
  if (Object.keys(filter).length > 0) {
    params["filter"] = filter;
  }

  try {
    await getPageList(params);
    //console.log("加载分页列表", userList.value);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "加载列表失败";
    ElMessage.error(msg);
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
  queryUserName.value = "";
  queryNickname.value = "";
  debounceLoadList();
}
async function handleQuery() {
  defautPageIndex.value = 1;
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

/**哪些不允许选择 */
const selectable = (row: FooseUserRow) => {
  return true; // 允许选择所有表
};
// 选择改变时,更新选择列表,确定所有选择的表IDs
const handleSelectionChange = (val: FooseUserRow[]) => {
  multipleSelection.value = val;
};
/** 添加用户 */
async function handleAdd() {
  userId.value = 0;
  addEditDialogVisible.value = true;
}
/** 编辑用户 */
async function handleEdit(user_id: number) {
  if (!user_id || user_id <= 0) {
    ElMessage.error("用户ID不能为空");
    return;
  }
  userId.value = user_id;
  addEditDialogVisible.value = true;
}
provide("handle-add-edit-user-close", (reload: boolean) => {
  // console.log("添加编辑用户弹窗关闭", reload);
  addEditDialogVisible.value = false;
  if (reload) {
    debounceLoadList();
  }
});
/** 移除用户 */
async function handleRemove(rowId: number, username: string, nickname: string) {
  if (rowId === 0) {
    ElMessage.error("用户ID不能为空");
    return;
  }
  if (!username) {
    ElMessage.error("用户名不能为空");
    return;
  }
  const confirmResult = await confirm(`确认删除用户 ${username} 吗？`);
  if (!confirmResult) {
    return;
  }
  const { ok } = await remove(rowId);
  if (!ok) {
    ElMessage.error("删除失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`用户 ${username} ${nickname} 删除成功`);
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

  const res: FooseUserRow = await update(rowId, { flag: flag as 0 | 1 });
  if (!res || !res.id) {
    ElMessage.error("设置失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`设置成功`);
}

/** 批量移除 */
async function handleBatchRemove() {
  if (selectedUserIds.value.length === 0) {
    ElMessage.error("请选择要移除的用户");
    return;
  }
  const confirmResult = await confirm(
    `确认批量移除 ${selectedUserIds.value.length} 个用户吗？`
  );
  if (!confirmResult) {
    return;
  }
  let errorCount = 0;
  for (const rowId of selectedUserIds.value) {
    const { ok } = await remove(rowId);
    if (!ok) {
      ElMessage.error("移除失败");
      errorCount++;
      continue;
    }
  }
  if (errorCount > 0) {
    ElMessage.error(`移除失败的数量:${errorCount}`);
  } else {
    ElMessage.success(`移除成功 ${selectedUserIds.value.length} 个用户`);
  }
  debounceLoadList();
}
async function handleBatchSetConfirm() {
  if (selectedUserIds.value.length === 0) {
    ElMessage.error("请选择要设置的用户");
    return;
  }
  const updateRow = {};
  batchRow.value.new_password = FooseTools.clearAllSpace(
    batchRow.value.new_password || ""
  );

  if (batchRow.value.new_password !== "") {
    // 校验密码是否符合规则
    updateRow["password"] = batchRow.value.new_password; //确认修改密码
  }

  if (Number(batchRow.value.flag) === 0 || Number(batchRow.value.flag) === 1) {
    updateRow["flag"] = Number(batchRow.value.flag) as 0 | 1;
  }
  if (Object.keys(updateRow).length === 0) {
    ElMessage.error("填写错误,无法批量处理!");
    return;
  }
  const confirmResult = await confirm(
    `确认批量设置 ${selectedUserIds.value.length} 个用户信息吗？`
  );
  if (!confirmResult) {
    return;
  }
  console.log("batch rows:", updateRow);

  // ===== 批量更新示例 =====
  // updates(rows[], showSql?)
  // rows 必须带 id，其余列是 patch（只更新传入的列）
  // 返回 { ok, updated, rows: [更新后的完整行...] }
  try {
    const rowsToUpdate = selectedUserIds.value.map(id => ({
      id, // 每一行必须带 id
      ...updateRow // patch：只传要更新的字段（flag / password 等）
    }));
    const { ok, updated } = await updates(rowsToUpdate);
    if (!ok) {
      ElMessage.error("批量设置失败");
      return;
    }
    ElMessage.success(`批量设置成功 ${updated} 个用户`);
    debounceLoadList();
    batchDialogVisible.value = false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "批量设置失败";
    ElMessage.error(msg);
  }
}
/** 生成随机密码 */
async function createPassword() {
  //batchRow.value.new_password = FooseTools.generatePassword();
}
</script>
<template>
  <div>
    <div class="flex_row mb-3">
      <div class="left">
        <el-row :gutter="10">
          <el-col :span="8">
            <el-input
              v-model="queryUserName"
              placeholder="用户名"
              clearable
              style="width: 100%"
              @keyup.enter="handleQuery"
              @clear="handleQuery"
            />
          </el-col>
          <el-col :span="8">
            <el-input
              v-model="queryNickname"
              placeholder="用户昵称"
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
          :disabled="selectedUserIds.length < 1"
          plain
          :icon="Setting"
          type="warning"
          @click="batchDialogVisible = true"
          >批量设置</el-button
        >
        <el-button :icon="CirclePlus" plain type="primary" @click="handleAdd"
          >添加用户</el-button
        >
      </div>
    </div>
    <div>{{ errorInfo }}</div>
    <div class="m-2">
      <el-table
        ref="multipleTableRef"
        :data="userList"
        row-key="id"
        stripe
        border
        style="width: 100%"
        @selection-change="handleSelectionChange"
      >
        <el-table-column
          type="selection"
          :selectable="selectable"
          width="50"
          align="center"
        />
        <el-table-column prop="id" label="ID" width="70" align="center">
          <template #default="scope">
            <el-text type="info" size="small" truncated>
              {{ scope.row.id }}
            </el-text>
          </template>
        </el-table-column>
        <el-table-column prop="username" label="登录名" sortable width="200">
          <template #default="scope">
            <el-text class="mx-1" type="primary">
              {{ scope.row.username || "--" }}
            </el-text>
          </template>
        </el-table-column>
        <el-table-column prop="nickname" label="用户昵称" sortable width="200">
          <template #default="scope">
            <el-text class="mx-1" type="info">
              {{ scope.row.nickname || "--" }}
            </el-text>
          </template>
        </el-table-column>
        <el-table-column
          prop="flag"
          label="用户状态"
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
        <el-table-column prop="email" label="邮箱" width="200" align="center">
          <template #default="scope">
            <el-text class="mx-1" type="info" truncated>
              {{ scope.row.email || "--" }}
            </el-text>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="150" align="center">
          <template #default="scope">
            <el-text class="mx-1" type="info" truncated>
              {{ scope.row.phone || "--" }}
            </el-text>
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
              title="移除用户"
              type="danger"
              class="my-button"
              plain
              :icon="Delete"
              size="small"
              @click="
                handleRemove(
                  scope.row.id,
                  scope.row.username,
                  scope.row.nickname
                )
              "
            />
          </template>
        </el-table-column>
      </el-table>
      <div class="mt-3 pagination-container">
        <el-pagination
          v-model:current-page="defautPageIndex"
          v-model:page-size="defaultPageSize"
          size="default"
          :page-sizes="[5, 10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          :total="total"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </div>
    <!-- 批量设置 -->
    <el-dialog
      v-model="batchDialogVisible"
      title="批量设置"
      width="500px"
      align-center
    >
      <div class="p-2">
        <el-form :model="batchRow" label-width="auto" width="100%">
          <el-form-item label="用户状态">
            <el-select v-model="batchRow.flag" placeholder="请选择用户状态">
              <el-option label="请选择用户状态" :value="-1" />
              <el-option label="启用" :value="0" />
              <el-option label="禁用" :value="1" />
            </el-select>
          </el-form-item>
          <el-form-item label="重置密码">
            <el-input
              v-model="batchRow.new_password"
              clearable
              placeholder="请输入新密码"
            />
          </el-form-item>
          <el-form-item label="自动生成密码">
            <el-button type="success" plain size="small" @click="createPassword"
              >生成密码</el-button
            >
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-row>
          <el-col :span="12" class="text-left">
            <el-text type="danger" class="ml-5!"
              >批量操作 {{ selectedUserIds.length }} 个用户</el-text
            >
          </el-col>
          <el-col :span="12">
            <div class="dialog-footer">
              <el-button @click="batchDialogVisible = false">取消</el-button>
              <el-button
                :disabled="selectedUserIds.length < 1"
                type="primary"
                @click="handleBatchSetConfirm"
              >
                确认设置
              </el-button>
            </div>
          </el-col>
        </el-row>
      </template>
    </el-dialog>
    <!-- 添加或编辑用户 -->
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
      <add-edit-user :user-id="userId" />
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
