<script setup lang="ts">
import { ref, inject, onMounted, onUnmounted, computed } from 'vue'
import {
  getUserDetail,
  createUser,
  updateUser,
  type BusinessUser,
  listRoleUsers,
  RoleUserBinding,
  listRoleUsersByIds,
  listRoles,
  batchSetUserRoles,
} from "@/api/foosePureAdmin";
import { clearAllSpace, PASSWORD_MAX, PASSWORD_MIN, validatePassword } from '../utils';
import { ElMessage, ElMessageBox, FormInstance } from "element-plus";
import { CircleCheck, CircleClose } from '@element-plus/icons-vue';

const props = defineProps({
  userId: {
    type: Number,
    default: 0,
  },
  objectId: {
    type: Number,
    default: 0,
  },
});
const ruleFormRef = ref<FormInstance>();
const isBusy = ref(false);
const isEdit = ref(false);
const saveResult = ref("");
const selectedRoles = ref<number[]>([]);
type RoleItem = {
  value: number;
  label: string;
}
const roleOptions = ref<RoleItem[]>([
  // { value: 1, label: "管理员" },
  // { value: 2, label: "普通用户" },
  // { value: 3, label: "测试用户" },
]);
const userForm = ref<BusinessUser>({
  id: 0,
  object_id: props.objectId,
  username: "",
  nickname: "",
  password: "",
  extended: "",
  avatar: "",
  permissions: "",
  roles: [],
  email: "",
  phone: "",
  flag: 0,
  //create_at: 0,
} as BusinessUser);
const userRules = computed(() => ({
  username: [
    { required: true, message: "请输入用户名", trigger: "blur" },
    { min: 4, max: 50, message: "长度在 4 到 50 个字符", trigger: "blur" },
    {
      pattern: /^[a-zA-Z0-9_-]+$/,
      message: "只能包含字母、数字、下划线和连字符",
      trigger: "blur"
    }
  ],
  nickname: [
    { required: true, message: "请输入用户昵称", trigger: "blur" },
    { min: 2, max: 50, message: "长度在 2 到 50 个字符", trigger: "blur" },
  ],
  password: [
    {
      // 自定义 validator：添加模式必填；编辑模式非必填但输入后必须合规
      validator: (_rule: any, value: string, cb: any) => {
        const v = value?.trim() ?? "";
        if (!isEdit.value && v.length === 0) {
          // 添加模式 — 必填
          return cb(new Error("请输入密码"));
        }
        if (v.length === 0) {
          // 编辑模式 — 空则跳过
          return cb();
        }
        // 有值就按规则校验
        if (v.length < PASSWORD_MIN || v.length > PASSWORD_MAX) {
          return cb(new Error(`长度在 ${PASSWORD_MIN} 到 ${PASSWORD_MAX} 个字符`));
        }
        const r = validatePassword(v);
        if (!r.valid) return cb(new Error(r.message));
        cb();
      },
      trigger: "blur"
    }
  ],
  email: [
    { min: 5, max: 50, message: "长度在 5 到 50 个字符", trigger: "blur" },
    {
      pattern: /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z0-9]{2,6}$/,
      message: "请输入正确的邮箱格式",
      trigger: "blur"
    }
  ],
  phone: [
    { min: 11, max: 11, message: "长度在 11 个字符", trigger: "blur" },
    {
      pattern: /^1[3456789]\d{9}$/,
      message: "请输入正确的手机号格式",
      trigger: "blur"
    }
  ],
  flag: [
    { required: true, message: "请选择状态", trigger: "change" },
  ],
}));
//-----
onMounted(async () => {
  if (!props.objectId || props.objectId <= 0) {
    ElMessage.error("接口id为空");
    return;
  }
  //获取角色列表, 已禁用的,通过标题区别
  const roles = await listRoles({});
  if (roles && roles.length > 0) {
    for (const item of roles) {
      if (item.flag === 0) {
        roleOptions.value.push({ value: Number(item.id), label: item.role_name || "--" });
      } else {
        roleOptions.value.push({ value: Number(item.id), label: `[已禁用]${item.role_name || "--"}` });
      }
    }
  }
  isEdit.value = false;
  //编辑用户
  if (props.userId && props.userId > 0) {
    isEdit.value = true;
    const res = await getUserDetail(props.userId);
    //console.log("获取用户详情", res);
    if (res && res.id) {
      userForm.value = res || {} as BusinessUser;
      // getUserDetail 已从 role_user + roles JOIN 返回 roles: Role[]
      selectedRoles.value = (res.roles ?? []).map(r => r.id);
    }
    else {
      ElMessage.error("用户不存在");
      handleAddEditUserClose(true);
      return;
    }
  }
});


onUnmounted(() => {
  //console.log("添加编辑用户卸载");
});
/** 新增/修改用户 */
async function handleAddEditUser() {
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
      // roles 已剥离到 role_user + roles 表，不传进 createUser/updateUser
      delete (form as any).roles;

      if (isEdit.value) {
        const updateRes = await updateUser(form.id!, form);
        if (updateRes && updateRes.id) {
          // 同步角色绑定
          await batchSetUserRoles({ user_id: updateRes.id, role_ids: selectedRoles.value });
          ElMessage({
            type: 'success',
            message: `修改用户成功`,
          });
          handleAddEditUserClose(true);
        } else {
          ElMessage({
            type: 'error',
            message: `修改用户失败`,
          });
        }
      } else {
        const createRes = await createUser(form);
        if (createRes && createRes.id) {
          // 同步角色绑定
          await batchSetUserRoles({ user_id: createRes.id, role_ids: selectedRoles.value });
          ElMessage({
            type: 'success',
            message: `新增用户成功`,
          });
          handleAddEditUserClose(true);
        } else {
          ElMessage({
            type: 'error',
            message: `新增用户失败`,
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

async function validateForm(isEdit: boolean): Promise<{ ok: boolean, message: string, form: BusinessUser }> {
  let msg = "";
  let result = true;
  // 校验用户角色
  // if (!selectedRoles.value || selectedRoles.value.length === 0) {
  //   msg += "请选择用户角色;";
  //   result = false;
  // }

  userForm.value.object_id = Number(props.objectId);
  userForm.value.username = clearAllSpace(userForm.value.username || "");
  userForm.value.nickname = clearAllSpace(userForm.value.nickname || "");
  userForm.value.password = clearAllSpace(userForm.value.password || "");
  userForm.value.extended = clearAllSpace(userForm.value.extended);
  userForm.value.avatar = clearAllSpace(userForm.value.avatar || "");
  userForm.value.permissions = clearAllSpace(userForm.value.permissions || "");
  //userForm.value.roles = clearAllSpace(roleStr || "");
  userForm.value.email = clearAllSpace(userForm.value.email || "");
  userForm.value.phone = clearAllSpace(userForm.value.phone || "");
  userForm.value.flag = Number(userForm.value.flag || 0);

  if (!userForm.value.username || userForm.value.username.length === 0) {
    msg += "用户名不能为空;";
    result = false;
  }
  if (!userForm.value.nickname || userForm.value.nickname.length === 0) {
    msg += "昵称不能为空;";
    result = false;
  }
  if (![0, 1].includes(userForm.value.flag)) {
    msg += "用户状态只能为 0 或 1;";
    result = false;
  }
  const updateForm = {
    ...userForm.value,
  };
  //添加用户时，密码不能为空，编辑用户时，密码可以为空
  if (!isEdit) {
    if (!userForm.value.password || userForm.value.password.length === 0) {
      msg += "密码不能为空;";
      result = false;
    }
    // 添加用户时校验密码
    const passwordValidateResult = validatePassword(userForm.value.password);
    if (!passwordValidateResult.valid) {
      msg += passwordValidateResult.message;
      result = false;
    }
    delete updateForm.id;// 新增用户时不处理id
  } else {
    //编辑用户时，密码可以为空,不空时为修改密码
    if (userForm.value.password && userForm.value.password.length > 0) {
      // 编辑用户时校验密码
      const passwordValidateResult = validatePassword(userForm.value.password);
      if (!passwordValidateResult.valid) {
        msg += passwordValidateResult.message;
        result = false;
      }
    } else {
      delete updateForm.password;// 无密码时不处理密码
    }
    delete updateForm.username;// 编辑用户时不处理用户名
  }
  //验证通过后，设置用户角色
  if (result) {
    const res = await batchSetUserRoles({
      user_id: props.userId, role_ids: selectedRoles.value.map((id) => Number(id))
    });
    if (!res || !res.ok) {
      ElMessage.error("设置用户角色失败");
      result = false;
    }
  }

  return {
    ok: result, message: msg, form: {
      ...updateForm,
    } as BusinessUser
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
const handleAddEditUserClose = inject<(reload: boolean) => void>("handle-add-edit-user-close", () => { });
</script>
<template>
  <div>
    <div>
      <el-form ref="ruleFormRef" :model="userForm" :rules="userRules" label-width="150px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="登录名" prop="username">
              <el-input v-model="userForm.username" :disabled="isEdit" maxlength="50" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="用户昵称" prop="nickname">
              <el-input v-model="userForm.nickname" maxlength="30" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="密码" prop="password">
              <el-input v-model="userForm.password" maxlength="30" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="用户状态" prop="flag">
              <el-switch v-model="userForm.flag" inline-prompt
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" :active-value="0"
                :inactive-value="1" active-text="启用" inactive-text="禁用" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="手机号" prop="phone">
              <el-input v-model="userForm.phone" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="邮箱" prop="email">
              <el-input v-model="userForm.email" type="email" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="用户角色" prop="roles">
              <el-select v-model="selectedRoles" multiple placeholder="请选择用户角色">
                <el-option v-for="item in roleOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="自定义权限" prop="permissions">
              <el-input v-model="userForm.permissions" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="头像(Base64编码)" prop="avatar">
              <el-input v-model="userForm.avatar" type="textarea" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="扩展信息(JSON格式)" prop="extended">
              <el-input v-model="userForm.extended" type="textarea" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
    </div>
    <div class="dialog-footer">
      <el-button :icon="CircleClose" @click="handleAddEditUserClose(false)">取消</el-button>
      <el-button type="primary" :icon="CircleCheck" @click="handleAddEditUser">
        {{ props.userId > 0 ? "保存" : "添加" }}
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