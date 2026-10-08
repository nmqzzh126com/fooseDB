export default {
  path: "/test-api",
  redirect: "/test-api/index",
  meta: {
    icon: "ri/ubuntu-fill",
    title: "测试接口",
    rank: 2
  },
  children: [
    {
      path: "/test-api/index",
      name: "TestApi",
      component: () => import("@/views/test_api/index.vue"),
      meta: {
        title: "测试接口"
      }
    },
    {
      path: "/test-api/product_type_index",
      name: "TestApiProductTypeIndex",
      component: () => import("@/views/test_api/product_type_index.vue"),
      meta: {
        title: "演示产品类型"
      }
    },
    {
      path: "/test-api/product_label_index",
      name: "TestApiProductLableIndex",
      component: () => import("@/views/test_api/product_label_index.vue"),
      meta: {
        title: "演示产品标签"
      }
    }
  ]
} satisfies RouteConfigsTable;
