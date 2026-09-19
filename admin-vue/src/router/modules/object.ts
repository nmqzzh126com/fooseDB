export default {
  path: "/object",
  redirect: "/object/index",
  meta: {
    icon: "ri/ubuntu-fill",
    title: '接口管理222',
    rank: 50
  },
  children: [
    {
      path: "/object/index",
      name: "ObjectIndex",
      component: () => import("@/views/object/index.vue"),
      meta: {
        title: '接口管理222'
      }
    },
    {
      path: "/object/test-api",
      name: "ObjectTestApi",
      component: () => import("@/views/object/test_api.vue"),
      meta: {
        title: '接口测试',
        showLink: false
      }
    }

  ]
} satisfies RouteConfigsTable;
