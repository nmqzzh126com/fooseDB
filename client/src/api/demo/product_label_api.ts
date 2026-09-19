/**
 * product_label 表业务 API —— 基于 foose_factory 自动生成
 *
 * 用法（组件里）：
 *   import { useProductLabel } from "@/api/demo/product_label_api";
 *   const { productLabelDbDataList, productLabelDbLoading, productLabelDbList } = useProductLabel();
 */
import type { FooseRow, FoosePatch } from "@/api/foose_db";
import { createUseFoose, createFooseApi } from "../foose_db_factory";

/* 1. 业务类型（product_label 表实际字段） */
export interface ProductLabelRow extends FooseRow {
  my_id: string;
  product_id: number;
  title: string;
  sort?: number;
  flag?: number;
}

export type ProductLabelInput = FoosePatch<ProductLabelRow>;

/* 2. 表配置常量 —— table / prefix / defaultPageSize 三处共用 */
const CONFIG = {
  table: "product_label",
  prefix: "productLabel",
  defaultPageSize: 10
} as const;

/* 3. 响应式 composable（组件 setup 里用） */
export const useProductLabel = createUseFoose<
  ProductLabelRow,
  typeof CONFIG.prefix
>(CONFIG);
// 返回 { productLabelDbDataList, productLabelCurrentRow, productLabelDbLoading, productLabelDbError,
//        productLabelDbPage, productLabelDbPageSize, productLabelDbTotal,
//        productLabelDbList, productLabelDbGet, productLabelDbGetBy,
//        productLabelDbCreate, productLabelDbCreates, productLabelDbUpdate, productLabelDbUpdates,
//        productLabelDbRemove, productLabelDbRemoves, productLabelDbRemovesByFilter, productLabelDbReset }

/* 4. 纯函数 API（store / router guard 里用） */
const _api = createFooseApi<ProductLabelRow>(CONFIG);

export const productLabelList = _api.list;
export const productLabelGet = _api.get;
export const productLabelGetBy = _api.getBy;
export const productLabelCreate = _api.create;
export const productLabelCreates = _api.creates;
export const productLabelUpdate = _api.update;
export const productLabelUpdates = _api.updates;
export const productLabelRemove = _api.remove;
export const productLabelRemoves = _api.removes;
export const productLabelRemovesByFilter = _api.removeByFilter;
