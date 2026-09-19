<script setup lang="ts">
defineOptions({
  name: "OjectRoles"
});
import { ref, defineAsyncComponent, onMounted, computed, provide } from 'vue'
import { useTabRole } from "@/utils/hooks";
const { initToTab, getParameter } = useTabRole();
initToTab();
//const object_id = ref(Number(getParameter.object_id));
//const object_name = ref(getParameter.object_name || "");
import { Search, Refresh, CirclePlus, Setting, Remove, EditPen, Delete } from "@element-plus/icons-vue";
import { debounce } from "@pureadmin/utils";
import { TableInstance, ElMessage, ElMessageBox } from "element-plus";
import {
  listRoles,
  getRole,
  updateRole,
  createRole,
  deleteRole,
  listRoleUsers,
  bindRoleUser,
  unbindRoleUser,
  batchSetUserRoles,
  type Role
} from "@/api/foosePureAdmin";
import { clearAllSpace, generatePassword, validatePassword } from '../utils';

const AddEditRole = defineAsyncComponent(async () => {
  return import("@/views/welcome/roles/edit.vue");
});

const queryRoleName = ref("");// 查询角色名
const isLoading = ref(false);// 是否加载中
const roleList = ref<Role[]>([]);
//const multipleTableRef = ref<TableInstance>()

// 添加或编辑角色
const addEditDialogVisible = ref(false);// 添加或编辑角色弹窗是否显示
const roleId = ref(0);// 当前角色ID
const dialogTitle = computed(() => roleId.value > 0 ? "编辑角色" : "添加角色");// // 弹窗标题

onMounted(async () => {
  debounceLoadList(); // 初始化加载列表
});

// 防抖加载列表，300ms 内只执行一次,第一次立即执行
const debounceLoadList = debounce(
  async () => {
    await loadList();
  },
  300,
  true
);

// 加载分页列表
const loadList = async () => {
  //console.log("加载分页列表");
  queryRoleName.value = clearAllSpace(queryRoleName.value);
  const query = {
    // role_name: queryRoleName.value,
    // mode: "exact",
  };
  if (queryRoleName.value && queryRoleName.value.trim() !== "") {
    query["role_name"] = queryRoleName.value;
  }
  isLoading.value = true;
  try {
    const res = await listRoles(query);
    roleList.value = res || [];
    //console.log(res);
  } catch (e) {
    console.error("加载失败:", e instanceof Error ? e.message : e);
  } finally {
    isLoading.value = false;
  }
};

/** 重置查询 */
async function handleResetQuery() {
  queryRoleName.value = "";
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
  const { ok } = await deleteRole(rowId);
  if (!ok) {
    ElMessage.error("删除失败");
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

  const res: Role = await updateRole(rowId, { flag: flag as 0 | 1 });
  if (!res || !res.id) {
    ElMessage.error("设置失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`设置成功`);
}

</script>
<template>
  <div>
    <div class="flex_row mb-3">
      <div class="left">
        <el-row :gutter="8">
          <el-col :span="24">
            <el-input v-model="queryRoleName" placeholder="角色名" clearable style="width: 100%"
              @keyup.enter="debounceLoadList" @clear="debounceLoadList" />
          </el-col>
        </el-row>
      </div>
      <div class="right">
        <el-button type="primary" :loading="isLoading" :icon="Search" @click="debounceLoadList">查询</el-button>
        <el-button :icon="Refresh" type="info" @click="handleResetQuery">重置</el-button>
        <el-button class="ml-5!" :icon="CirclePlus" plain type="primary" @click="handleAdd">添加角色</el-button>
      </div>
    </div>

    <div class="m-2">
      <el-table ref="multipleTableRef" :data="roleList" row-key="id" stripe border style="width: 100%">
        <el-table-column prop="id" label="ID" width="100" align="center">
          <template #default="scope">
            <el-text type="info" size="small" truncated>
              {{ scope.row.id }}
            </el-text>
          </template>
        </el-table-column>
        <el-table-column prop="role_name" label="角色名" sortable min-width="200">
          <template #default="scope">
            <el-text class="mx-1" type="primary">
              {{ scope.row.role_name || "--" }}
            </el-text>
          </template>
        </el-table-column>

        <el-table-column prop="flag" label="角色状态" width="100" align="center">
          <template #default="scope">
            <el-tag class="mx-1" :type="scope.row.flag === 0 ? 'success' : 'danger'">
              {{ scope.row.flag === 0 ? "已启用" : "已禁用" }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column fixed="right" label="操作" width="200" align="center">
          <template #default="scope">
            <el-button type="primary" class="my-button" plain :icon="EditPen" size="small"
              @click="handleEdit(scope.row.id)">
              编辑
            </el-button>
            <el-button :type="scope.row.flag === 0 ? 'warning' : 'success'" class="my-button" plain :icon="Remove"
              size="small" @click="handleSetFlag(scope.row.id, scope.row.flag)">
              {{ scope.row.flag === 0 ? "禁用" : "启用" }}
            </el-button>
            <el-button :disabled="scope.row.id === 1" title="移除角色" type="danger" class="my-button" plain :icon="Delete"
              size="small" @click="handleRemove(scope.row.id, scope.row.role_name)" />
          </template>
        </el-table-column>
      </el-table>
    </div>
    <!-- 添加或编辑角色 -->
    <el-dialog v-model="addEditDialogVisible" :title="dialogTitle" width="70vw" align-center
      :close-on-press-escape="false" :close-on-click-modal="false" destroy-on-close draggable :show-close="false"
      :modal-penetrable="false">
      <add-edit-role :role-id="roleId" />
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