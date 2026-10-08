/**
 * FoosDB 通用客户端 SDK — barrel re-export
 *
 * 2026-09-26: 从本地实现切换为官方 @fooseDB/sdk 包。
 * 所有现有 import 路径（from "@/api/foose_db"）保持不变。
 */
//export * from "@fooseDB/sdk";
export * from "../../../api-fastify/sdk/src/foose_db";

// 项目内工具函数：客户端指纹生成（SDK 没有这个，因为它是业务层概念）
//export { getClientId } from "@/utils/foose_db_http";
