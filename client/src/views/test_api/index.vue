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
import { FooseListParams } from "@/api/foose_db";
import { ElMessage } from "element-plus";

const editProduct = defineAsyncComponent(async () => {
  return import("@/views/test_api/edit.vue");
});
defineOptions({
  name: "TestApi"
});
const defautPageIndex = ref(1); // 当前页码
const defaultPageSize = ref(10); // 每页大小
const queryProductName = ref(""); // 查询产品名称

const {
  productDbDataList,
  productDbLoading,
  productDbError,
  productDbPage,
  productDbPageSize,
  productDbTotal,
  productDbList,
  productDbCreates,
  productDbRemove
} = useProduct();
// 编辑弹窗
provide("handle-edit-close", handleEditClose);
const dialogEditVisible = ref(false);
const currentProductId = ref(0);
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
  // —— 构建查询参数（Directus 风格 filter）——
  const params: FooseListParams = {
    showSql: true, //是否显示SQL语句
    page: defautPageIndex.value,
    pageSize: defaultPageSize.value,
    //noPage: true,
    // 排序
    orderBy: "id:desc",
    //orderBy: "product_count:desc,id:desc",
    //orderBy: "pt.id:asc, product_count:desc",  // 子表列也能排序
    //orderBy: ["product_count:desc", "pt.id:asc"],
    // 分组
    //fields: "product_type_id,product_name",
    //fields: ["id", "product_name", "product_count"],
    //groupBy: "product_type_id",
    //"having[cnt][_gt]": 2,

    filter: {
      //"product_count[_gt]": 0,           // 主表列 —— 直接写
      // —— 子表列过滤 ——
      //"pt.type_name[_like]": "%机%",            // product_type.name LIKE '%机%'
      //"pl.flag[_eq]": 0,            // product_label.flag = 0
      //"pt.flag[_eq]": 0,         // product_type.category IN (1,2,3)
      //product_count: { _gte: 3 }
      // _or: [
      //   {
      //     "product_name[_like]": "%机%",
      //     _and: [
      //       { create_time: 0 },
      //       {
      //         _or: [
      //           { update_time: 0 },
      //           { delete_time: 0 }
      //         ]
      //       }]
      //   },
      //   { "product_name[_like]": "%华%" }
      // ],
      // _or: [
      //   // 组 0：两个条件 AND
      //   { "product_name[_like]": "%机%", product_type_id: 1 },
      //   // 组 1：单个条件
      //   { "product_name[_like]": "%华%" },
      //   // 组 2：嵌套写法也可以
      //   { product_count: { _gt: 20 } }
      // ],
    },
    //"aggregate[count][*]": "cnt",
    // aggregate: {
    //   count: { "*": "cnt" },
    //   sum: { "product_count": "total_qty" }
    // },
    // group: {
    //   by: "product_type_id",
    //   having: { "cnt[_gt]": 2 }
    // },
    //orderBy: "cnt:desc"  // 聚合别名也能排序
    // 关联子表
    joins: [
      // 一对一关联
      {
        table: "product_type", //必填项
        as: "pt", //关联别名,同一子表多次关联时,需要指定别名,否则会报错
        type: "one", //one（主表→子表，FK 在主表）,many（子表→主表反向查，FK 在子表）
        on: {
          local: "product_type_id",
          foreign: "id"
        }
      },
      // 一对一多关联
      {
        table: "product_label",
        as: "pl", //关联别名,同一子表多次关联时,需要指定别名,否则会报错
        type: "many", //one（主表→子表，FK 在主表）,many（子表→主表反向查，FK 在子表）
        on: {
          local: "id",
          foreign: "product_id"
        }
      }
    ]
  };
  // 有输入 → 模糊匹配（自动补 % 前后缀）
  if (queryProductName.value?.trim()) {
    params["product_name[_like]"] = `%${queryProductName.value.trim()}%`;
  }
  try {
    const res = await productDbList(params);
    //console.log(res);
    //console.log(res.sql, res.sqlParams);
    //console.log(productDbPage.value, productDbPageSize.value, productDbTotal.value);
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
  currentProductId.value = rowId;
  dialogEditVisible.value = true;
}
//子组件调用这个方法
async function handleEditClose(reload: boolean) {
  //console.log("handleEditClose");
  dialogEditVisible.value = false;
  if (reload) {
    debounceLoadList();
  }
}

/** 添加 */
async function handleAdd() {
  currentProductId.value = 0;
  dialogEditVisible.value = true;
}

/** 批量添加 */
async function handleBatchAdd() {
  console.log("测试批量添加");
  const rows = [
    {
      product_name: "测试产品1",
      product_type_id: 1,
      product_count: 100
    },
    {
      product_name: "测试产品2",
      product_type_id: 2,
      product_count: 200
    },
    {
      product_name: "测试产品3",
      product_type_id: 3,
      product_count: 300
    },
    {
      product_name: "测试产品4",
      product_type_id: 4,
      product_count: 400
    },
    {
      product_name: "测试产品5",
      product_type_id: 5,
      product_count: 500
    }
  ];
  const res = await productDbCreates(rows);
  console.log(res);
  if (!res.ok) {
    ElMessage.error("批量添加失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`批量添加成功,影响行数:${res.rows.length}`);
}
/** 删除 */
async function handleRemove(rowId: number) {
  //console.log("删除", rowId);
  const { ok, deleted } = await productDbRemove(rowId);
  if (!ok) {
    ElMessage.error("删除失败");
    return;
  }
  debounceLoadList();
  ElMessage.success(`删除成功,影响行数:${deleted}`);
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
          :loading="productDbLoading"
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
        <el-text v-if="productDbError" class="mx-1" type="danger">
          {{ productDbError }}
        </el-text>
      </div>
    </div>
    <el-table
      :data="productDbDataList"
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
        v-model:current-page="productDbPage"
        v-model:page-size="productDbPageSize"
        size="default"
        :page-sizes="[5, 10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        :total="productDbTotal"
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
