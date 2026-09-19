/**
 * Product 表业务 API —— 基于 foose_factory 自动生成
 *
 * 用法（组件里）：
 *   import { useProduct } from "@/api/demo/product_api";
 *   const { productDbDataList, productDbLoading, productDbList } = useProduct();
 *   await productDbList({ page: 1, pageSize: 20 });
 */
import type { FooseRow, FoosePatch } from "@/api/foose_db";
import { createUseFoose, createFooseApi } from "./foose_factory";

/* 1. 业务类型 */
export interface ProductRow extends FooseRow {
  product_type_id: number;
  product_name: string;
  product_count: number;
  product_desc?: string;
  create_time?: number;
  update_time?: number;
  delete_time?: number;
}

export type ProductInput = FoosePatch<ProductRow>;

/* 2. 表配置常量 —— table / prefix / defaultPageSize 三处共用 */
const CONFIG = {
  table: "product",
  prefix: "product",
  defaultPageSize: 10
} as const;

/* 3. 响应式 composable（组件 setup 里用） */
export const useProduct = createUseFoose<ProductRow, typeof CONFIG.prefix>(CONFIG);
// 返回 { productDbDataList, productCurrentRow, productDbLoading, productDbError,
//        productDbPage, productDbPageSize, productDbTotal,
//        productDbList, productDbGet, productDbGetBy,
//        productDbCreate, productDbCreates, productDbUpdate, productDbUpdates,
//        productDbRemove, productDbRemoves, productDbRemovesByFilter, productDbReset }

/* 4. 纯函数 API（store / router guard 里用） */
const _api = createFooseApi<ProductRow>(CONFIG);

export const productList = _api.list;
export const productGet = _api.get;
export const productGetBy = _api.getBy;
export const productCreate = _api.create;
export const productCreates = _api.creates;
export const productUpdate = _api.update;
export const productUpdates = _api.updates;
export const productRemove = _api.remove;
export const productRemoves = _api.removes;
export const productRemovesByFilter = _api.removeByFilter;

