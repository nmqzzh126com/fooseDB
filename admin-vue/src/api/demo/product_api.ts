/**
 * foose_product 表 — 业务 API 
 */
import type { FooseRow } from "@fooseDB/sdk";
import { defineFooseTable } from "./foose_base";

export interface ProductRow extends FooseRow {
  id: number;
  product_type_id: number;
  product_name: string;
  product_count: number;
  product_desc?: string;
  create_time?: number;
  update_time?: number;
  delete_time?: number;
}

export const { composable: useProduct, CONFIG } = defineFooseTable<ProductRow>({
  table: "foose_product",
  autoCreateTimeStampField: "create_time",
  autoUpdateTimeStampField: "update_time"
});
