/**
 * foose_product 表业务 API
 *   // 组件里直接解构（见文件底部完整示例）
 *   const { listResult, loading, getPageList, create, remove } = useProduct();
 */
import type { FooseRow } from "@/api/foose_db";
import { createUseFoose } from "@/api/foose_db";
import { importFooseClient, DEFAULT_OBJECT_NAME } from "@/api/foose_base";

// ===== 业务类型 =====
/** 行类型（来自 foose_product 表实际列） */
export interface ProductRow extends FooseRow {
  product_type_id: number;
  product_name: string;
  product_count: number;
  product_desc?: string;
  create_time?: number;
  update_time?: number;
  delete_time?: number;
}

// ===== 表配置常量 =====
export const CONFIG = {
  object: DEFAULT_OBJECT_NAME,
  table: "foose_product",
  defaultPageSize: 10
} as const;

// ===== 响应式 composable（组件用）=====
export const useProduct = createUseFoose<ProductRow>(CONFIG, importFooseClient);

/* ============================================================
 * 使用示例（Vue 组件 setup 内）
 * ============================================================
 *
 * import { useProduct } from "@/api/demo/product_api";
 * import type { FooseListParams } from "@/api/foose_db";
 *
 * // ① 解构：dataList / loading / error / page / pageSize / total 都是 ref
 * //    list / get / create / update / remove 等都是 async 方法
 * const {
 *   dataList,      // Ref<ProductRow[]>   — 列表数据（自动被 list/create/update/remove 同步）
 *   loading,       // Ref<boolean>        — 当前是否正在请求
 *   error,         // Ref<string | null>   — 最近一次请求的错误信息
 *   page,          // Ref<number>         — 当前页码
 *   pageSize,      // Ref<number>         — 每页大小
 *   total,         // Ref<number>         — 总条数
 *   list,          // (params?) => Promise<FoosePage<ProductRow>>
 *   get,           // (id, fields?, join?) => Promise<ProductRow>
 *   create,        // (payload) => Promise<ProductRow>
 *   creates,       // (payloads[], showSql?) => Promise<{ ok, created, rows }>
 *   update,        // (id, payload) => Promise<ProductRow>
 *   updates,       // (rows[], showSql?) => Promise<{ ok, updated, rows }>
 *   remove,        // (id) => Promise<unknown>
 *   removes,       // (ids[], showSql?) => Promise<{ ok, deleted }>
 *   removesByFilter // (filter, showSql?) => Promise<{ ok, deleted }>
 * } = useProduct();
 *
 * // ② 查询分页列表 —— loading / error / page / pageSize / total 自动更新
 * await list({ page: 1, pageSize: 10 });
 *
 * // ③ 带筛选 + 关联查询
 * const params: FooseListParams = {
 *   page: 1,
 *   pageSize: 20,
 *   orderBy: "id:desc",
 *   filter: { product_type_id: 2 },
 *   joins: [
 *     { table: "foose_product_type", as: "pt", type: "one",
 *       on: { local: "product_type_id", foreign: "id" } }
 *   ]
 * };
 * await list(params);
 * // 之后 dataList.value 里的每行就会带 pt 关联对象
 *
 * // ④ 新建单行 —— composable 自动 unshift 到 dataList + total++
 * const row = await create({
 *   product_name: "新商品",
 *   product_type_id: 1,
 *   product_count: 50
 * });
 *
 * // ⑤ 批量新建
 * const res = await creates([
 *   { product_name: "批量1", product_type_id: 2, product_count: 10 },
 *   { product_name: "批量2", product_type_id: 3, product_count: 20 }
 * ]);
 * console.log(res.created, res.rows);
 *
 * // ⑥ 按 id 更新 —— composable 自动替换 dataList 中的对应行
 * await update(1, { product_count: 999 });
 *
 * // ⑦ 按 id 删除 —— composable 自动从 dataList 过滤掉 + total--
 * await remove(1);
 *
 * // ⑧ UI 里直接绑定 ref（无需 .value）
 * // <el-table :data="dataList" v-loading="loading" />
 * // <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total" />
 * // <el-text v-if="error" type="danger">{{ error }}</el-text>
 * ============================================================ */
