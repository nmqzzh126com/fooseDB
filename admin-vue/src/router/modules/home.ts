const Layout = () => import("@/layout/index.vue");

export default {
  path: "/",
  name: "Home",
  component: Layout,
  redirect: "/welcome",
  meta: {
    icon: "ep/home-filled",
    title: "接口管理",
    rank: 1
  },
  children: [
    {
      path: "/welcome",
      name: "Welcome",
      component: () => import("@/views/welcome/index.vue"),
      meta: {
        title: "首页",
        showLink: true
      }
    },
    {
      path: "/welcome/object_users",
      name: "ObjectUsers",
      component: () => import("@/views/welcome/object_user/index.vue"),
      meta: {
        title: "用户设置",
        showLink: false
      }
    },
    {
      path: "/welcome/object_tables",
      name: "ObjectTables",
      component: () => import("@/views/welcome/object_table/index.vue"),
      meta: {
        title: "数据表设置",
        showLink: false
      }
    },
    {
      path: "/welcome/roles",
      name: "OjectRoles",
      component: () => import("@/views/welcome/roles/index.vue"),
      meta: {
        title: "角色设置",
        showLink: false
      }
    },
    {
      path: "/welcome/object_edit",
      name: "ObjectEdit",
      component: () => import("@/views/welcome/edit.vue"),
      meta: {
        title: "编辑",
        showLink: false
      }
    }
  ]
} satisfies RouteConfigsTable;
