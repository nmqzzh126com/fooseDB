/**
 * product_type 表业务 API —— 基于 foose_factory 自动生成
 */
import type { FooseRow, FoosePatch } from "@/api/foose_db";
import { createUseFoose, createFooseApi } from "./foose_factory";

/* 1. 业务类型 */
export interface ProductTypeRow extends FooseRow {
  id: number;
  type_name: string;
  flag?: number;
}
/* 2. 表配置常量 */
const CONFIG = {
  table: "product_type",
  prefix: "productType",
  defaultPageSize: 10
} as const;
/** 3. 业务类型输入参数 */
export type ProductTypeInput = FoosePatch<ProductTypeRow>;
/* 3. 响应式 composable */
export const useProductType = createUseFoose<ProductTypeRow, typeof CONFIG.prefix>(CONFIG);
//返回 { productTypeDbDataList, productTypeCurrentRow, productTypeDbLoading, productTypeDbError,
//        productTypeDbPage, productTypeDbPageSize, productTypeDbTotal,
//        productTypeDbList, productTypeDbGet, productTypeDbGetBy,
//        productTypeDbCreate, productTypeDbCreates, productTypeDbUpdate, productTypeDbUpdates,
//        productTypeDbRemove, productTypeDbRemoves, productTypeDbRemovesByFilter, productTypeDbReset }

/* 4. 纯函数 API */
const _api = createFooseApi<ProductTypeRow>(CONFIG);

export const productTypeList = _api.list;
export const productTypeGet = _api.get;
export const productTypeGetBy = _api.getBy;
export const productTypeCreate = _api.create;
export const productTypeCreates = _api.creates;
export const productTypeUpdate = _api.update;
export const productTypeUpdates = _api.updates;
export const productTypeRemove = _api.remove;
export const productTypeRemoves = _api.removes;
export const productTypeRemovesByFilter = _api.removeByFilter;
