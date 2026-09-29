/**
 * foose_product 表业务 API
 */
import type { FooseRow } from "@/api/foose_db";
import { createUseFoose } from "@/api/foose_db";
import { importFooseClient, DEFAULT_OBJECT_NAME } from "./foose_base";

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
  table: "foose_product", //接口对应数据中的表名
  defaultPageSize: 10 //默认分页大小
} as const;

// ===== 响应式 composable（组件用）=====
export const useProduct = createUseFoose<ProductRow>(CONFIG, importFooseClient);
