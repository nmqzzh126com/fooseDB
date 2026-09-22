/**
 * foose_role_user 表业务 API
 */
import type { FooseRow } from "@/api/foose_db";
import { createUseFoose } from "@/api/foose_db";
import { importFooseClient, DEFAULT_OBJECT_NAME } from "@/api/foose_base";

// ===== 业务类型 =====
/** 行类型（来自 foose_role_user 表实际列） */
export interface FooseRoleUserRow extends FooseRow {
  id: number;
  role_id: number;
  user_id: number;
}

// ===== 表配置常量 =====
export const CONFIG = {
  object: DEFAULT_OBJECT_NAME,
  table: "foose_role_user",
  defaultPageSize: 10
} as const;

// ===== 响应式 composable（组件用）=====
export const useRoleUser = createUseFoose<FooseRoleUserRow>(
  CONFIG,
  importFooseClient
);
