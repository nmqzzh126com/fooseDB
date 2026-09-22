/**
 * 用户 CRUD（替代旧 routes/users.ts，**URL 路径完全不变**：仍是 /api/users，方案 A 不加版本号）。
 *
 * 改动点（结构升级）：
 *   1. 顶层不再直接 getDb().prepare(...) —— 改为每个 handler 调用 usersService 的 Promise API
 *   2. 所有 SQL 下沉到 services/users.service.ts（路由层不再写 SQL）
 *   3. 业务错误（404 用户不存在 / 409 用户名冲突）通过 BusinessError 抛出，路由层统一转状态码
 *   4. Schema 从 inline 抽取到 schemas/users.schema.ts
 */

import { type FastifyPluginAsync } from "fastify";
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  batchUpdateUsers,
  type CreateUserInput,
  type UpdateUserInput
} from "../../services/users.service.js";
import {
  CreateUserBodySchema,
  UpdateUserBodySchema,
  UserIdParamSchema
} from "../../schemas/users.schema.js";
import { BusinessError } from "../../utils/errors.js";
import { requireAdminPanel, requireSystemAdminForManage } from "../../services/config.service.js";

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  // GET  /api/users      列表 — 仅 system admin 可见（毕竟里面含 object_id 绑定信息）
  // 支持 query 过滤：?object_id=5&flag=0&page=1&pageSize=20&username=test&nickname=张
  fastify.get<{ Querystring: { object_id?: string; flag?: string; page?: string; pageSize?: string; username?: string; nickname?: string } }>(
    "/api/users",
    async function (request, reply) {
      try {
        await requireSystemAdminForManage({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        const { object_id, flag, page, pageSize, username, nickname } = request.query;
        const filter: { object_id?: number; flag?: number; username?: string; nickname?: string } = {};
        if (object_id !== undefined && object_id !== "") filter.object_id = Number(object_id);
        if (flag !== undefined && flag !== "") filter.flag = Number(flag);
        if (username) filter.username = username;
        if (nickname) filter.nickname = nickname;
        const opts = {
          page: page ? Number(page) : undefined,
          pageSize: pageSize ? Number(pageSize) : undefined
        };
        return await listUsers(
          Object.keys(filter).length ? filter : undefined,
          opts.page || opts.pageSize ? opts : undefined
        );
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // GET  /api/users/:id  详情
  fastify.get<{ Params: { id: string } }>(
    "/api/users/:id",
    { schema: { params: UserIdParamSchema } },
    async function (request, reply) {
      try {
        await requireSystemAdminForManage({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        return await getUser(Number(request.params.id));
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // POST /api/users      新建 —— 仅 system admin
  fastify.post<{ Body: CreateUserInput }>(
    "/api/users",
    { schema: { body: CreateUserBodySchema } },
    async function (request, reply) {
      try {
        await requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        const row = await createUser(request.body);
        return row;
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // PATCH /api/users/:id 更新 —— 仅 system admin
  fastify.patch<{ Params: { id: string }; Body: UpdateUserInput }>(
    "/api/users/:id",
    { schema: { params: UserIdParamSchema, body: UpdateUserBodySchema } },
    async function (request, reply) {
      try {
        await requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        // 把整个 body 传给 service，service 里动态拼 SET
        return await updateUser(Number(request.params.id), request.body);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // DELETE /api/users/:id —— 仅 system admin
  fastify.delete<{ Params: { id: string } }>(
    "/api/users/:id",
    { schema: { params: UserIdParamSchema } },
    async function (request, reply) {
      try {
        await requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        await deleteUser(Number(request.params.id));
        return { ok: true };
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );

  // POST /api/users/batch-update — 批量修改 flag/密码
  fastify.post<{ Body: { userIds: number[]; flag?: number; password?: string } }>(
    "/api/users/batch-update",
    {
      schema: {
        body: {
          type: "object",
          required: ["userIds"],
          additionalProperties: false,
          properties: {
            userIds: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 200 },
            flag: { type: "integer" },
            password: { type: "string", minLength: 0 }
          }
        }
      }
    },
    async function (request, reply) {
      try {
        await requireAdminPanel({
          token: request.authContext.bearerToken,
          fingerprint: request.authContext.fingerprint
        });
        return await batchUpdateUsers(request.body);
      } catch (e) {
        if (e instanceof BusinessError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    }
  );
};

export default plugin;
