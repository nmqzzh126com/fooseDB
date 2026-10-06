/**
 * 文件上传/下载/删除/列表 路由 —— /api/files/:object/...
 *
 * 端点清单：
 *   POST   /api/files/:object/:foldername           → 上传文件（multipart/form-data，支持多文件）
 *   GET    /api/files/:object/:info/:file_id        → 文件元数据 + 下载 URL（JSON）
 *   GET    /api/files/:object/:file_id              → 下载文件（支持 Range 断点续传）
 *   DELETE /api/files/:object/:foldername/:file_id  → 删除文件（file_id 逗号分隔支持多个）
 *   GET    /api/files/:object/:foldername/:page     → 文件列表（分页，返回元数据）
 *
 * 权限链：
 *   1. 项目存在（object.name，404）
 *   2. 项目启用（enabled=0 → 403）
 *   3. 项目级文件权限 allow_upload_file / allow_download_file / allow_delete_file / allow_list_file（403）
 *   4. auth_required=1 → Bearer token + 指纹校验（401）
 *   5. 用户→项目绑定校验（assertCallerObjectBinding）
 *
 * 文件夹名（foldername）支持最多 3 层，用 - 分隔：
 *   folder1-folder2-folder3 → 磁盘路径 folder1/folder2/folder3
 */

import { type FastifyPluginAsync } from "fastify";
import multipart from "@fastify/multipart";
import { getDb } from "../../db.js";
import { getObjectByName, assertCallerObjectBinding, type ObjectRow } from "../../services/config.service.js";
import { BusinessError } from "../../utils/errors.js";
import { verifyToken, type JwtPayload } from "../../services/auth.service.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================== 配置解析 ==============================

function parseUploadFilesCount(): number {
  const n = parseInt(process.env.UPLOAD_FILES_COUNT ?? "5", 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}
function parseUploadFileSizeBytes(): number {
  const kb = parseInt(process.env.UPLOAD_FILE_SIZE ?? "1024", 10);
  return (Number.isFinite(kb) && kb > 0 ? kb : 1024) * 1024;
}
function parseUploadFilesType(): Set<string> {
  const raw = process.env.UPLOAD_FILES_TYPE ?? "jpg,jpeg,png,pdf,docx,txt";
  return new Set(
    raw
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
function parseFilesPageSize(): number {
  const n = parseInt(process.env.FILES_PAGE_SIZE ?? "10", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
function parseDeleteFilesCount(): number {
  const n = parseInt(process.env.DELETE_FILES_COUNT ?? "5", 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** uploads 目录根路径：api-fastify/uploads/（与 db.ts 的 data/ 对齐，硬编码项目根） */
function getUploadsRoot(): string {
  const dir = path.resolve(__dirname, "..", "..", "..", "uploads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================== 文件夹名校验 ==============================

const FOLDER_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/;

function validateFoldername(folder: string): void {
  if (!FOLDER_RE.test(folder)) {
    throw new BusinessError(
      400,
      `文件夹名 "${folder}" 含非法字符（仅允许字母/数字/下划线/中划线，字母或数字开头）`
    );
  }
  const parts = folder.split("-");
  if (parts.length > 3) {
    throw new BusinessError(400, `文件夹名最多 3 层（用 - 分隔），当前 ${parts.length} 层`);
  }
  for (const p of parts) {
    if (!p) throw new BusinessError(400, "文件夹名不能有连续的中划线");
  }
}

/** foldername → 磁盘子路径（- 分隔 → path.sep 分隔） */
function foldernameToDiskPath(folder: string): string {
  return path.join(...folder.split("-"));
}

// ============================== 文件访问控制 ==============================

interface FileAccessResult {
  obj: ObjectRow;
  caller: JwtPayload | null;
}

/**
 * 文件操作权限解析（比 resolveObjectAccess 简单，不查 object_table 白名单）：
 *   1. object 存在（404）
 *   2. enabled=1（403）
 *   3. 对应 allow_*_file=1（403）
 *   4. auth_required=1 → verifyToken（401）
 *   5. assertCallerObjectBinding
 */
async function resolveFileAccess(
  objectName: string,
  fileOp: "upload" | "download" | "delete" | "list",
  auth: { token?: string; fingerprint: string }
): Promise<FileAccessResult> {
  const obj = getObjectByName(objectName);
  if (!obj) throw new BusinessError(404, `项目 "${objectName}" 不存在`);
  if (obj.enabled === 0)
    throw new BusinessError(403, `项目 "${objectName}" 已被禁用，拒绝所有请求`);

  const flagMap = {
    upload: obj.allow_upload_file,
    download: obj.allow_download_file,
    delete: obj.allow_delete_file,
    list: obj.allow_list_file
  } as const;
  if (flagMap[fileOp] === 0) {
    const label =
      fileOp === "upload" ? "上传" :
        fileOp === "download" ? "下载" :
          fileOp === "delete" ? "删除" : "列表";
    throw new BusinessError(403, `项目 "${objectName}" 未开启文件${label}权限`);
  }

  let caller: JwtPayload | null = null;
  if (obj.auth_required === 1) {
    if (!auth.token)
      throw new BusinessError(401, "缺少 Bearer token（该项目要求登录）");
    caller = await verifyToken(auth.token, auth.fingerprint);
  } else if (auth.token) {
    try {
      caller = await verifyToken(auth.token, auth.fingerprint);
    } catch {
      caller = null;
    }
  }

  assertCallerObjectBinding(caller, obj);
  return { obj, caller };
}

// ============================== 路由插件 ==============================

const plugin: FastifyPluginAsync = async (fastify): Promise<void> => {
  // 注册 multipart 插件（仅在当前插件作用域内生效）
  await fastify.register(multipart, {
    limits: {
      fileSize: parseUploadFileSizeBytes(),
      files: parseUploadFilesCount()
    }
  });

  // —— POST /api/files/:object/:foldername —— 上传文件 ——
  fastify.post<{
    Params: { object: string; foldername: string };
  }>("/api/files/:object/:foldername", async (request, reply) => {
    const { object: objectName, foldername } = request.params;
    validateFoldername(foldername);

    const { obj, caller } = await resolveFileAccess(objectName, "upload", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });

    const maxFiles = parseUploadFilesCount();
    const allowedTypes = parseUploadFilesType();
    const uploadsRoot = getUploadsRoot();
    const folderDiskPath = path.join(
      uploadsRoot,
      objectName,
      foldernameToDiskPath(foldername)
    );
    if (!fs.existsSync(folderDiskPath))
      fs.mkdirSync(folderDiskPath, { recursive: true });

    const results: Array<{
      id: number;
      original_name: string;
      stored_name: string;
      file_path: string;
      file_size: number;
      mime_type: string;
      file_ext: string;
    }> = [];
    let count = 0;

    const db = getDb();
    const insStmt = db.prepare(
      `INSERT INTO object_files
        (object_id, object_name, foldername, original_name, stored_name, file_path, file_size, mime_type, file_ext, uploaded_by, uploaded_ip)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );

    for await (const file of request.files()) {
      if (count >= maxFiles) {
        file.file.resume(); // 丢弃超限文件
        break;
      }
      count++;

      const ext = (file.filename.split(".").pop() ?? "").toLowerCase();
      if (!ext || !allowedTypes.has(ext)) {
        throw new BusinessError(
          400,
          `文件 "${file.filename}" 的类型 ".${ext}" 不在允许列表中`
        );
      }

      const storedName = `${randomUUID()}.${ext}`;
      const filePath = path.join(folderDiskPath, storedName);
      // 相对路径用于 DB 存储和下载时解析
      const relativePath = path
        .join("uploads", objectName, foldernameToDiskPath(foldername), storedName)
        .split(path.sep)
        .join("/");

      await pipeline(file.file, fs.createWriteStream(filePath));
      const stat = fs.statSync(filePath);

      const info = insStmt.run(
        obj.id,
        objectName,
        foldername,
        file.filename,
        storedName,
        relativePath,
        stat.size,
        file.mimetype,
        ext,
        caller?.sub ?? null,
        request.ip
      );

      results.push({
        id: Number(info.lastInsertRowid),
        original_name: file.filename,
        stored_name: storedName,
        file_path: relativePath,
        file_size: stat.size,
        mime_type: file.mimetype,
        file_ext: ext
      });
    }

    if (results.length === 0) {
      throw new BusinessError(400, "未检测到上传文件");
    }

    return reply.code(201).send({
      ok: true,
      count: results.length,
      files: results
    });
  });

  // —— GET /api/files/:object/info/:file_id —— 文件元数据 + 下载 URL ——
  fastify.get<{
    Params: { object: string; file_id: string };
  }>("/api/files/:object/info/:file_id", async (request, reply) => {
    const { object: objectName, file_id: fileIdParam } = request.params;

    const { obj } = await resolveFileAccess(objectName, "list", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });

    const fileId = parseInt(fileIdParam, 10);
    if (!Number.isFinite(fileId)) {
      throw new BusinessError(400, `file_id 无效: "${fileIdParam}"`);
    }

    const db = getDb();
    const fileRow = db
      .prepare(
        `SELECT id, original_name, stored_name, file_path, file_size, mime_type,
                file_ext, foldername, uploaded_by, uploaded_ip, created_at
         FROM object_files WHERE id = ? AND object_id = ?`
      )
      .get(fileId, obj.id) as
      | {
        id: number;
        original_name: string;
        stored_name: string;
        file_path: string;
        file_size: number;
        mime_type: string;
        file_ext: string;
        foldername: string;
        uploaded_by: number | null;
        uploaded_ip: string | null;
        created_at: number;
      }
      | undefined;

    if (!fileRow) {
      throw new BusinessError(404, `文件不存在: id=${fileId}`);
    }

    // 检查物理文件是否存在
    const uploadsRoot = getUploadsRoot();
    const physicalPath = path.resolve(uploadsRoot, "..", fileRow.file_path);
    const physicalExists = fs.existsSync(physicalPath);
    const physicalSize = physicalExists ? fs.statSync(physicalPath).size : 0;

    // 构造下载 URL（相对路径，前端自己拼 baseURL）
    // 格式：/api/files/{objectName}/{fileId}
    const baseUrl =
      process.env.BASE_URL ??
      `${request.protocol}://${request.headers.host ?? "localhost:8858"}`;
    const downloadUrl = `${baseUrl}/api/files/${objectName}/${fileId}`;

    return reply.send({
      ok: true,
      data: {
        id: fileRow.id,
        object_name: objectName,
        foldername: fileRow.foldername,
        original_name: fileRow.original_name,
        stored_name: fileRow.stored_name,
        file_path: fileRow.file_path,
        file_size: fileRow.file_size,
        physical_size: physicalSize,
        physical_exists: physicalExists,
        mime_type: fileRow.mime_type,
        file_ext: fileRow.file_ext,
        uploaded_by: fileRow.uploaded_by,
        uploaded_ip: fileRow.uploaded_ip,
        created_at: fileRow.created_at,
        download_url: downloadUrl,
        // 下载时需要的 HTTP 头（前端直接 fetch 时用）
        download_headers: {
          Authorization: request.authContext.bearerToken
            ? `Bearer ${request.authContext.bearerToken}`
            : undefined,
          "X-Client-Id": request.authContext.fingerprint
        }
      }
    });
  });

  // —— GET /api/files/:object/:file_id —— 下载文件（支持 Range） ——
  fastify.get<{
    Params: { object: string; file_id: string };
  }>("/api/files/:object/:file_id", async (request, reply) => {
    const { object: objectName, file_id: fileIdParam } = request.params;
    const fileIds = fileIdParam
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const { obj } = await resolveFileAccess(objectName, "download", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });

    if (fileIds.length === 0) {
      throw new BusinessError(400, "file_id 不能为空");
    }
    if (fileIds.length > 1) {
      throw new BusinessError(
        400,
        "多文件下载暂不支持，请逐个下载（file_id 用单个 ID）"
      );
    }

    const fileId = parseInt(fileIds[0], 10);
    if (!Number.isFinite(fileId)) {
      throw new BusinessError(400, `file_id 无效: "${fileIds[0]}"`);
    }

    const fileRow = db_getFile(obj.id, fileId);
    if (!fileRow) {
      throw new BusinessError(404, `文件不存在: id=${fileId}`);
    }

    const uploadsRoot = getUploadsRoot();
    const filePath = path.resolve(uploadsRoot, "..", fileRow.file_path);
    if (!fs.existsSync(filePath)) {
      throw new BusinessError(404, `文件已被物理删除: ${fileRow.original_name}`);
    }

    const stat = fs.statSync(filePath);
    const range = request.headers.range;

    reply.header(
      "Content-Type",
      fileRow.mime_type || "application/octet-stream"
    );
    reply.header(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileRow.original_name)}"`
    );
    reply.header("Accept-Ranges", "bytes");

    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
        if (start > end || end >= stat.size) {
          reply.code(416);
          reply.header("Content-Range", `bytes */${stat.size}`);
          return reply.send();
        }
        const chunkSize = end - start + 1;
        reply.code(206);
        reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        reply.header("Content-Length", chunkSize);
        return reply.send(fs.createReadStream(filePath, { start, end }));
      }
    }

    reply.header("Content-Length", stat.size);
    return reply.send(fs.createReadStream(filePath));
  });

  // —— DELETE /api/files/:object/:foldername/:file_id —— 删除文件 ——
  fastify.delete<{
    Params: { object: string; foldername: string; file_id: string };
  }>("/api/files/:object/:foldername/:file_id", async (request, reply) => {
    const { object: objectName, foldername, file_id: fileIdParam } = request.params;
    validateFoldername(foldername);

    const { obj } = await resolveFileAccess(objectName, "delete", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });

    const maxDelete = parseDeleteFilesCount();
    const fileIds = fileIdParam
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, maxDelete);

    if (fileIds.length === 0) {
      throw new BusinessError(400, "file_id 不能为空");
    }

    const uploadsRoot = getUploadsRoot();
    const db = getDb();
    const selStmt = db.prepare(
      "SELECT * FROM object_files WHERE id = ? AND object_id = ? AND foldername = ?"
    );
    const delStmt = db.prepare("DELETE FROM object_files WHERE id = ?");

    const results: Array<{
      id: number;
      ok: boolean;
      original_name?: string;
      error?: string;
    }> = [];

    for (const fid of fileIds) {
      const fileId = parseInt(fid, 10);
      if (!Number.isFinite(fileId)) {
        results.push({ id: NaN, ok: false, error: `file_id 无效: "${fid}"` });
        continue;
      }

      const fileRow = selStmt.get(fileId, obj.id, foldername) as
        | {
          id: number;
          original_name: string;
          file_path: string;
        }
        | undefined;

      if (!fileRow) {
        results.push({ id: fileId, ok: false, error: "文件不存在" });
        continue;
      }

      // 删除物理文件
      const filePath = path.resolve(uploadsRoot, "..", fileRow.file_path);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        console.warn(
          `[files] 删除物理文件失败: ${filePath}`,
          (e as Error).message
        );
      }

      // 删除元数据
      delStmt.run(fileId);

      results.push({
        id: fileId,
        ok: true,
        original_name: fileRow.original_name
      });
    }

    return reply.send({
      ok: true,
      count: results.filter(r => r.ok).length,
      results
    });
  });

  // —— GET /api/files/:object/:foldername/:page —— 文件列表（分页） ——
  fastify.get<{
    Params: { object: string; foldername: string; page: string };
  }>("/api/files/:object/:foldername/:page", async (request, reply) => {
    const { object: objectName, foldername, page: pageParam } = request.params;
    validateFoldername(foldername);

    const { obj } = await resolveFileAccess(objectName, "list", {
      token: request.authContext.bearerToken,
      fingerprint: request.authContext.fingerprint
    });

    const pageSize = parseFilesPageSize();
    const page = Math.max(1, parseInt(pageParam, 10) || 1);
    const offset = (page - 1) * pageSize;

    const db = getDb();
    const where = "WHERE object_id = ? AND foldername = ?";
    const args = [obj.id, foldername];

    const total = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM object_files ${where}`)
        .get(...args) as { c: number }
    ).c;

    const items = db
      .prepare(
        `SELECT id, original_name, stored_name, file_path, file_size, mime_type, file_ext, uploaded_by, created_at
         FROM object_files ${where}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args, pageSize, offset) as Array<{
        id: number;
        original_name: string;
        stored_name: string;
        file_path: string;
        file_size: number;
        mime_type: string;
        file_ext: string;
        uploaded_by: number | null;
        created_at: number;
      }>;

    return reply.send({
      data: items,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      }
    });
  });
};

// ============================== 辅助函数 ==============================

/** 从 object_files 表按 id + object_id 查一行 */
function db_getFile(
  objectId: number,
  fileId: number
):
  | {
    id: number;
    original_name: string;
    file_path: string;
    mime_type: string;
    file_size: number;
  }
  | undefined {
  return getDb()
    .prepare("SELECT * FROM object_files WHERE id = ? AND object_id = ?")
    .get(fileId, objectId) as
    | {
      id: number;
      original_name: string;
      file_path: string;
      mime_type: string;
      file_size: number;
    }
    | undefined;
}

export default plugin;
