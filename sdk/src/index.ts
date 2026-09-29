/**
 * @fooseDB/sdk — barrel export
 *
 * 使用：
 *   import { createFooseClient, useFoose, FooseTools } from "@fooseDB/sdk";
 *
 * 依赖：axios（必须）、Vue 3（peer，仅 useFoose / createUseFoose 等 L3/L4 组合式 API 需要）
 */

// —— L1-L4 SDK 核心 ——
export {
  createFooseClient,
  useFoose,
  createUseFoose,
  createUseFooseTable,
  createFooseApi,
  defaultFooseStorage,
  derivePrefix,
  // 类型
  type FooseClient,
  type FooseEnvelope,
  type FooseAggregate,
  type FooseFilter,
  type FooseGroup,
  type FooseJoin,
  type FooseListParams,
  type FoosePage,
  type FooseRow,
  type FoosePatch,
  type RoleBrief,
  type CreateFooseOptions,
  type FooseStorage,
  type FooseComposable,
  type FooseApi,
  type FooseTableConfig,
  type DerivePrefixType,
  type CleanComposable,
  type Expand,
  type FooseLastRequest
} from "./foose_db";

// —— L6 工具类 ——
export { FooseTools } from "./foose_db_tools";
