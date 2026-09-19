import { isString, isEmpty } from "@pureadmin/utils";
import { useMultiTagsStoreHook } from "@/store/modules/multiTags";
import {
  useRouter,
  useRoute,
  type LocationQueryRaw,
  type RouteParamsRaw
} from "vue-router";

/** 动态路由配置：每个动态标签页对应一条 */
export interface DynamicTabConfig {
  /** 路由 path，如 "/welcome/object_users" */
  path: string;
  /** 路由 name，如 "ObjectUsers" */
  name: string;
  /** 标签页标题，如 "用户设置" */
  title: string;
  /** 同一路由最大打开数（默认 1） */
  dynamicLevel?: number;
}

/**
 * 通用动态标签页 hook —— 一次配置，三个函数全给你
 *
 * @example
 *   const { toTab, initToTab, getParameter, router } = useDynamicTab({
 *     path: "/welcome/object_users",
 *     name: "ObjectUsers",
 *     title: "用户设置"
 *   });
 *   toTab({ object_id: 5 }); // 打开 /welcome/object_users?object_id=5
 */
export function useDynamicTab(config: DynamicTabConfig) {
  const route = useRoute();
  const router = useRouter();
  const getParameter = isEmpty(route.params) ? route.query : route.params;

  function toTab(parameter: LocationQueryRaw | RouteParamsRaw) {
    Object.keys(parameter).forEach(param => {
      if (!isString(parameter[param])) {
        (parameter as Record<string, unknown>)[param] = String(parameter[param]);
      }
    });
    useMultiTagsStoreHook().handleTags("push", {
      path: config.path,
      name: config.name,
      query: parameter,
      meta: {
        title: config.title,
        dynamicLevel: config.dynamicLevel ?? 1
      }
    });
    router.push({ name: config.name, query: parameter });
  }

  const initToTab = () => {
    if (getParameter) toTab(getParameter);
  };

  return { toTab, initToTab, getParameter, router };
}


// ————————————————————————————————————————
// 下面是预配置好的便捷入口（保持向后兼容）
// 新增页面只需在这里加一行即可
// ————————————————————————————————————————

/** 用户设置 */
export function useTabObjectUser() {
  return useDynamicTab({
    path: "/welcome/object_users",
    name: "ObjectUsers",
    title: "用户设置"
  });
}
/** 编辑 */
export function useTabObjectEdit() {
  return useDynamicTab({
    path: "/welcome/object_edit",
    name: "ObjectEdit",
    title: "编辑"
  });
}

/** 数据表设置 */
export function useTabObjectTable() {
  return useDynamicTab({
    path: "/welcome/object_tables",
    name: "ObjectTables",
    title: "数据表设置"
  });
}
/** 角色设置 */
export function useTabRole() {
  return useDynamicTab({
    path: "/welcome/roles",
    name: "OjectRoles",
    title: "角色设置"
  });
}
 

/** 旧接口保留：useTabTestApiDetail() → toTabTestApiByQuery 系列 */
export function useTabTestApiDetail() {
  const { toTab, initToTab, getParameter, router } = useDynamicTab({
    path: "/object/test-api",
    name: "ObjectTestApi",
    title: "接口测试"
  });
  return { toTabTestApiByQuery: toTab, initToTestApiDetail: initToTab, getParameter, router };
}
