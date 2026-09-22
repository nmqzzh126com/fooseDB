<script setup lang="ts" name="EditProduct">
import { ref, reactive, onMounted, inject, toRaw } from "vue";
import { useProduct, type ProductRow } from "@/api/demo/product_api";
import {
  useProductType,
  type ProductTypeRow
} from "@/api/demo/product_type_api";
import {
  useProductLabel,
  type ProductLabelRow
} from "@/api/demo/product_label_api";
import type { FooseListParams, FoosePage } from "@/api/foose_db";
import { ElMessage } from "element-plus";
import { FooseTools } from "@/api/foose_db";

// ✅ 同组件多表场景 — 存整个对象，干净 key 不冲突
const product = useProduct();
const productType = useProductType();
const productLabel = useProductLabel();

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
const productTypeOptions = ref<ProductTypeRow[]>([]);
const productLabelOptions = ref<string[]>([]);

onMounted(async () => {
  await loadProduct();
  await loadProctTypeList();
  await loadProductLabelList();
});

async function loadProduct() {
  if (!props.id || props.id === 0) {
    return;
  }
  try {
    const row: ProductRow = await product.getRow(props.id);
    if (!row) {
      product.errorInfo.value = "产品不存在";
      return;
    }
    productForm.value = row as unknown as ProductRow;
  } catch (e) {
    product.errorInfo.value = e instanceof Error ? e.message : String(e);
  }
}

async function loadProctTypeList() {
  try {
    const params: FooseListParams = {
      noPage: true,
      pageSize: 100,
      filter: { flag: 0 }
    };
    const rows: FoosePage<ProductTypeRow> =
      await productType.getPageList(params);
    if (!rows.data || rows.data.length === 0) {
      productType.errorInfo.value = "产品类型不存在";
      return;
    }
    productTypeOptions.value = rows.data;
  } catch (e) {
    productType.errorInfo.value = e instanceof Error ? e.message : String(e);
  }
}

async function loadProductLabelList() {
  if (!productForm.value.id || productForm.value.id === 0) {
    return;
  }
  try {
    const params: FooseListParams = {
      noPage: true,
      pageSize: 100,
      filter: {
        product_id: { _eq: productForm.value.id },
        flag: 0
      }
    };
    const rows: FoosePage<ProductLabelRow> =
      await productLabel.getPageList(params);
    if (!rows.data || rows.data.length === 0) {
      productLabel.errorInfo.value = "产品标签不存在";
      return;
    }
    productLabelOptions.value = rows.data.map(item => item.title);
  } catch (e) {
    productLabel.errorInfo.value = e instanceof Error ? e.message : String(e);
  }
}

async function findProductLabelRows(
  productId: number
): Promise<ProductLabelRow[]> {
  try {
    const params: FooseListParams = {
      noPage: true,
      pageSize: 100,
      filter: { product_id: { _eq: productId } }
    };
    const rows: FoosePage<ProductLabelRow> =
      await productLabel.getPageList(params);
    if (!rows.data || rows.data.length === 0) return [];
    return rows.data;
  } catch (e) {
    productLabel.errorInfo.value = e instanceof Error ? e.message : String(e);
  }
  return [];
}

async function submitData() {
  productForm.value.id = Number(productForm.value.id || 0);
  productForm.value.product_type_id = Number(productForm.value.product_type_id);
  productForm.value.product_count = Number(productForm.value.product_count);
  productForm.value.product_desc = (
    productForm.value.product_desc || ""
  ).trim();
  productForm.value.product_name = (
    productForm.value.product_name || ""
  ).trim();

  if (
    !productForm.value.product_name ||
    productForm.value.product_name.length === 0
  ) {
    ElMessage.error("请输入产品名称");
    return;
  }
  if (
    !productForm.value.product_type_id ||
    productForm.value.product_type_id === 0
  ) {
    ElMessage.error("请选择产品类型");
    return;
  }

  try {
    if (productForm.value.id > 0) {
      const row: ProductRow = toRaw(productForm.value);
      await product.update(productForm.value.id, row);
      ElMessage.success("更新成功");
    } else {
      const row: ProductRow = toRaw(productForm.value);
      delete row.id;
      const newRow = await product.create(row);
      if (newRow) {
        ElMessage.success("创建成功");
      } else {
        ElMessage.error("创建失败");
      }
    }
    handleEditClose(true);
  } catch (e) {
    ElMessage.error("操作失败~!");
    product.errorInfo.value = e instanceof Error ? e.message : String(e);
  }
}

async function handleLabelChange(val: string[]) {
  const labelRows = await findProductLabelRows(Number(productForm.value.id));
  const ids = labelRows.map(item => item.my_id);
  if (!val || val.length === 0) {
    if (ids && ids.length > 0) {
      const res = await productLabel.removesByFilter(
        { product_id: { _eq: Number(productForm.value.id) } },
        true
      );
      if (res.ok) {
        ElMessage.success(`清空成功:${res.deleted}`);
      } else {
        ElMessage.error("清空失败");
      }
    }
    return;
  }

  const addRows = val.filter(
    item => !labelRows.some(item2 => item2.title === item)
  );
  if (addRows && addRows.length > 0) {
    for (const item of addRows) {
      const title = item.trim();
      const newRow = await productLabel.create({
        my_id: FooseTools.createUuid(),
        product_id: Number(productForm.value.id),
        title
      });
      if (newRow) {
        ElMessage.success(`添加成功:${newRow.my_id}`);
      } else {
        ElMessage.error("添加失败");
      }
    }
  }

  const removeIds = labelRows
    .filter(item => !val.includes(item.title))
    .map(item => item.my_id);
  if (removeIds && removeIds.length > 0) {
    const res = await productLabel.removes(removeIds);
    if (res.ok) {
      ElMessage.success(`删除成功:${res.deleted}`);
    } else {
      ElMessage.error("删除失败");
    }
  }
  await loadProductLabelList();
}

const handleEditClose = inject<(reload: boolean) => void>(
  "handle-edit-close",
  () => {}
);
</script>

<template>
  <div>
    <div v-if="product.errorInfo">{{ product.errorInfo }}</div>
    <div>
      <el-form :model="productForm" label-width="120" style="max-width: 100%">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="产品名称" prop="product_name">
              <el-input
                v-model="productForm.product_name"
                maxlength="50"
                minlength="2"
                placeholder="请输入产品名称"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="产品类型">
              <el-select
                v-model="productForm.product_type_id"
                placeholder="请选择产品类型"
                style="width: 240px"
              >
                <el-option
                  v-for="item in productTypeOptions"
                  :key="item.id"
                  :label="item.type_name"
                  :value="item.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="产品描述" prop="product_desc">
              <el-input
                v-model="productForm.product_desc"
                maxlength="200"
                minlength="0"
                show-word-limit
                placeholder="请输入产品描述"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="产品数量" prop="product_count">
              <el-input-number
                v-model="productForm.product_count"
                :min="0"
                :max="999999"
                placeholder="请输入产品数量"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col v-if="Number(productForm.id) > 0" :span="24">
            <el-form-item label="产品标签">
              <el-input-tag
                v-model="productLabelOptions"
                placeholder="请输入产品标签"
                aria-label="请输入产品标签"
                @change="handleLabelChange"
              />
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
