<script setup lang="ts">
import { ref, inject, onMounted, onUnmounted, computed } from 'vue'
import {
  listRoles,
  updateRole,
  createRole,
  deleteRole,
  listRoleUsers,
  bindRoleUser,
  unbindRoleUser,
  batchSetUserRoles,
  type Role,
  getRole
} from "@/api/foosePureAdmin";
import { clearAllSpace } from '../utils';
import { ElMessage, ElMessageBox, FormInstance } from "element-plus";
import { CircleCheck, CircleClose } from '@element-plus/icons-vue';

const props = defineProps({
  roleId: {
    type: Number,
    default: 0,
  }
});
const ruleFormRef = ref<FormInstance>();
const isBusy = ref(false);
const isEdit = ref(false);
const saveResult = ref("");

const roleForm = ref<Role>({
  id: 0,
  role_name: "",
  flag: 0,
} as Role);
const roleRules = computed(() => ({
  role_name: [
    { required: true, message: "请输入角色名", trigger: "blur" },
    { min: 2, max: 50, message: "长度在 2 到 50 个字符", trigger: "blur" },
  ],
  flag: [
    { required: true, message: "请选择状态", trigger: "change" },
  ],
}));
//-----
onMounted(async () => {
  isEdit.value = false;
  //编辑角色
  if (props.roleId && props.roleId > 0) {
    isEdit.value = true;
    const res = await getRole(props.roleId);
    //console.log("获取角色详情", res);
    if (res && res.id) {
      roleForm.value = res || {} as Role;
    }
    else {
      ElMessage.error("角色不存在");
      handleAddEditRoleClose(true);
      return;
    }
  }
});


onUnmounted(() => {
  //console.log("添加编辑角色卸载");
});
/** 新增/修改角色 */
async function handleAddEditRole() {
  if (!ruleFormRef.value) return;
  if (isBusy.value) {
    ElMessage({
      type: 'error',
      message: "保存中，请稍后再重试...",
    });
    return;
  }
  saveResult.value = "";
  await ruleFormRef.value.validate(async (valid: boolean) => {
    if (!valid) return;
    const { ok, message, form } = await validateForm(isEdit.value);// 校验表单数据
    if (!ok) {
      ElMessage({
        type: 'error',
        message: message,
      });
      return;
    };

    isBusy.value = true;
    saveResult.value = "正在保存...";
    try {
      if (isEdit.value) {
        //console.log("修改角色", form);
        const updateRes = await updateRole(form.id!, form);
        //console.log("edit result:", updateRes);
        if (updateRes && updateRes.id) {
          ElMessage({
            type: 'success',
            message: `修改角色 ${form.role_name} 成功`,
          });
          handleAddEditRoleClose(true);
        } else {
          ElMessage({
            type: 'error',
            message: `修改角色 ${form.role_name} 失败`,
          });
        }
      } else {
        //console.log("新增角色", form);
        const createRes = await createRole(form);
        //console.log("create result:", createRes);
        if (createRes && createRes.id) {
          ElMessage({
            type: 'success',
            message: `新增角色 ${form.role_name} 成功`,
          });
          handleAddEditRoleClose(true);
        } else {
          ElMessage({
            type: 'error',
            message: `新增角色 ${form.role_name} 失败`,
          });
        }
      }
    } catch (err: any) {
      saveResult.value = "操作失败";
      ElMessage({
        type: 'error',
        message: err?.message ?? "操作失败",
      });
    } finally {
      isBusy.value = false;
    }
  });
}

async function validateForm(isEdit: boolean): Promise<{ ok: boolean, message: string, form: Role }> {
  let msg = "";
  let result = true;

  roleForm.value.role_name = clearAllSpace(roleForm.value.role_name || "");
  roleForm.value.flag = Number(roleForm.value.flag || 0);

  if (!roleForm.value.role_name || roleForm.value.role_name.length === 0) {
    msg += "角色名不能为空;";
    result = false;
  }
  if (![0, 1].includes(roleForm.value.flag)) {
    msg += "角色状态只能为 0 或 1;";
    result = false;
  }
  // 校验角色名是否已存在,exact模式为精确匹配,包含模式为包含匹配
  const res = await listRoles({ role_name: roleForm.value.role_name, mode: "exact" });
  if(!isEdit){
    //新增角色时,角色名不能存在
    if (res && res.length > 0) {
      msg += "角色名已存在;";
      result = false;
    }
  } else {
    //修改角色时
    if (res && res.length > 0) {
      for(let i = 0; i < res.length; i++){
        if(res[i].id !== roleForm.value.id){
          msg += "角色名已存在;";
          result = false;
          break;
        }
      }      
    }
  }

  const updateForm = {
    ...roleForm.value,
  };
  if (!isEdit) {
    delete updateForm.id;// 新增角色时不处理id
  }
  return {
    ok: result, message: msg, form: {
      ...updateForm,
    } as Role
  };
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
//父组件中的方法
const handleAddEditRoleClose = inject<(reload: boolean) => void>("handle-add-edit-role-close", () => { });
</script>
<template>
  <div>
    <div>
      <el-form ref="ruleFormRef" :model="roleForm" :rules="roleRules" label-width="150px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="角色名" prop="role_name">
              <el-input v-model="roleForm.role_name" maxlength="50" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="角色状态" prop="flag">
              <el-switch v-model="roleForm.flag" inline-prompt
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="0"
                :inactive-value="1" active-text="启用" inactive-text="禁用" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
    </div>
    <div class="dialog-footer">
      <el-button :icon="CircleClose" @click="handleAddEditRoleClose(false)">取消</el-button>
      <el-button type="primary" :icon="CircleCheck" @click="handleAddEditRole">
        {{ props.roleId > 0 ? "保存" : "添加" }}
      </el-button>
    </div>
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
  width: 200px;
  text-align: left;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
</style>