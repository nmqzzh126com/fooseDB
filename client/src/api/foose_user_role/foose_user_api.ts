/**
 * foose_user 表业务 API
 */
import type { FooseRow } from "@/api/foose_db";
import { createUseFoose } from "@/api/foose_db";
import { importFooseClient, DEFAULT_OBJECT_NAME } from "@/api/foose_base";

// ===== 业务类型 =====
/** 行类型（来自 foose_user 表实际列） */
export interface FooseUserRow extends FooseRow {
  id: number;
  username: string;
  nickname?: string;
  password: string;
  //roles?: string;
  //token_version?: number;
  extended?: string;
  avatar?: string;
  permissions?: string;
  email?: string;
  phone?: string;
  flag?: number;
  create_at?: number;
}

// ===== 表配置常量 =====
export const CONFIG = {
  object: DEFAULT_OBJECT_NAME,
  table: "foose_users",
  defaultPageSize: 10
} as const;

// ===== 响应式 composable（组件用）=====
export const useUser = createUseFoose<FooseUserRow>(CONFIG, importFooseClient);

/* ============================================================
 * 使用示例（Vue 组件 setup 内）
 * ============================================================
 *
 * import { useUser } from "@/api/foose_user_role/foose_user_api";
 * import type { FooseListParams } from "@/api/foose_db";
 *
 * // ① 解构：dataList / loading / error / page / pageSize / total 都是 ref
 * //    list / get / create / update / remove 等都是 async 方法
 * const {
 *   dataList,      // Ref<FooseUserRow[]>   — 列表数据（自动被 list/create/update/remove 同步）
 *   loading,       // Ref<boolean>        — 当前是否正在请求
 *   error,         // Ref<string | null>   — 最近一次请求的错误信息
 *   page,          // Ref<number>         — 当前页码
 *   pageSize,      // Ref<number>         — 每页大小
 *   total,         // Ref<number>         — 总条数
 *   list,          // (params?) => Promise<FoosePage<FooseUserRow>>
 *   get,           // (id, fields?, join?) => Promise<FooseUserRow>
 *   create,        // (payload) => Promise<FooseUserRow>
 *   creates,       // (payloads[], showSql?) => Promise<{ ok, created, rows }>
 *   update,        // (id, payload) => Promise<FooseUserRow>
 *   updates,       // (rows[], showSql?) => Promise<{ ok, updated, rows }>
 *   remove,        // (id) => Promise<unknown>
 *   removes,       // (ids[], showSql?) => Promise<{ ok, deleted }>
 *   removesByFilter // (filter, showSql?) => Promise<{ ok, deleted }>
 * } = useUser();
 *
 * // ② 查询分页列表 —— loading / error / page / pageSize / total 自动更新
 * await list({ page: 1, pageSize: 10 });
 *
 * // ③ 带筛选 + 关联查询
 * const params: FooseListParams = {
 *   page: 1,
 *   pageSize: 20,
 *   orderBy: "id:desc",
 *   filter: { username: "admin" },
 *   joins: [
 *     { table: "foose_roles", as: "rt", type: "one",
 *       on: { local: "role", foreign: "id" } }
 *   ]
 * };
 * await list(params);
 * // 之后 dataList.value 里的每行就会带 pt 关联对象
 *
 * // ④ 新建单行 —— composable 自动 unshift 到 dataList + total++
 * const row = await create({
 *   username: "新用户",
 *   role: 1
 * });
 *
 * // ⑤ 批量新建
 * const res = await creates([
 *   { username: "批量1", role: 2 },
 *   { username: "批量2", role: 3 }
 * ]);
 * console.log(res.created, res.rows);
 *
 * // ⑥ 按 id 更新 —— composable 自动替换 dataList 中的对应行
 * await update(1, { role: 4 });
 *
 * // ⑦ 按 id 删除 —— composable 自动从 dataList 过滤掉 + total--
 * await remove(1);
 *
 * // ⑧ UI 里直接绑定 ref（无需 .value）
 * // <el-table :data="dataList" v-loading="loading" />
 * // <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total" />
 * // <el-text v-if="error" type="danger">{{ error }}</el-text>
 * ============================================================ */
