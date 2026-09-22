const Layout = () => import("@/layout/index.vue");
export default {
  path: "/foose",
  name: "Foose",
  component: Layout,
  redirect: "/foose/users",
  meta: {
    icon: "ep/home-filled",
    title: "用户管理",
    rank: 3
  },
  children: [
    {
      path: "/foose/users",
      name: "FooseUsers",
      component: () => import("@/views/foose_db/users/index.vue"),
      meta: {
        title: "管理用户",
        showLink: true
      }
    },
    {
      path: "/foose/roles",
      name: "FooseRoles",
      component: () => import("@/views/foose_db/roles/index.vue"),
      meta: {
        title: "管理角色",
        showLink: true
      }
    }
  ]
} satisfies RouteConfigsTable;
