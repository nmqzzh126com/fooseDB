<script setup lang="ts">
import { ref, reactive } from "vue";
import { useProduct } from "./utils/product";
import { FooseListParams } from "@/api/foose_db";
const {
  listResult,
  loading,
  errorInfo,
  page,
  pageSize,
  total,
  getPageList,
  create,
  remove
} = useProduct();

// 加载分页列表
const loadPageList = async () => {
  const params: FooseListParams = {
    page: page.value,
    pageSize: pageSize.value,
    orderBy: "id:desc",
    filter: {
      "product_name[_like]": `%张三%`
    },
    joins: [
      {
        table: "子表名1",
        as: "pt",
        type: "one",
        on: { local: "product_type_id", foreign: "id" }
      },
      {
        table: "子表名2",
        as: "pl",
        type: "many",
        on: { local: "id", foreign: "product_id" }
      }
    ]
  };
  await getPageList(params);
};
</script>
<template>
  <div>
    <h1>页面列表</h1>
  </div>
</template>
<style lang="scss" scoped></style>
