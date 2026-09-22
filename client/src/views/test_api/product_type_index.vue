<script setup lang="ts">
import { defineAsyncComponent, onMounted, provide, ref, reactive } from "vue";
import {
  Edit,
  Search,
  Refresh,
  CirclePlus,
  Delete
} from "@element-plus/icons-vue";
import { debounce } from "@pureadmin/utils";
import { FooseListParams } from "@/api/foose_db";
import { ElMessage } from "element-plus";
import { ProductTypeRow, useProductType } from "@/api/demo/product_type_api";

const productType = reactive(useProductType());

const editProductType = defineAsyncComponent(async () => {
  return import("@/views/test_api/edit_type.vue");
});
defineOptions({
  name: "TestApiProductTypeIndex"
});
const defautPageIndex = ref(1); // 当前页码
const defaultPageSize = ref(10); // 每页大小
const queryProductName = ref(""); // 查询产品名称

// 编辑弹窗
provide("handle-edit-type-close", handleEditTypeClose);
const dialogEditVisible = ref(false);
const currentId = ref(0);
//---

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
  const filter: any = {}; // 有输入 → 模糊匹配（自动补 % 前后缀）
  if (queryProductName.value?.trim()) {
    filter["type_name[_like]"] = `%${queryProductName.value.trim()}%`;
  }

  // —— 构建查询参数（Directus 风格 filter）——
  const params: FooseListParams = {
    showSql: true, //是否显示SQL语句
    page: defautPageIndex.value,
    pageSize: defaultPageSize.value,
    //noPage: true,
    // 排序
    orderBy: "id:desc",
    filter: filter
  };

  try {
    const res = await productType.getPageList(params);
    //console.log(res);
    //console.log(res.sql, res.sqlParams);
    //console.log(productType.page, productType.pageSize, productType.total);
  } catch (e) {
    console.error("加载失败:", e instanceof Error ? e.message : e);
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
  queryProductName.value = "";
  debounceLoadList();
}
/**编辑 */
async function handleEdit(rowId: number) {
  currentId.value = rowId;
  dialogEditVisible.value = true;
}
//子组件调用这个方法
async function handleEditTypeClose(reload: boolean) {
  //console.log("handleEditTypeClose");
  dialogEditVisible.value = false;
  if (reload) {
    debounceLoadList();
  }
}

/** 添加 */
async function handleAdd() {
  const newRow: any = {
    type_name: "新产品类型",
    flag: 0
  };
  const res = await productType.create(newRow);
  if (!res) {
    ElMessage.error("添加失败");
    return;
  }
  ElMessage.success("添加成功");
  debounceLoadList();
}

/** 删除 */
// async function handleRemove(rowId: number) {
//   //console.log("删除", rowId);
//   const { ok, deleted } = await productType.remove(rowId);
//   if (!ok) {
//     ElMessage.error("删除失败");
//     return;
//   }
//   debounceLoadList();
//   ElMessage.success(`删除成功,影响行数:${deleted}`);
// }

async function handleFlag(rowId: number, flag: number) {
  //console.log("状态切换", rowId);
  if (flag === undefined || flag === null) {
    ElMessage.error("状态错误");
    return;
  }
  if (!rowId || rowId === 0) {
    ElMessage.error("id错误");
    return;
  }
  const newFlag = flag === 0 ? 1 : 0;
  const row: ProductTypeRow = await productType.update(rowId, {
    flag: newFlag
  });
  if (!row) {
    ElMessage.error("状态切换失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`状态切换成功`);
}
</script>
<template>
  <div>
    <div class="flex_row mb-3">
      <div class="left">
        <el-row :gutter="8">
          <el-col :span="24">
            <el-input
              v-model="queryProductName"
              placeholder="产品名称"
              clearable
              @keyup.enter="debounceLoadList"
              @clear="debounceLoadList"
            />
          </el-col>
        </el-row>
      </div>
      <div class="right">
        <el-button
          type="primary"
          :loading="productType.loading"
          :icon="Search"
          @click="debounceLoadList"
          >查询</el-button
        >
        <el-button :icon="Refresh" type="info" @click="handleResetQuery"
          >重置</el-button
        >
        <el-button :icon="CirclePlus" type="success" @click="handleAdd"
          >添加</el-button
        >

        <el-text v-if="productType.errorInfo" class="mx-1" type="danger">
          {{ productType.errorInfo }}
        </el-text>
      </div>
    </div>
    <el-table
      :data="productType.listResult"
      row-key="id"
      stripe
      border
      style="width: 100%"
    >
      <el-table-column prop="id" label="ID" width="100" align="center">
        <template #default="scope">
          <el-text class="mx-1" type="info" size="small">
            {{ scope.row.id }}
          </el-text>
        </template>
      </el-table-column>
      <el-table-column prop="type_name" label="产品类型名称" min-width="200">
        <template #default="scope">
          <el-text class="mx-1" type="primary">
            {{ scope.row.type_name || "--" }}
          </el-text>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="100" align="center">
        <template #default="scope">
          <el-tag :type="scope.row.flag === 0 ? 'success' : 'danger'">
            {{ scope.row.flag === 1 ? "已禁用" : "已启用" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column fixed="right" label="操作" width="200" align="center">
        <template #default="scope">
          <el-button
            type="primary"
            :icon="Edit"
            @click="handleEdit(scope.row.id)"
          >
            编辑
          </el-button>
          <el-button
            :type="scope.row.flag === 1 ? 'success' : 'danger'"
            :icon="Delete"
            @click="handleFlag(scope.row.id, scope.row.flag)"
          >
            {{ scope.row.flag === 0 ? "禁用" : "启用" }}
          </el-button>
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
        :total="productType.total"
        @size-change="handleSizeChange"
        @current-change="handleCurrentChange"
      />
    </div>
    <!-- 编辑弹窗 -->
    <el-dialog
      v-model="dialogEditVisible"
      :title="currentId > 0 ? '编辑产品' : '添加产品'"
      align-center
      width="70vw"
      destroy-on-close
      draggable
      :modal="true"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <edit-product-type :id="currentId" />
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
  width: 500px;
  text-align: left;
}

.pagination-container {
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>
