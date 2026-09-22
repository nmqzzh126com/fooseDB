<script setup lang="ts">
import { defineAsyncComponent, onMounted, provide, ref } from "vue";
import {
  Edit,
  Search,
  Refresh,
  CirclePlus,
  Delete
} from "@element-plus/icons-vue";
import { debounce } from "@pureadmin/utils";
import { useProduct } from "@/api/demo/product_api";
import { CONFIG as productTypeConfig } from "@/api/demo/product_type_api";
import { CONFIG as productLabelConfig } from "@/api/demo/product_label_api";
import type { FooseListParams } from "@/api/foose_db";
import { ElMessage } from "element-plus";

const editProduct = defineAsyncComponent(async () => {
  return import("@/views/test_api/edit.vue");
});
defineOptions({ name: "TestApi" });

// ✅ 干净 key — listResult / loading / errorInfo / getPageList / create / remove
const {
  listResult,
  loading,
  errorInfo,
  page,
  pageSize,
  total,
  getPageList,
  creates,
  remove
} = useProduct();

const queryProductName = ref("");

// 编辑弹窗
provide("handle-edit-close", handleEditClose);
const dialogEditVisible = ref(false);
const currentProductId = ref(0);

onMounted(async () => {
  debounceLoadList();
});

// 防抖加载列表
const debounceLoadList = debounce(
  async () => {
    await loadPageList();
  },
  300,
  true
);

// 加载分页列表
const loadPageList = async () => {
  const params: FooseListParams = {
    page: page.value,
    pageSize: pageSize.value,
    orderBy: "id:desc",
    filter: {},
    joins: [
      {
        table: productTypeConfig.table,
        as: "pt",
        type: "one",
        on: { local: "product_type_id", foreign: "id" }
      },
      {
        table: productLabelConfig.table,
        as: "pl",
        type: "many",
        on: { local: "id", foreign: "product_id" }
      }
    ]
  };
  if (queryProductName.value?.trim()) {
    params["product_name[_like]"] = `%${queryProductName.value.trim()}%`;
  }
  // 工厂自动 set loading / errorInfo / page / total
  await getPageList(params);
};

const handleSizeChange = async (size: number) => {
  page.value = 1;
  pageSize.value = size;
  debounceLoadList();
};

const handleCurrentChange = async (p: number) => {
  page.value = p;
  debounceLoadList();
};

async function handleResetQuery() {
  page.value = 1;
  queryProductName.value = "";
  debounceLoadList();
}

async function handleEdit(rowId: number) {
  currentProductId.value = rowId;
  dialogEditVisible.value = true;
}

async function handleEditClose(reload: boolean) {
  dialogEditVisible.value = false;
  if (reload) debounceLoadList();
}

async function handleAdd() {
  currentProductId.value = 0;
  dialogEditVisible.value = true;
}

/** 批量添加 — composable 自动 unshift 到 listResult + total++ */
async function handleBatchAdd() {
  const rows = [
    { product_name: "测试产品1", product_type_id: 1, product_count: 100 },
    { product_name: "测试产品2", product_type_id: 2, product_count: 200 },
    { product_name: "测试产品3", product_type_id: 3, product_count: 300 },
    { product_name: "测试产品4", product_type_id: 4, product_count: 400 },
    { product_name: "测试产品5", product_type_id: 5, product_count: 500 }
  ];
  try {
    const res = await creates(rows);
    ElMessage.success(`批量添加成功,影响行数:${res.rows.length}`);
  } catch (e) {
    ElMessage.error(`批量添加失败: ${e instanceof Error ? e.message : e}`);
  }
}

/** 删除 — composable 自动从 listResult filter 掉 + total-- */
async function handleRemove(rowId: number) {
  try {
    await remove(rowId);
    ElMessage.success("删除成功");
  } catch (e) {
    ElMessage.error(`删除失败: ${e instanceof Error ? e.message : e}`);
  }
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
          :loading="loading"
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
        <el-button :icon="CirclePlus" type="warning" @click="handleBatchAdd"
          >批量添加</el-button
        >
        <el-text v-if="errorInfo" class="mx-1" type="danger">
          {{ errorInfo }}
        </el-text>
      </div>
    </div>
    <el-table :data="listResult" row-key="id" stripe border style="width: 100%">
      <el-table-column prop="id" label="ID" width="100" align="center">
        <template #default="scope">
          <el-text class="mx-1" type="info" size="small">
            {{ scope.row.id }}
          </el-text>
        </template>
      </el-table-column>
      <el-table-column prop="product_name" label="产品名称" min-width="150">
        <template #default="scope">
          <el-text class="mx-1" type="primary">
            {{ scope.row.product_name || "--" }}
          </el-text>
        </template>
      </el-table-column>
      <el-table-column label="产品类型" width="150">
        <template #default="scope">
          <el-tag type="warning">
            {{ scope.row.pt?.type_name || "--" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column
        prop="product_count"
        label="数量"
        width="100"
        sortable
        align="left"
      >
        <template #default="scope">
          {{ scope.row.product_count || 0 }}
        </template>
      </el-table-column>
      <el-table-column
        prop="product_desc"
        label="产品描述"
        width="200"
        align="left"
      >
        <template #default="scope">
          <el-text class="mx-1">
            {{ scope.row.product_desc || "" }}
          </el-text>
        </template>
      </el-table-column>
      <el-table-column label="产品标签" width="200" align="left">
        <template #default="scope">
          <el-tag
            v-for="(label, index) in scope.row.pl"
            :key="index"
            type="info"
            size="small"
          >
            {{ label.title || "--" }}
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
            type="danger"
            :icon="Delete"
            @click="handleRemove(scope.row.id)"
          >
            删除
          </el-button>
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
    <!-- 编辑弹窗 -->
    <el-dialog
      v-model="dialogEditVisible"
      :title="currentProductId > 0 ? '编辑产品' : '添加产品'"
      align-center
      width="70vw"
      destroy-on-close
      draggable
      :modal="true"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <edit-product :id="currentProductId" />
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
