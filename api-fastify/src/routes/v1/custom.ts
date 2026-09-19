/**
 * 自定义 SQL 执行路由 —— POST /api/custom/:name
 *
 * 设计：客户端**绝对不能直接传任意 SQL**；管理员需先在 app.db 的 query_template 表
 * 预置一条「SQL 模板 + 参数契约 + 访问控制 + 资源限制」配置行（见 /api/config/query-templates），
 * 调用方仅传 `{ params }`，Service 层按六层护栏安全执行。
 *
 * =============================================================================
 * 请求协议
 * =============================================================================
 *   POST /api/custom/<templateName>
 *
 *   Header：
 *     Content-Type: application/json
 *     Authorization: Bearer <accessToken>   — 模板/项目需要登录时必填
 *     X-Client-Id: <string>                — 可选，用于 JWT 客户端指纹绑定（缺省用 User-Agent 计算）
 *     Origin: <前端域名>                   — CORS 插件自动按「模板→object→datasource」
 *                                              的 CORS 策略返回 Allow 头
 *
 *   Body：
 *     {
 *       "params": {                          // 命名占位模式（:param 写法时用这个，推荐）
 *          "userId": 100,
 *          "status": "paid",
 *          "title": "Apple"
 *       }
 *       // 或者（匿名 ? 占位模式）
 *       // "params": [100, "paid", "Apple"]
 *     }
 *
 *   空参数：传 {} → 等价于 params={}（占位符数量为 0 的模板可直接省略 params 字段）
 *
 * =============================================================================
 * 返回协议
 * =============================================================================
 *   200 OK（成功）：
 *     {
 *       "template":   "orders_of_user",      // 调用的模板名，便于联调
 *       "columns":    ["id", "user_id", "title", "status", "amount"],  // 列名，按 SQL SELECT 顺序
 *       "rows": [                          // 结果数组
 *          { "id": 101, "user_id": 100, "title": "...", "status": "paid", "amount": 299 },
 *          ...
 *       ],
 *       "rowCount":   50,                   // rows.length；与 rows_limit 比较可判断是否被截断
 *       "durationMs": 12                    // 服务端从 executeCustomQuery 入口到结束的毫秒耗时
 *     }
 *
 *   400 Bad Request（执行前护栏拦截，语义化错误码）：
 *     { "error": "SQL validation failed | SQL 校验失败: forbidden keyword: INSERT" }
 *     { "error": "missing required param: userId" }
 *     { "error": "param uid must be number" }
 *     { "error": "expected 3 positional args, got 2" }
 *
 *   401 Unauthorized（认证失败）：
 *     { "error": "missing bearer token | 缺少 Bearer token (object.auth_required=1)" }
 *     { "error": "login required (role_required=user | 需要至少 user 角色) | 需要登录（role_required=user | 需要至少 user 角色）" }
 *     { "error": "invalid token signature | token 签名无效" }                    // JWT 验签失败
 *     { "error": "token client mismatch | token 客户端指纹不匹配" }                      // 指纹不匹配（token 被拷到别的设备）
 *
 *   403 Forbidden（角色/资源黑名单）：
 *     { "error": "role_required=admin | 需要系统管理员角色" }
 *     { "error": "SQL validation failed | SQL 校验失败: table \"users\" is guarded ..." }
 *
 *   404 Not Found | 未找到：
 *     { "error": "template not found | 模板不存在: orders_of_..." }           // 模板名不存在
 *     { "error": "template disabled: orders_of_..." }           // enabled=0
 *
 *   500 Internal Server Error：
 *     { "error": "template references undeclared datasource" }   // object 的 db_* 配置无法连接
 *     { "error": "...SQL 语法错误/SQLite 报错..." }              // 执行期 DB 抛错，原样前 500 字返回
 *
 *   503 Service Unavailable：
 *     { "error": "custom SQL is disabled for object \"...\" (custom_sql_enabled=0)" }
 *
 * =============================================================================
 * 六层护栏（按执行顺序命中即返回，不写审计日志以外的任何副作用）
 * =============================================================================
 *   1 项目级开关     object.custom_sql_enabled（每行项目独立配置，默认 0 关闭）；关闭 → 503
 *   2 元数据校验     enabled=1 + 模板关联 object 存在 + object 的 db_* 数据源可连接
 *   3 SELECT-only    必须 SELECT / WITH CTE 开头；禁止 ; 多语句；
 *                    关键字黑名单（INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE
 *                                PRAGMA/ATTACH/GRANT/COMMIT/ROLLBACK/LOAD_EXTENSION
 *                                sqlite_master/information_schema/mysql.sys...）；
 *                    表黑名单：object / object_table / users / query_template / custom_query_log
 *   4 强制参数化     :name → 统一转 ?；buildArgs 做 required/type(4 种)/default 强校验；
 *                    所有值永远 PreparedStatement 占位，不拼接 SQL 字面量
 *   5 认证+角色      继承 object.auth_required=1 的 Bearer token；+ role_required
 *                      public：匿名可调用（但上面的 auth_required=1 覆盖）
 *                      user  ：必须登录（任意用户名）
 *                      admin ：username == "admin"（users 表当前无独立 role 列）
 *   6 资源+审计      rows_limit（默认 1000）在外层包一层 LIMIT；
 *                    每次执行写 custom_query_log（成功失败都写）：
 *                      template_id / caller_user / caller_ip /
 *                      params_json（password/secret/token/credit_card/... 自动 *** 脱敏）/
 *                      row_count / duration_ms / status_code / error_msg（前 500 字）
 *
 * =============================================================================
 * 常见工作流示例（curl）
 * =============================================================================
 *
 *   # 1）管理员创建一条「按 user_id + status 查询订单」模板
 *   curl -X POST http://127.0.0.1:8858/api/config/query-templates \
 *        -H "Content-Type: application/json" -d '{
 *     "object_id": 1,
 *     "name": "orders_of_user",
 *     "description": "指定用户按状态查订单（仅返回 100 条）",
 *     "sql_text": "SELECT id, title, status, price, created_at
 *                    FROM posts
 *                   WHERE user_id = :userId AND status = :status
 *                   ORDER BY id DESC",
 *     "params_schema": "{\"userId\":{\"type\":\"integer\",\"required\":true,\"desc\":\"用户ID\"},
 *                        \"status\":{\"type\":\"string\",\"required\":false,\"default\":\"paid\",\"desc\":\"订单状态\"}}",
 *     "role_required": "public",
 *     "rows_limit": 100,
 *     "timeout_ms": 1000,
 *     "enabled": 1
 *   }'
 *   # → 201 { id:15, name:"orders_of_user", ... }
 *
 *   # 2）前端调用（命名占位）
 *   curl -X POST http://127.0.0.1:8858/api/custom/orders_of_user \
 *        -H "Content-Type: application/json" -d '{"params":{"userId":1}}'
 *   # → status 默认填 "paid"（required=false + default 生效）；返回 rows
 *
 *   # 3）需要登录的受保护接口（auth_required=1 或 role_required=user | 需要至少 user 角色）
 *   curl -X POST http://127.0.0.1:8858/api/custom/secret_report \
 *        -H "Content-Type: application/json" \
 *        -H "Authorization: Bearer <access_token>" \
 *        -H "X-Client-Id: device-xyz" \
 *        -d '{"params":{"q":"abc"}}'
 */

import { type FastifyPluginAsync } from "fastify";
import { BusinessError } from "../../utils/errors.js";
import { executeCustomQuery, type CustomCaller } from "../../services/custom-sql.js";

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.post<{
    Params: { name: string };
    Body: { params?: unknown };
  }>("/api/custom/:name", async (request, reply) => {
    try {
      // 复用 auth-context 插件的请求级懒缓存：fingerprint/bearerToken 同请求只计算一次
      const caller: CustomCaller = {
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint,
        ip: request.ip
      };
      const body = request.body ?? {};
      const result = await executeCustomQuery(request.params.name, body.params ?? {}, caller);
      return reply.send(result);
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });
};

export default plugin;
