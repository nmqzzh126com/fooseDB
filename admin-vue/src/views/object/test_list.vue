<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { Grid, Delete, Plus, Loading, User, Lock } from "@element-plus/icons-vue";
const paramPage = ref(1);
const paramPageSize = ref(10);
const paramFields = ref("");
const paramOrderBy = ref("");
const paramOrder = ref<"asc" | "desc">("asc");
const paramJoin = ref("");
const paramNopage = ref(false);
const paramOne = ref(false);
const props = defineProps({
  page: {
    type: Number,
    default: 1
  },
  pageSize: {
    type: Number,
    default: 10
  },
  one: {
    type: Boolean,
    default: false
  },
  fields: {
    type: String,
    default: ""
  },
  orderBy: {
    type: String,
    default: ""
  },
  order: {
    type: String,
    default: "asc"
  },
  join: {
    type: String,
    default: ""
  },
  nopage: {
    type: Boolean,
    default: false
  },

})
const emit = defineEmits(["update:page", "update:pageSize", "update:one", "update:fields", "update:orderBy", "update:order", "update:join", "update:nopage"]);
{
  watch(() => paramPage.value, (newVal) => {
    emit("update:page", newVal);
  });
  watch(() => paramPageSize.value, (newVal) => {
    emit("update:pageSize", newVal);
  });
  watch(() => paramOne.value, (newVal) => {
    emit("update:one", newVal);
  });
  watch(() => paramFields.value, (newVal) => {
    emit("update:fields", newVal);
  });
  watch(() => paramOrderBy.value, (newVal) => {
    emit("update:orderBy", newVal);
  });
  watch(() => paramOrder.value, (newVal) => {
    console.log("order", newVal);
    emit("update:order", newVal);
  });
  watch(() => paramJoin.value, (newVal) => {
    emit("update:join", newVal);
  });
  watch(() => paramNopage.value, (newVal) => {
    emit("update:nopage", newVal);
  });
}



interface FilterKV {
  key: string;
  value: string;
}
const filters = ref<FilterKV[]>([{ key: "", value: "" }]);
function addFilter() {
  filters.value.push({ key: "", value: "" });
}
function removeFilter(i: number) {
  filters.value.splice(i, 1);
}
</script>
<template>
  <div>
    <div>
      <el-form-item label="当前页:">
        <el-input-number v-model="paramPage" :min="1" :max="10" label="page" />
      </el-form-item>
      <el-form-item label="每页数量:">
        <el-input-number v-model="paramPageSize" :min="2" :max="100" label="pageSize" />
      </el-form-item>

      <el-input v-model="paramOrderBy" placeholder="orderBy，如 created_at 或 created_at,-id" size="small" class="w-56" />
      <el-select v-model="paramOrder" size="small" class="w-24">
        <el-option label="asc" value="asc" />
        <el-option label="desc" value="desc" />
      </el-select>
      <el-checkbox v-model="paramNopage" size="small">nopage 不分页</el-checkbox>
      <el-checkbox v-model="paramOne" size="small">__one 查一行</el-checkbox>
    </div>

    <div class="flex gap-2 flex-wrap items-center">
      <el-input v-model="paramFields" placeholder="fields 列裁剪，逗号分隔：id,name,title" size="small" class="w-72" />
      <el-input v-model="paramJoin" placeholder="join 关联，如 users,comments" size="small" class="w-56" />
    </div>

    <div class="flex flex-col gap-1">
      <div class="text-xs text-gray-500">
        过滤条件 (key=value，支持 id__gte=100 等 Directus 风格)
      </div>
      <div v-for="(f, i) in filters" :key="i" class="flex gap-2 items-center">
        <el-input v-model="f.key" placeholder="key 如 status 或 id__gte" size="small" class="w-48" clearable />
        <el-input v-model="f.value" placeholder="value" size="small" class="w-48" clearable />
        <el-button v-if="filters.length > 1" size="small" type="danger" :icon="Delete" circle
          @click="removeFilter(i)" />
        <el-button v-if="i === filters.length - 1" size="small" type="primary" :icon="Plus" circle @click="addFilter" />
      </div>
    </div>
  </div>
</template>
<style lang='scss' scoped></style>