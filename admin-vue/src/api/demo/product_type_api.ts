/**
 * foose_product_type 表 — 业务 API
 */
import type { FooseRow } from "@fooseDB/sdk";
import { defineFooseTable } from "./foose_base";

export interface ProductTypeRow extends FooseRow {
  id: number;
  type_name: string;
  flag?: number;
}

export const { composable: useProductType, CONFIG } = defineFooseTable<ProductTypeRow>({
  table: "foose_product_type"
});
