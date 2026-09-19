<script setup lang="ts">
import { ref, reactive, inject, onMounted, toRaw } from 'vue'
import { ProductTypeRow, useProductType } from "@/api/demo/product_type_api";
import { ElMessage } from "element-plus";
import { FooseListParams } from '@/api/foose_db';
const { productTypeDbDataList,
  productTypeDbLoading, productTypeDbError,
  productTypeDbTotal, productTypeDbList,
  productTypeDbPage, productTypeDbPageSize,
  productTypeDbCreate, productTypeDbRemove,
  productTypeDbGet, productTypeDbGetBy,
  productTypeDbUpdate
} = useProductType();

const props = defineProps({
  id: {
    type: Number,
    default: 0
  }
});
const productTypeForm = ref<ProductTypeRow>({
  id: 0,
  type_name: "",
  flag: 0,

} as ProductTypeRow);

onMounted(async () => {
  const res = await productTypeDbGet(props.id);
  if (res) {
    productTypeForm.value = res;
  } else {
    ElMessage.error("产品类型不存在");
  }
});



/**
 * 提交数据
 */
async function submitData() {
  productTypeForm.value.id = Number(productTypeForm.value.id || 0);
  productTypeForm.value.flag = Number(productTypeForm.value.flag);
  productTypeForm.value.type_name = (productTypeForm.value.type_name || "").trim();

  if (!productTypeForm.value.type_name || productTypeForm.value.type_name.length === 0) {
    ElMessage.error("请输入产品类型名称");
    return;
  }

  try {
    if (productTypeForm.value.id > 0) {
      const row: ProductTypeRow = toRaw(productTypeForm.value); //{ ...productTypeForm.value };
      console.log("更新产品类型:", row);
      await productTypeDbUpdate(productTypeForm.value.id, row);
      ElMessage.success("更新成功");
    } else {
      const row: ProductTypeRow = toRaw(productTypeForm.value);
      delete row.id;//删除id,由数据库自动生成      
      const newRow = await productTypeDbCreate(row);
      if (newRow) {
        ElMessage.success("创建成功");
      } else {
        ElMessage.error("创建失败");
      }
    }
    handleEditTypeClose(true);
  } catch (e) {
    ElMessage.error("操作失败~!");
    productTypeDbError.value = e instanceof Error ? e.message : String(e);
  } finally {
    productTypeDbLoading.value = false;
  }
}

//父组件中的方法
const handleEditTypeClose = inject<(reload: boolean) => void>("handle-edit-type-close", () => { });
</script>
<template>
  <div>
    <div v-if="productTypeDbError">{{ productTypeDbError }}</div>
    <div>
      <el-form :model="productTypeForm" label-width="120" style="max-width: 100%">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="产品类型名称" prop="type_name">
              <el-input v-model="productTypeForm.type_name" maxlength="50" minlength="2" placeholder="请输入产品类型名称" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="类型状态">
              <el-switch v-model="productTypeForm.flag" class="ml-2" inline-prompt :active-value="0" :inactive-value="1"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949" active-text="启用"
                inactive-text="禁用" />

            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
    </div>
    <div class="dialog-footer">
      <el-button @click="handleEditTypeClose(true)">关闭</el-button>
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