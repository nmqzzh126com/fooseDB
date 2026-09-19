<script setup lang="ts">
import { ref, reactive, inject, onMounted, toRaw } from 'vue'
import { ElMessage } from "element-plus";
import { FooseListParams } from '@/api/foose_db';
import { ProductLabelRow, useProductLabel } from '@/api/demo/product_label_api';
import FooseTools from '@/api/demo/foose_tools';

const {
  productLabelDbLoading,
  productLabelDbError,
  productLabelDbList,
  productLabelDbGet,
  productLabelDbCreate,
  productLabelDbUpdate,

} = useProductLabel();

const props = defineProps({
  id: {
    type: String,
    default: ""
  }
});
const productLabelForm = ref<ProductLabelRow>({
  my_id: "",
  product_id: 1,
  title: "",
  sort: 0,
  flag: 0,

} as ProductLabelRow);

onMounted(async () => {
  const res = await productLabelDbGet(props.id);
  if (res) {
    productLabelForm.value = res;
  } else {
    ElMessage.error("产品标签不存在");
  }
});

/**
 * 提交数据
 */
async function submitData() {
  productLabelForm.value.id = (productLabelForm.value.id || 0);
  productLabelForm.value.flag = Number(productLabelForm.value.flag);
  productLabelForm.value.title = (productLabelForm.value.title || "").trim();

  if (!productLabelForm.value.title || productLabelForm.value.title.length === 0) {
    ElMessage.error("请输入产品标签名称");
    return;
  }

  try {
    if (productLabelForm.value.my_id.length > 0) {
      const row: ProductLabelRow = toRaw(productLabelForm.value); //{ ...productLabelForm.value };
      console.log("更新产品标签:", row);
      await productLabelDbUpdate(productLabelForm.value.my_id, row);
      ElMessage.success("更新成功");
    } else {
      const row: ProductLabelRow = toRaw(productLabelForm.value);
      row.my_id = FooseTools.createUuid();
      const newRow = await productLabelDbCreate(row);
      if (newRow) {
        ElMessage.success("创建成功");
      } else {
        ElMessage.error("创建失败");
      }
    }
    handleEditLabelClose(true);
  } catch (e) {
    ElMessage.error("操作失败~!");
    productLabelDbError.value = e instanceof Error ? e.message : String(e);
  } finally {
    productLabelDbLoading.value = false;
  }
}

//父组件中的方法
const handleEditLabelClose = inject<(reload: boolean) => void>("handle-edit-label-close", () => { });
</script>
<template>
  <div>
    <div v-if="productLabelDbError">{{ productLabelDbError }}</div>
    <div>
      <el-form :model="productLabelForm" label-width="120" style="max-width: 100%">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="产品标签名称" prop="title">
              <el-input v-model="productLabelForm.title" maxlength="50" minlength="2" placeholder="请输入产品标签名称" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="产品ID">
              <el-input v-model="productLabelForm.product_id" type="number" min="1" max="999999"
                placeholder="请输入产品ID" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="标签状态">
              <el-switch v-model="productLabelForm.flag" class="ml-2" inline-prompt :active-value="0"
                :inactive-value="1" style="--el-switch-on-color: #13ce66; --el-switch-off-color: #ff4949"
                active-text="启用" inactive-text="禁用" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
    </div>
    <div class="dialog-footer">
      <el-button @click="handleEditLabelClose(true)">关闭</el-button>
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