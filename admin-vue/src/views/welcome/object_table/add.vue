<script setup lang="ts">
import { ref, reactive, inject, onMounted, onUnmounted, toRaw } from 'vue'
import {
  getDataBaseInfo,
  listTableRules,
  deleteTableRule,
  updateTableRule,
  type TableRule,
  DatabaseTableInfo,
  createTableRule,
} from "@/api/foosePureAdmin";
import { ElMessage, ElMessageBox } from "element-plus";
import { clearAllSpace } from '../utils';
import { debounce } from '@pureadmin/utils';
import { Check, CircleCheck, CircleClose, Close, Refresh, Search } from '@element-plus/icons-vue';
const props = defineProps({
  objectId: {
    type: Number,
    default: 0,
  },
});
const excludeTableNames = ref<string[]>([]);//排除的表名列表
const isLoading = ref(false);
const tableList = ref<DatabaseTableInfo[]>([]);
const checkedTableList = ref<string[]>([]); // 选中的表名列表
const query = reactive({
  excludeTableNames: [],//排除的表名,为空时查询所有表,模糊查询
  tableName: "",//指定表名,为空时查询所有表,模糊查询
});
onMounted(async () => {
  //加载已存在的表信息,并初始化排除表名列表
  await loadExistTables();
  await loadTableList();
});

// 防抖加载列表，300ms 内只执行一次,第一次立即执行
const debounceLoadList = debounce(
  async () => {
    await loadTableList();
  },
  300,
  true
);
// 加载已存在的表信息
const loadExistTables = async () => {
  //console.log("加载分页列表");
  isLoading.value = true;
  const params = {
    page: 1,
    page_size: 500,
  };
  try {
    const res = await listTableRules(props.objectId, {
      page: params.page,
      pageSize: params.page_size
    });
    //初始化排除表名列表
    if (res && res.items) {
      excludeTableNames.value = res.items?.map((item) => item.table_name) || [];
    } else {
      excludeTableNames.value = [];
    }
  } catch (e) {
    console.error("加载失败:", e instanceof Error ? e.message : e);
  } finally {
    isLoading.value = false;
  }
};

async function loadTableList() {
  if (!props.objectId || props.objectId === 0) {
    ElMessage.error("接口id为空");
    return;
  }
  isLoading.value = true;
  //清除排除表名中的空格
  if (query.excludeTableNames.length > 0) {
    query.excludeTableNames = query.excludeTableNames.map((item) => clearAllSpace(item));
  }
  if (query.tableName.length > 0) {
    query.tableName = clearAllSpace(query.tableName);
  }
  //console.log(toRaw(query.excludeTableNames), toRaw(query.tableName));
  //获取指定接口下的所有表信息
  const list = await getDataBaseInfo(props.objectId, [], query.tableName);
  tableList.value = [];
  for (const item of list || []) {
    if (!excludeTableNames.value.includes(item.name)) {
      tableList.value.push(item);
    }
  }

  if (!tableList.value || tableList.value.length === 0) {
    ElMessage.error("接口下没有表");
    isLoading.value = false;
    return;
  }
  isLoading.value = false;
  ElMessage.success(`找到 ${tableList.value.length} 张表`);
  //console.log(tableList.value);
}
/** 重置查询 */
async function handleResetQuery() {
  query.tableName = "";
  debounceLoadList();
}

onUnmounted(() => {
  //console.log("添加表卸载");
});

/** 全选 */
async function handleCheckAll() {
  if (tableList.value.length > 0) {
    checkedTableList.value = tableList.value.map((item) => item.name);
  } else {
    checkedTableList.value = [];
  }
}
/** 反选 */
async function handleUncheckAll() {
  if (tableList.value.length > 0) {
    if (checkedTableList.value.length > 0) {
      const currentCheckedTableNames = [...checkedTableList.value];//复制当前选中的表名
      const newNames = tableList.value.filter((item) => !currentCheckedTableNames.includes(item.name));
      checkedTableList.value = newNames.map((item) => item.name);
    } else {
      checkedTableList.value = tableList.value.map((item) => item.name);
    }
  } else {
    checkedTableList.value = [];
  }
}
/** 添加表 */
async function handleAddTables() {
  //console.log(checkedTableList.value);
  if (checkedTableList.value.length <= 0) {
    ElMessage.error("请先选择表");
    return;
  }
  //确认添加
  const confirmAdd = await confirm(`确认添加 ${checkedTableList.value.length} 张表吗？`);
  if (!confirmAdd) {
    ElMessage.info("添加已取消");
    return;
  }
  //添加表
  for (const tableName of checkedTableList.value) {
    const result: TableRule = await createTableRule({
      object_id: props.objectId,
      table_name: tableName.trim(),
      blocked: 0,
      allow_select: 1,
      allow_insert: 1,
      allow_update: 1,
      allow_delete: 1,
      allow_batch_insert: 1,
      allow_batch_update: 1,
      allow_batch_delete: 1,
    });
    if (result && result.id) {
      ElMessage.success(`添加 ${tableName} 成功`);
    } else {
      ElMessage.error(`添加 ${tableName} 失败`);
    }
  }
  handleAddTableClose(true);
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
const handleAddTableClose = inject<(reload: boolean) => void>("handle-add-table-close", () => { });
</script>
<template>
  <div>
    <div class="flex_row mb-3">
      <div class="left">
        <el-row :gutter="8">
          <el-col :span="24">
            <el-input v-model="query.tableName" placeholder="按数据表名称查询" clearable style="width: 100%"
              @keyup.enter="debounceLoadList" @clear="debounceLoadList" />
          </el-col>
        </el-row>
      </div>
      <div class="right">
        <el-button type="primary" plain :loading="isLoading" :icon="Search" @click="debounceLoadList">查询</el-button>
        <el-button :icon="Refresh" plain type="info" @click="handleResetQuery">重置</el-button>
      </div>
    </div>
    <div class="rounded-md p-3" style="background-color: #eee;">
      <el-scrollbar height="200px">
        <el-checkbox-group v-model="checkedTableList">
          <el-checkbox v-for="item in tableList" :key="item.name" :label="item.name" :value="item.name" size="large">{{
            item.name
          }}</el-checkbox>
        </el-checkbox-group>
      </el-scrollbar>
    </div>
    <div>
      <el-row class="mt-5">
        <el-col :span="16">
          <el-button-group direction="horizontal" :disabled="tableList.length <= 0">
            <el-button type="success" plain round size="small" :icon="Check" @click="handleCheckAll">全选</el-button>
            <el-button type="success" plain round size="small" :icon="Close" @click="handleUncheckAll">反选</el-button>
          </el-button-group>
          <el-text class="mx-1 ml-3!" type="danger">
            已选 {{ checkedTableList.length }} 张表
          </el-text>
        </el-col>
        <el-col :span="8">
          <div class="dialog-footer">
            <el-button :icon="CircleClose" @click="handleAddTableClose(false)">取消</el-button>
            <el-button type="primary" :disabled="checkedTableList.length <= 0" :icon="CircleCheck"
              @click="handleAddTables">
              确认添加
            </el-button>
          </div>
        </el-col>
      </el-row>
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