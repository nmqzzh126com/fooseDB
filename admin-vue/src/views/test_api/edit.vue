<script setup lang="ts" name="EditProduct">
import { ref, reactive, onMounted, inject, toRaw } from "vue";
import { ProductRow, useProduct } from "@/api/demo/product_api";
import { ProductTypeRow, useProductType } from "@/api/demo/product_type_api";
import { ProductLabelRow, useProductLabel } from "@/api/demo/product_label_api";
import { FooseListParams, FoosePage } from "@/api/foose_db";
import { ElMessage } from "element-plus";
import FooseTools from "@/api/demo/foose_tools";

const {
  productCurrentRow,
  productDbLoading,
  productDbError,
  productDbGet,
  productDbGetBy,
  productDbCreate,
  productDbUpdate
} = useProduct();
const { productTypeDbLoading, productTypeDbError, productTypeDbList } = useProductType();
const {
  productLabelDbLoading,
  productLabelDbError,
  productLabelDbList,
  productLabelDbCreate,
  productLabelDbRemoves,
  productLabelDbRemovesByFilter
} = useProductLabel();

const props = defineProps({
  id: {
    type: Number,
    default: 0
  }
});
const productForm = ref<ProductRow>({
  id: 0,
  product_type_id: 1,
  product_name: "",
  product_count: 0,
  product_desc: ""
} as ProductRow);
const productTypeOptions = ref<ProductTypeRow[]>([]); //产品类型选项
const productLabelOptions = ref<string[]>([]); //产品标签选项
onMounted(async () => {
  await loadProduct();
  await loadProctTypeList();
  await loadProductLabelList();
});

async function loadProduct() {
  if (!props.id || props.id === 0) {
    console.log("产品ID为空,进入添加模式!");
    return;
  }
  try {
    const row: ProductRow = await productDbGet(props.id);
    //console.log(row, productCurrentRow.value);
    if (!row) {
      productDbError.value = "产品不存在";
      return;
    }
    productForm.value = row as unknown as ProductRow;
  } catch (e) {
    productDbError.value = e instanceof Error ? e.message : String(e);
  } finally {
    productDbLoading.value = false;
  }
}
async function loadProctTypeList() {
  try {
    const params: FooseListParams = {
      //showSql: true,//是否显示SQL语句
      noPage: true, //是否不分页
      pageSize: 100, //每页数量,最多取100条数据
      filter: {
        flag: 0
      }
    };
    const rows: FoosePage<ProductTypeRow> = await productTypeDbList(params);
    //console.log(rows);
    if (!rows.data || rows.data.length === 0) {
      productTypeDbError.value = "产品类型不存在";
      return;
    }
    productTypeOptions.value = rows.data;
  } catch (e) {
    productTypeDbError.value = e instanceof Error ? e.message : String(e);
  } finally {
    productTypeDbLoading.value = false;
  }
}

async function loadProductLabelList() {
  if (!productForm.value.id || productForm.value.id === 0) {
    return;
  }
  try {
    const params: FooseListParams = {
      showSql: true, //是否显示SQL语句
      noPage: true, //是否不分页
      pageSize: 100, //每页数量,最多取100条数据
      filter: {
        product_id: { _eq: productForm.value.id },
        flag: 0
      }
    };
    const rows: FoosePage<ProductLabelRow> = await productLabelDbList(params);
    //console.log(rows);
    if (!rows.data || rows.data.length === 0) {
      productLabelDbError.value = "产品标签不存在";
      return;
    }
    productLabelOptions.value = rows.data.map(item => item.title);
    console.log(productLabelOptions.value);
  } catch (e) {
    productLabelDbError.value = e instanceof Error ? e.message : String(e);
  } finally {
    productLabelDbLoading.value = false;
  }
}

async function findProductLabelRows(productId: number): Promise<ProductLabelRow[]> {
  try {
    const params: FooseListParams = {
      //showSql: true,//是否显示SQL语句
      noPage: true, //是否不分页
      pageSize: 100, //每页数量,最多取100条数据
      //fields: ["my_id"],
      filter: {
        product_id: { _eq: productId }
      }
    };
    const rows: FoosePage<ProductLabelRow> = await productLabelDbList(params);
    //console.log("find产品标签列表:", rows);
    if (!rows.data || rows.data.length === 0) {
      return [];
    }
    return rows.data;
  } catch (e) {
    productLabelDbError.value = e instanceof Error ? e.message : String(e);
  } finally {
    productLabelDbLoading.value = false;
  }
  return [];
}

/**
 * 提交数据
 */
async function submitData() {
  productForm.value.id = Number(productForm.value.id || 0);
  productForm.value.product_type_id = Number(productForm.value.product_type_id);
  productForm.value.product_count = Number(productForm.value.product_count);
  productForm.value.product_desc = (productForm.value.product_desc || "").trim();
  productForm.value.product_name = (productForm.value.product_name || "").trim();
  if (!productForm.value.product_name || productForm.value.product_name.length === 0) {
    ElMessage.error("请输入产品名称");
    return;
  }
  if (!productForm.value.product_type_id || productForm.value.product_type_id === 0) {
    ElMessage.error("请选择产品类型");
    return;
  }

  try {
    if (productForm.value.id > 0) {
      const row: ProductRow = toRaw(productForm.value); //{ ...productForm.value };
      console.log("更新产品:", row);
      await productDbUpdate(productForm.value.id, row);
      ElMessage.success("更新成功");
    } else {
      const row: ProductRow = toRaw(productForm.value);
      delete row.id;//删除id,由数据库自动生成      
      const newRow = await productDbCreate(row);
      if (newRow) {
        ElMessage.success("创建成功");
      } else {
        ElMessage.error("创建失败");
      }
    }
    handleEditClose(true);
  } catch (e) {
    ElMessage.error("操作失败~!");
    productDbError.value = e instanceof Error ? e.message : String(e);
  } finally {
    productDbLoading.value = false;
  }
}

/**
 * 产品标签改变时调用
 */
async function handleLabelChange(val: string[]) {
  const labelRows = await findProductLabelRows(Number(productForm.value.id));
  const ids = labelRows.map(item => item.my_id);
  if (!val || val.length === 0) {
    // 清空产品标签1
    if (ids && ids.length > 0) {
      const { ok, deleted, sql, sqlParams } = await productLabelDbRemovesByFilter(
        {
          product_id: { _eq: Number(productForm.value.id) }
        },
        true
      );
      console.log("清空产品标签filter:", ok, deleted, sql, sqlParams);
      if (ok) {
        ElMessage.success(`清空成功:${deleted}`);
      } else {
        ElMessage.error("清空失败");
      }
    }
    // 清空产品标签2
    // if (ids && ids.length > 0) {
    //   const { ok, deleted } = await productLabelDbRemoves(ids);
    //   if (ok) {
    //     ElMessage.success(`清空成功:${deleted}`);
    //   } else {
    //     ElMessage.error("清空失败");
    //   }
    // }
    return;
  } else {
    //添加或删除产品标签
    const addRows = val.filter(item => !labelRows.some(item2 => item2.title === item));
    if (addRows && addRows.length > 0) {
      //console.log("add产品标签:", addRows);
      for (const item of addRows) {
        const title = item.trim();
        const newRow = await productLabelDbCreate({
          my_id: FooseTools.createUuid(),
          product_id: Number(productForm.value.id),
          title: title
        });
        //console.log("添加产品标签:", newRow);
        if (newRow) {
          ElMessage.success(`添加成功:${newRow.my_id}`);
        } else {
          ElMessage.error("添加失败");
        }
      }
    }
    let removeIds = [];
    for (const item of labelRows) {
      if (!val.includes(item.title)) {
        removeIds.push(item.my_id);
      }
    }
    if (removeIds && removeIds.length > 0) {
      //console.log("remove产品标签:", removeIds);
      const { ok, deleted } = await productLabelDbRemoves(removeIds);
      if (ok) {
        ElMessage.success(`删除成功:${deleted}`);
      } else {
        ElMessage.error("删除失败");
      }
    }
  }
  await loadProductLabelList();
}
//父组件中的方法
const handleEditClose = inject<(reload: boolean) => void>("handle-edit-close", () => { });
</script>
<template>
  <div>
    <div v-if="productDbError">{{ productDbError }}</div>
    <div>
      <el-form :model="productForm" label-width="120" style="max-width: 100%">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="产品名称" prop="product_name">
              <el-input v-model="productForm.product_name" maxlength="50" minlength="2" placeholder="请输入产品名称" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="产品类型">
              <el-select v-model="productForm.product_type_id" placeholder="请选择产品类型" style="width: 240px">
                <el-option v-for="item in productTypeOptions" :key="item.id" :label="item.type_name" :value="item.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="产品描述" prop="product_desc">
              <el-input v-model="productForm.product_desc" maxlength="200" minlength="0" show-word-limit
                placeholder="请输入产品描述" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="产品数量" prop="product_count">
              <el-input-number v-model="productForm.product_count" :min="0" :max="999999" placeholder="请输入产品数量"
                style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col v-if="Number(productForm.id) > 0" :span="24">
            <el-form-item label="产品标签">
              <el-input-tag v-model="productLabelOptions" placeholder="请输入产品标签" aria-label="请输入产品标签"
                @change="handleLabelChange" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
    </div>
    <div class="dialog-footer">
      <el-button @click="handleEditClose(true)">关闭</el-button>
      <el-button type="primary" @click="submitData"> 保存 </el-button>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 20px;
}
</style>
