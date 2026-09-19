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
    }
  ]
} satisfies RouteConfigsTable;
