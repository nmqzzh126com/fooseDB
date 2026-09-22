/**
 * foose_role 表业务 API
 */
import type { FooseRow } from "@/api/foose_db";
import { createUseFoose } from "@/api/foose_db";
import { importFooseClient, DEFAULT_OBJECT_NAME } from "@/api/foose_base";

// ===== 业务类型 =====
/** 行类型（来自 foose_role 表实际列） */
export interface FooseRoleRow extends FooseRow {
  id: number;
  role_name: string;
  role_desc?: string;
  flag?: number;
}

// ===== 表配置常量 =====
export const CONFIG = {
  object: DEFAULT_OBJECT_NAME,
  table: "foose_roles",
  defaultPageSize: 10
} as const;

// ===== 响应式 composable（组件用）=====
export const useRole = createUseFoose<FooseRoleRow>(CONFIG, importFooseClient);
