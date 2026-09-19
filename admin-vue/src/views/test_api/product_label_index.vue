<script setup lang="ts">
import { defineAsyncComponent, onMounted, provide, ref } from "vue";
import { Edit, Search, Refresh, CirclePlus, Delete } from "@element-plus/icons-vue";
import { debounce } from "@pureadmin/utils";
import { FooseListParams } from "@/api/foose_db";
import FooseTools from "@/api/demo/foose_tools";
import { ElMessage } from "element-plus";
import { ProductLabelRow, useProductLabel } from "@/api/demo/product_label_api";

const {
  productLabelDbDataList,
  productLabelDbLoading,
  productLabelDbError,
  productLabelDbPage,
  productLabelDbPageSize,
  productLabelDbTotal,
  productLabelDbList,
  productLabelDbCreate,
  productLabelDbUpdate,
  productLabelDbRemoves,
  productLabelDbRemovesByFilter
} = useProductLabel();
const editProductLabel = defineAsyncComponent(async () => {
  return import("@/views/test_api/edit_label.vue");
});
defineOptions({
  name: "TestApiProductLableIndex"
});
const defautPageIndex = ref(1); // 当前页码
const defaultPageSize = ref(5); // 每页大小
const queryLabelName = ref(""); // 查询标签名称

// 编辑弹窗
provide("handle-edit-label-close", handleEditLabelClose);
const dialogEditVisible = ref(false);
const currentId = ref("");
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
  if (queryLabelName.value?.trim()) {
    filter["title[_like]"] = `%${queryLabelName.value.trim()}%`;
  }
  // —— 构建查询参数（Directus 风格 filter）——
  const params: FooseListParams = {
    showSql: true,//是否显示SQL语句
    page: defautPageIndex.value,
    pageSize: defaultPageSize.value,
    //noPage: true,
    // 排序
    //orderBy: "my_id:desc",
    filter: filter,
    joins: [
      // 一对一关联
      {
        table: "product",//必填项
        joinType: "left",//"left" | "inner"; 
        as: "pdt",//关联别名,同一子表多次关联时,需要指定别名,否则会报错
        type: "one",//one（主表→子表，FK 在主表）,many（子表→主表反向查，FK 在子表）
        on: {
          local: "product_id",
          foreign: "id"
        }
      },
    ],
  };

  try {
    const res = await productLabelDbList(params);
    // console.log(res);
    // console.log(res.sql, res.sqlParams);
    // console.log(productLabelDbPage.value, productLabelDbPageSize.value, productLabelDbTotal.value);
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
  queryLabelName.value = "";
  debounceLoadList();
}
/**编辑 */
async function handleEdit(rowId: string) {
  currentId.value = rowId;
  dialogEditVisible.value = true;
}
//子组件调用这个方法
async function handleEditLabelClose(reload: boolean) {
  dialogEditVisible.value = false;
  if (reload) {
    debounceLoadList();
  }
}

/** 添加 */
async function handleAdd() {
  const newRow: any = {
    my_id: FooseTools.createUuid(),
    title: "新标签名称",
    flag: 0,
  };
  const res = await productLabelDbCreate(newRow);
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
//   const { ok, deleted } = await productTypeDbRemove(rowId);
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
  const row: ProductLabelRow = await productLabelDbUpdate(rowId, { flag: newFlag });
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
            <el-input v-model="queryLabelName" placeholder="标签名称" clearable @keyup.enter="debounceLoadList"
              @clear="debounceLoadList" />
          </el-col>
        </el-row>
      </div>
      <div class="right">
        <el-button type="primary" :loading="productLabelDbLoading" :icon="Search"
          @click="debounceLoadList">查询</el-button>
        <el-button :icon="Refresh" type="info" @click="handleResetQuery">重置</el-button>
        <el-button :icon="CirclePlus" type="success" @click="handleAdd">添加</el-button>

        <el-text v-if="productLabelDbError" class="mx-1" type="danger">
          {{ productLabelDbError }}
        </el-text>
      </div>
    </div>
    <el-table :data="productLabelDbDataList" row-key="my_id" stripe border style="width: 100%">
      <el-table-column prop="my_id" label="标签ID" width="300" align="center">
        <template #default="scope">
          <el-text class="mx-1" type="info" size="small">
            {{ scope.row.my_id }}
          </el-text>
        </template>
      </el-table-column>

      <el-table-column prop="title" label="标签名称" min-width="200">
        <template #default="scope">
          <el-text class="mx-1" type="primary">
            {{ scope.row.title || "--" }}
          </el-text>
        </template>
      </el-table-column>
      <el-table-column label="产品名称" width="100" align="center">
        <template #default="scope">
          <el-text class="mx-1" type="info" size="small">
            {{ scope.row.pdt?.product_name || "--" }}
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
          <el-button type="primary" :icon="Edit" @click="handleEdit(scope.row.my_id)">
            编辑
          </el-button>
          <el-button :type="scope.row.flag === 1 ? 'success' : 'danger'" :icon="Delete"
            @click="handleFlag(scope.row.my_id, scope.row.flag)">
            {{ scope.row.flag === 0 ? "禁用" : "启用" }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="mt-3 pagination-container">
      <el-pagination v-model:current-page="defautPageIndex" v-model:page-size="defaultPageSize" size="default"
        :page-sizes="[5, 10, 20, 50, 100]" layout="total, sizes, prev, pager, next, jumper" :total="productLabelDbTotal"
        @size-change="handleSizeChange" @current-change="handleCurrentChange" />
    </div>
    <!-- 编辑弹窗 -->
    <el-dialog v-model="dialogEditVisible" :title="currentId.length > 0 ? '编辑产品标签' : '添加产品标签'" align-center width="70vw"
      destroy-on-close draggable :modal="true" :close-on-click-modal="false" :close-on-press-escape="false">
      <edit-product-label :id="currentId" />
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
  width: 500px;
  text-align: left;
}

.pagination-container {
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>