/**
 * foose_product_label 表 — 业务 API
 */
import type { FooseRow } from "@fooseDB/sdk";
import { defineFooseTable } from "./foose_base";

export interface ProductLabelRow extends FooseRow {
  my_id: string;
  product_id: number;
  title: string;
  sort?: number;
  flag?: number;
}

export const { composable: useProductLabel, CONFIG } = defineFooseTable<ProductLabelRow>({
  table: "foose_product_label"
});
