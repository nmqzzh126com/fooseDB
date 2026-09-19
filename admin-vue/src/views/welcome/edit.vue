<script setup lang="ts">
import { ref, onUnmounted, onMounted, inject, computed } from 'vue'
import { useTabObjectEdit } from "@/utils/hooks";
const { initToTab, getParameter } = useTabObjectEdit();
initToTab();
import {
  CircleCheck,
  CircleClose,
  Operation
} from "@element-plus/icons-vue";
import {
  getObjectDetail,
  createObject,
  updateObject,
  testConnection,
  dbConnectionList, getDbConnectionExample,
  type MyDbType,
  type ObjectDef
} from "@/api/foosePureAdmin";
import { ElMessage, FormInstance } from 'element-plus'
import { clearAllSpace, } from './utils';
const objectId = ref<number>(Number(getParameter.object_id || 0));
// const props = defineProps({
//   objectId: {
//     type: Number,
//     default: 0
//   }
// })

const ruleFormRef = ref<FormInstance>();
const objectForm = ref<ObjectDef>({
  id: 0,
  name: "",
  description: "",
  db_type: "sqlite",
  db_url: "",
  db_path: "",
  cors_origins: "*",
  cors_methods: "GET,POST,PUT,DELETE,OPTIONS",
  auth_required: 1 as 0 | 1,
  enabled: 1 as 0 | 1,
  custom_sql_enabled: 0 as 0 | 1
});
const objectRules = {
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
  //db_url: [{ required: true, message: "请输入数据库连接串", trigger: "change" }]
};
// 是否编辑状态
const isEdit = computed(() => objectForm.value.id > 0);
//测试数据库连接状态
const testStatusIsBusy = ref(false);
const testResult = ref("");
// 允许访问的方法
const corsMethods = ref([
  {
    label: "GET",
    value: "GET"
  },
  {
    label: "POST",
    value: "POST"
  },
  {
    label: "PUT",
    value: "PUT"
  },
  {
    label: "DELETE",
    value: "DELETE"
  },
  {
    label: "OPTIONS",
    value: "OPTIONS"
  },
]);
const corsMethodsResult = ref<string[]>([]);// 允许访问的方法
//const corsOrigins = ref<string>("*");// 允许访问的域名

//保存
const saveStatusIsBusy = ref(false);
const saveResult = ref("");
onMounted(async () => {
  await loadObject();
});
onUnmounted(() => {
  //console.log("`编辑接口` 关闭弹窗");
});
async function loadObject() {
  if (objectId.value && objectId.value > 0) {
    const res: ObjectDef = await getObjectDetail(objectId.value);
    if (res && res.id > 0) {
      objectForm.value = res;
      //** 允许CORS跨域方法,字符串转换为数组,逗号分隔
      corsMethodsResult.value = objectForm.value.cors_methods.split(",");
    } else {
      ElMessage({
        type: 'error',
        message: `获取接口信息失败,ID:${objectId.value}`,
      });
    }
  }
}

//父组件中的方法
const handleEditClose = inject<(reload: boolean) => void>("handle-edit-object-close", () => { });
// 测试数据库连接
async function handleTestDbConnection() {
  testResult.value = "";
  if (testStatusIsBusy.value) {
    ElMessage({
      type: 'error',
      message: "测试中，请稍后再重试...",
    });
    return;
  }
  // 先做基本校验
  if (!objectForm.value.db_type) {
    ElMessage({
      type: 'error',
      message: "请先选择数据库类型",
    });
    return;
  }
  if (objectForm.value.db_type === "sqlite" && !objectForm.value.db_path) {
    ElMessage({
      type: 'error',
      message: "SQLite 需要填写数据库文件路径",
    });
    return;
  }
  if (objectForm.value.db_type !== "sqlite" && !objectForm.value.db_url) {
    ElMessage({
      type: 'error',
      message: "未填写数据库连接字符串",
    });
    return;
  }
  testStatusIsBusy.value = true;
  testResult.value = "正在测试连接...";
  try {
    const res = await testConnection({
      db_type: objectForm.value.db_type,
      db_url: objectForm.value.db_url || null,
      db_path: objectForm.value.db_path || null
    });
    testResult.value = res.message ?? "连接成功";
  } catch (err: any) {
    testResult.value = err?.message ?? "连接失败";
  }
  testStatusIsBusy.value = false;
}
// 保存
async function handleSubmit() {
  if (!ruleFormRef.value) return;
  if (saveStatusIsBusy.value) {
    ElMessage({
      type: 'error',
      message: "保存中，请稍后再重试...",
    });
    return;
  }
  saveResult.value = "";
  await ruleFormRef.value.validate(async (valid: boolean) => {
    if (!valid) return;
    const { ok, message, form } = validateForm(isEdit.value);// 校验表单数据
    if (!ok) {
      ElMessage({
        type: 'error',
        message: message,
      });
      return;
    };

    saveStatusIsBusy.value = true;
    saveResult.value = "正在保存...";
    try {
      if (isEdit.value) {
        const updateRes = await updateObject(objectForm.value.id!, form);
        //console.log(updateRes);
        if (updateRes && updateRes.id) {
          ElMessage({
            type: 'success',
            message: `修改接口 ${objectForm.value.name} 成功`,
          });
          handleEditClose(true);
        } else {
          ElMessage({
            type: 'error',
            message: `修改接口 ${objectForm.value.name} 失败`,
          });
        }
      } else {
        const createRes = await createObject(form);
        //console.log(createRes);
        if (createRes && createRes.id) {
          ElMessage({
            type: 'success',
            message: `新增接口 ${objectForm.value.name} 成功`,
          });
          handleEditClose(true);
        } else {
          ElMessage({
            type: 'error',
            message: `新增接口 ${objectForm.value.name} 失败`,
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
      saveStatusIsBusy.value = false;
    }
  });
}

function validateForm(isEdit: boolean): { ok: boolean, message: string, form: ObjectDef } {
  let msg = "";
  let result = true;
  const defaultMethods = "GET,POST,PUT,DELETE,OPTIONS";
  //corsMethodsResult
  const corsMethodsResultString = corsMethodsResult.value.join(",");//** 允许CORS跨域方法,数组转换为字符串,逗号分隔
  objectForm.value.name = clearAllSpace(objectForm.value.name || "");
  objectForm.value.description = clearAllSpace(objectForm.value.description || "");
  objectForm.value.db_type = objectForm.value.db_type || "sqlite"; //*** 默认 SQLite
  objectForm.value.db_url = clearAllSpace(objectForm.value.db_url || "");//** 非 SQLite 数据库连接字符串
  objectForm.value.db_path = clearAllSpace(objectForm.value.db_path || "");//** SQLite 数据库文件路径
  objectForm.value.cors_origins = clearAllSpace(objectForm.value.cors_origins || "*");//** 允许CORS跨域白名单
  objectForm.value.cors_origins = objectForm.value.cors_origins.replace(/，/g, ",");//替换中文逗号为英文逗号
  objectForm.value.cors_origins = objectForm.value.cors_origins.replace(/,+/g, ",").replace(/^,+|,+$/g, '');//前后及连续的逗号替换
  objectForm.value.cors_methods = corsMethodsResultString;//** 允许CORS跨域方法
  objectForm.value.auth_required = objectForm.value.auth_required || 0;//** 认证要求 0:匿名可访问 1:需 Bearer token
  objectForm.value.enabled = (objectForm.value.enabled === 0 ? 0 : 1) as 0 | 1;//** 项目启停
  if (!objectForm.value.name) {
    msg += "接口标识不能为空;";
    result = false;
  }
  // if (!objectForm.value.description) {
  //   msg += "接口描述不能为空;";
  //   result = false;
  // }
  if (objectForm.value.db_type === "sqlite" && objectForm.value.db_path.length === 0) {
    msg += "SQLite 需要填写数据库文件路径;";
    result = false;
  }
  if (objectForm.value.db_type !== "sqlite" && objectForm.value.db_url.length === 0) {
    msg += "未填写数据库连接字符串;";
    result = false;
  }
  if (objectForm.value.cors_origins.length === 0) {
    msg += "未填写允许CORS跨域白名单;";
    result = false;
  }
  if (objectForm.value.cors_methods.length === 0) {
    msg += "未填写允许CORS跨域方法;";
    result = false;
  }

  if (![1, 0].includes(objectForm.value.auth_required)) {
    msg += "认证要求只能选择 0 或 1;";
    result = false;
  }

  if (objectForm.value.db_type === "sqlite") {
    objectForm.value.db_url = "";
  } else {
    objectForm.value.db_path = "";
  }

  if (isEdit) {
    return {
      ok: result, message: msg, form: {
        //name: (objectForm.value.name || "").toLowerCase(),
        description: objectForm.value.description || "",
        db_type: objectForm.value.db_type || "sqlite",
        db_url: objectForm.value.db_url || "",
        db_path: objectForm.value.db_path || "",
        cors_origins: objectForm.value.cors_origins || "*",
        cors_methods: objectForm.value.cors_methods || defaultMethods,
        auth_required: objectForm.value.auth_required || 0,
        enabled: objectForm.value.enabled === 0 ? 0 : 1,
        //custom_sql_enabled: objectForm.value.custom_sql_enabled || 0 暂时不支持自定义SQL  

      } as ObjectDef
    };
  } else {
    return {
      ok: result, message: msg, form: {
        name: (objectForm.value.name || "").toLowerCase(),
        description: objectForm.value.description || "",
        db_type: objectForm.value.db_type || "sqlite",
        db_url: objectForm.value.db_url || "",
        db_path: objectForm.value.db_path || "",
        cors_origins: objectForm.value.cors_origins || "*",
        cors_methods: objectForm.value.cors_methods || defaultMethods,
        auth_required: objectForm.value.auth_required || 0,
        enabled: objectForm.value.enabled === 0 ? 0 : 1,
        //custom_sql_enabled: objectForm.value.custom_sql_enabled || 0 暂时不支持自定义SQL  
      } as ObjectDef
    };
  }
}

/* 处理数据库类型改变,填写示例连接字符串 */
function handleDbTypeChange(value: MyDbType) {
  if (value === "sqlite") {
    if (objectForm.value.db_path.length === 0) {
      objectForm.value.db_path = getDbConnectionExample(value);
    }
  } else {
    if (objectForm.value.db_url.length === 0) {
      objectForm.value.db_url = getDbConnectionExample(value);
    }
  }
}
/* 处理CORS跨域白名单改变 */
// function handleCorsOriginsChange(value: string) {
//   console.log(value);
//   if (value === "*") {
//     objectForm.value.cors_origins = value;
//   }
// }
</script>
<template>
  <div>
    <el-row class="px-3  rounded-md">
      <el-col :span="12">
        <el-text type="primary">
          {{ testResult }}
        </el-text>
      </el-col>
      <el-col :span="12">
        <div class="page-action py-3">
          <el-button type="success" plain :loading="testStatusIsBusy" :icon="Operation" @click="handleTestDbConnection">
            测试连接
          </el-button>
          <el-button type="primary" :disabled="objectForm.name == 'sqlite_demo'" :icon="CircleCheck"
            :loading="saveStatusIsBusy" @click="handleSubmit">
            {{ isEdit ? "保存" : "创建" }}
          </el-button>
        </div>
      </el-col>
    </el-row>
    <el-card class="m-2">
      <div class="rounded-md p-4">
        <el-form ref="ruleFormRef" :model="objectForm" :rules="objectRules" label-width="130px" label-position="right">
          <el-row :gutter="24">
            <el-col :span="12">
              <el-form-item label="接口标识" prop="name">
                <el-input v-model="objectForm.name" clearable maxlength="50" show-word-limit
                  placeholder="英文唯一标识，如 blog / shop / abc_123" :disabled="isEdit" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="接口状态" prop="enabled">
                <el-switch v-model="objectForm.enabled" :active-value="1" :inactive-value="0" active-text="启用（允许请求）"
                  inactive-text="禁用（拒绝所有请求）" inline-prompt
                  style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" />
              </el-form-item>
            </el-col>
            <el-col :span="24">
              <el-form-item label="接口描述" prop="description">
                <el-input v-model="objectForm.description" maxlength="200" show-word-limit clearable type="textarea"
                  :rows="2" placeholder="接口功能的简短描述" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="数据库类型" prop="db_type">
                <el-select v-model="objectForm.db_type" placeholder="请选择数据库类型" class="w-full"
                  @change="handleDbTypeChange">
                  <el-option v-for="item in dbConnectionList" :key="item.value" :label="item.label" :value="item.value"
                    :disabled="item.disabled" />
                </el-select>
              </el-form-item>
            </el-col>

            <!-- sqlite 用 db_path -->
            <el-col v-show="objectForm.db_type === 'sqlite'" :span="24">
              <el-form-item label="数据库文件路径" prop="db_path">
                <el-input v-model="objectForm.db_path" maxlength="200" show-word-limit clearable placeholder="填写绝对路径" />
              </el-form-item>
            </el-col>

            <!-- mysql/postgres 用 db_url -->
            <el-col v-show="objectForm.db_type !== 'sqlite'" :span="24">
              <el-form-item label="数据库连接字符串" prop="db_url">
                <el-input v-model="objectForm.db_url" maxlength="200" show-word-limit clearable :placeholder="objectForm.db_type === 'mysql'
                  ? 'mysql://user:pass@host:3306/dbname'
                  : 'postgres://user:pass@host:5432/dbname'
                  " />
              </el-form-item>
            </el-col>

            <el-col :span="12">
              <el-form-item label="是否需要登录认证" prop="auth_required">
                <el-switch v-model="objectForm.auth_required" :active-value="1" :inactive-value="0"
                  active-text="开启 Bearer token 鉴权(推荐)" inactive-text="允许匿名访问(不推荐)" inline-prompt
                  style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="允许请求方法">
                <div class="demo-button-style">
                  <el-checkbox-group v-model="corsMethodsResult" size="small">
                    <el-checkbox-button v-for="method in corsMethods" :key="method.value" :value="method.value">
                      {{ method.label }}
                    </el-checkbox-button>
                  </el-checkbox-group>
                </div>

              </el-form-item>
            </el-col>
            <el-col :span="24">
              <el-form-item label="CORS请求白名单" prop="cors_origins">
                <el-input v-model="objectForm.cors_origins" maxlength="500" show-word-limit clearable type="textarea"
                  :rows="3" placeholder="多个用逗号分隔，* 表示全部" />
                <el-text class="mx-1" type="primary" size="small">
                  * 时不限制,多个IP或域名用逗号分隔,例如
                  http://10.20.30.40:1234, https://www.example.com, http://www.abcd.com:8848
                </el-text>
              </el-form-item>
            </el-col>

            <el-col v-if="false" :span="12">
              <el-form-item label="启用自定义 SQL" prop="custom_sql_enabled">
                <el-switch v-model="objectForm.custom_sql_enabled" :active-value="1" :inactive-value="0" />
              </el-form-item>
            </el-col>
          </el-row>
        </el-form>
      </div>
    </el-card>
  </div>
</template>
<style lang='scss' scoped>
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}

.page-action {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
</style>