/**
 * /api/config/query-templates — 自定义 SQL 模板管理（管理端配置接口）。
 *
 * 设计思想：绝对禁止客户端直接传任意 SQL 执行；管理员在 app.db 里预置一条
 * 「SQL 模板 + 参数契约 + 访问控制 + 资源限制」的配置行，前端只通过
 * POST /api/custom/:name 传参数，Service 层按六层护栏安全执行（见 routes/v1/custom.ts）。
 *
 * =============================================================================
 * 字段总览（Body / 返回行）
 * =============================================================================
 *   字段名          必填    类型              说明 & 默认值
 *   object_id       是      integer           绑定的 object.id（确定走哪个 datasource + 是否继承 auth_required）
 *   name            是      identifier<64     调用名：POST /api/custom/<name>，全局 UNIQUE
 *   description     否      string<500        模板中文说明
 *   sql_text        是      string            SQL 本体；允许 SELECT / WITH CTE；参数用 :param_name 占位；
 *                                               占位符也可写成 ?（位置数组传参），但建议统一用命名占位
 *   params_schema   否      string(JSON) 或 null
 *                                    JSON 结构：
 *                                      {
 *                                        "<paramName>": {
 *                                          "type": "string" | "number" | "integer" | "boolean",
 *                                          "required": true | false,      // 缺省 true
 *                                          "default": <any>,              // required=false 时生效
 *                                          "desc": "<中文说明>"           // 可选文档字段，运行时忽略
 *                                        },
 *                                        ...
 *                                      }
 *                                    传 null / 空字符串 → 运行时从 sql_text 抽取 :name 占位自动生成
 *                                      required=true, type=string 的 schema
 *   role_required   否      enum(public|user|admin)  默认 "public"
 *                                    public：匿名可调用（但仍受 object.auth_required=1 的 token 约束）
 *                                    user  ：必须登录（any user）
 *                                    admin ：必须 username == "admin"（users 表目前无 role 列，用 username 判定）
 *   rows_limit      否      1..100000         自动在外层套 LIMIT 的上限，默认 1000；防止 SQL 没写 LIMIT 拖出大表
 *   timeout_ms      否      100..60000        查询执行软超时（毫秒），默认 3000；跨方言扩展预留字段
 *   enabled         否      0 / 1             1=启用（默认），0=调用时 404 "template disabled"
 *
 * =============================================================================
 * 接口清单
 * =============================================================================
 *   GET    /api/config/query-templates
 *     → 200 [{id,object_id,name,description,sql_text,params_schema,role_required,
 *             rows_limit,timeout_ms,enabled,created_at}, ...]  按 id DESC
 *
 *   GET    /api/config/query-templates/:id
 *     → 200  单个模板完整行
 *     → 404  "template not found | 模板不存在: <id>"
 *
 *   POST   /api/config/query-templates
 *     Body（见上方字段总览 + CreateQueryTemplateSchema 强校验）
 *     → 201  新建行
 *     → 400  sql_text 非 SELECT-only（含具体原因：forbidden keyword / guarded table / multi-statement）
 *     → 400  params_schema 不是合法 JSON
 *     → 404  object_id 对应的项目不存在
 *     → 409  name 全局冲突（UNIQUE）
 *
 *   PUT    /api/config/query-templates/:id
 *     Body：字段全部可选
 *     → 200  更新后行
 *     → 400  sql_text 变更时重新做 SELECT-only 校验，失败返回原因
 *     → 400  params_schema JSON 非法
 *     → 409  name 冲突
 *     → 404  模板不存在
 *
 *   DELETE /api/config/query-templates/:id
 *     → 200  { ok: true }  （SQLite FOREIGN KEYS=ON，自动级联删 custom_query_log）
 *     → 404  模板不存在
 *
 * 执行模板：POST /api/custom/:name（见 routes/v1/custom.ts）
 */

import { type FastifyPluginAsync } from "fastify";
import { BusinessError } from "../../utils/errors.js";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  type CreateTemplateInput,
  type UpdateTemplateInput
} from "../../services/query-template.service.js";
import { requireSystemAdminForManage, requireAdminPanel } from "../../services/config.service.js";
import {
  CreateQueryTemplateSchema,
  UpdateQueryTemplateSchema
} from "../../schemas/custom-sql.schema.js";

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  // GET 列表：仅 system admin 可读
  fastify.get("/api/config/query-templates", async (request, reply) => {
    try {
      await requireSystemAdminForManage({
        token: request.authContext.bearerToken,
        fingerprint: request.authContext.fingerprint
      });
      return listTemplates();
    } catch (e) {
      if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  fastify.get<{ Params: { id: string } }>(
    "/api/config/query-templates/:id",
    async (request, reply) => {
      try {
        await requireSystemAdminForManage({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        return getTemplate(Number(request.params.id));
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  fastify.post<{ Body: CreateTemplateInput }>(
    "/api/config/query-templates",
    { schema: { body: CreateQueryTemplateSchema as never } },
    async (request, reply) => {
      try {
        await requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        return reply.code(201).send(createTemplate(request.body as CreateTemplateInput));
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  fastify.put<{ Params: { id: string }; Body: UpdateTemplateInput }>(
    "/api/config/query-templates/:id",
    { schema: { body: UpdateQueryTemplateSchema as never } },
    async (request, reply) => {
      try {
        await requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        return updateTemplate(Number(request.params.id), request.body);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/config/query-templates/:id",
    async (request, reply) => {
      try {
        await requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        deleteTemplate(Number(request.params.id));
        return { ok: true };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );
};

export default plugin;
