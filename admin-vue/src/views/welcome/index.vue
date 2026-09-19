<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { message } from "@/utils/message";
import { useTabObjectUser, useTabObjectTable, useTabObjectEdit, useTabRole } from "@/utils/hooks";
const { toTab: toTabUser } = useTabObjectUser();
const { toTab: toTabTable } = useTabObjectTable();
const { toTab: toTabEdit } = useTabObjectEdit();
const { toTab: toTabRole } = useTabRole();

import {
  Coin,
  Delete,
  Plus,
  Setting,
  Connection,
  User,
  VideoPlay,
  VideoPause,
  DocumentCopy,
  Postcard,
  Operation,
  CaretRight,
  SwitchButton,
  Menu
} from "@element-plus/icons-vue";
import {
  type ObjectDef,
  listObjects,
  deleteObject,
  countUsersByObject,
  countTableRules
} from "@/api/foosePureAdmin";
import { ElMessage, ElMessageBox } from "element-plus";
defineOptions({
  name: "Welcome"
});
const objectList = ref<ObjectDef[]>([]);// 接口列表
const dialogEditVisible = ref<boolean>(false);//编辑弹窗是否显示
const objectId = ref(0);//接口id 

onMounted(async () => {
  await loadObjects();
});
/** 加载接口列表 */
async function loadObjects() {
  const list = await listObjects();
  if (list && list.length > 0) {
    for (const item of list) {
      item._user_count = await countUsersByObject(item.id);
      item._table_count = await countTableRules(item.id);
      //console.log(item._user_count, item._table_count);
    }
  }
  objectList.value = list;
}
async function handleCreate() {
  objectId.value = 0;
  dialogEditVisible.value = true;
}
async function handleEdit(row: ObjectDef) {
  toTabEdit({ object_id: row.id || 0, object_name: row.name || "" });
  // console.log(row);
  // if (dialogEditVisible.value) return;
  // objectId.value = row.id;
  // dialogEditVisible.value = true;
}
/** 删除单条 */
async function handleDelete(row: ObjectDef) {
  await ElMessageBox.confirm(
    `确认删除接口 ${row.name} 吗？`,
    '请确认',
    {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning',
    }
  )
    .then(async () => {
      try {
        await deleteObject(row.id);
        ElMessage({
          type: 'success',
          message: `删除接口 ${row.name} 成功`,
        });
        await loadObjects();
      } catch (err: any) {
        message(err?.message ?? "删除失败", { type: "error" });
      }
    })
    .catch(() => {
      ElMessage({
        type: 'info',
        message: '取消删除',
      })
    })
}
/** 配置用户 */
async function handleUser(row: ObjectDef) {
  toTabUser({ object_id: row.id || 0, object_name: row.name || "" });
}
/** 配置数据表 */
async function handleTable(row: ObjectDef) {
  toTabTable({ object_id: row.id || 0, object_name: row.name || "" });
}
/** 配置角色 */
async function handleRole(row: ObjectDef) {
  toTabRole({ object_id: row.id || 0, object_name: row.name || "" });
}



/** 处理下拉菜单命令 */
async function handleCommand(row: ObjectDef, command: string) {
  //console.log(command, row);
  if (command === 'edit') {
    handleEdit(row);
  } else if (command === 'user') {
    handleUser(row);
  } else if (command === 'role') {
    handleRole(row);
  } else if (command === 'table') {
    handleTable(row);
  } else if (command === 'delete') {
    handleDelete(row);
  }
}



</script>

<template>
  <div class="p-2">
    <el-row :gutter="15">
      <el-col v-for="item in objectList" :key="item.id" :span="12" class="mb-2" @dblclick="handleEdit(item)">
        <el-card>
          <template #header>
            <div :title="'接口ID:' + item.id">
              <el-row>
                <el-col :span="16">
                  <el-text :type="item.enabled === 1 ? 'primary' : 'danger'" truncated class="ml-2!">
                    {{ item.name }}
                  </el-text>
                </el-col>
                <el-col :span="8" class="text-right">
                  <el-button v-if="item.enabled === 1" type="success" size="small" plain :icon="CaretRight">
                    运行中
                  </el-button>
                  <el-button v-else type="danger" size="small" plain :icon="SwitchButton">
                    已停止
                  </el-button>
                  <el-dropdown placement="bottom" class="mt-0.5" @command="handleCommand(item, $event)">
                    <el-button size="small" type="primary" class="my-button" plain :icon="Operation" />
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="edit" :icon="Setting">编辑接口</el-dropdown-item>
                        <el-dropdown-item command="user" :icon="User"> 用户配置</el-dropdown-item>
                        <el-dropdown-item command="role" :icon="Menu"> 角色配置</el-dropdown-item>
                        <el-dropdown-item command="table" :icon="DocumentCopy">数据表配置</el-dropdown-item>
                        <el-dropdown-item :disabled="item.name == 'sqlite_demo'" divided command="delete"
                          :icon="Delete">删除接口</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </el-col>
              </el-row>
            </div>
          </template>
          <div>
            <el-scrollbar height="125px">
              <div v-if="item.description">
                <el-text class="mx-1" type="info" truncated>
                  {{ item.description }}
                </el-text>
              </div>
              <div>
                <el-text class="mx-1" type="success">
                  <el-icon>
                    <Postcard />
                  </el-icon>
                  认证要求：{{ item.auth_required === 0 ? "匿名可访问" : "需 Bearer token" }}
                </el-text>
                <el-text class="mx-1 ml-2!" type="info">
                  <el-icon>
                    <User />
                  </el-icon>
                  用户：{{ item._user_count || 0 }}
                </el-text>
                <el-text class="mx-1 ml-2!" type="info">
                  <el-icon>
                    <DocumentCopy />
                  </el-icon>
                  数据表：{{ item._table_count || 0 }}
                </el-text>
              </div>
              <div>
                <el-text class="mx-1" type="primary">
                  <el-icon>
                    <Connection />
                  </el-icon>
                  CORS方法：{{ item.cors_methods }}
                </el-text>
              </div>
              <div>
                <el-text class="mx-1" type="danger">
                  <el-icon>
                    <Connection />
                  </el-icon>
                  CORS白名单：
                  <el-tag v-for="origin in item.cors_origins.split(',')" :key="origin" class="mx-1" type="warning">
                    {{ origin }}
                  </el-tag>
                </el-text>
              </div>
            </el-scrollbar>
          </div>
          <template #footer>
            <el-text v-if="item.db_url" truncated>
              <el-icon>
                <Coin />
              </el-icon>
              <span class="db-type">{{ item.db_type }}</span>
              {{ item.db_url }}
            </el-text>
            <el-text v-if="item.db_path" truncated>
              <el-icon>
                <Coin />
              </el-icon>
              <span class="db-type">{{ item.db_type }}</span>
              {{ item.db_path }}
            </el-text>
            <el-text v-if="!item.db_path && !item.db_url" type="warning" truncated>
              <el-icon>
                <Coin />
              </el-icon>
              未配置数据库
            </el-text>
          </template>
        </el-card>
      </el-col>
      <el-col :span="12" class="pt-5">
        <el-button type="primary" class="ml-2!" :icon="Plus" plain @click="handleCreate">创建新接口</el-button>
      </el-col>
    </el-row>
  </div>
</template>

<style lang="scss" scoped>
.db-type {
  font-weight: bold;
  color: #e6a23c;
  margin-left: 5px;
  margin-right: 5px;
}

:deep(.el-card__header) {
  padding: 12px 12px;
}

:deep(.el-card__body) {
  padding: 10px 20px;
}

:deep(.el-card__footer) {
  padding: 5px 10px;
}

.my-button {
  padding-left: 6px;
  padding-right: 6px;
  margin-left: 6px;
}
</style>
