---
sidebar_position: 2
title: "文件操作 API"
slug: "/api/file-operations"
description: "内置文件管理：上传 / 下载 / 列表 / 删除 / 元数据，四档权限独立控制"
---

# 文件操作 API

统一前缀：`/api/files/:object`，支持 multipart/form-data 上传，四档权限独立控制。

---

## 权限字段

object 表中 4 个独立开关（DEFAULT 体现安全优先级）：

| 字段 | DEFAULT | 路由适用 |
|------|---------|---------|
| `allow_upload_file` | **0** | POST 上传 |
| `allow_download_file` | **0** | GET 下载 |
| `allow_delete_file` | **0** | DELETE 删除 |
| `allow_list_file` | **1** | GET 列表 / GET 文件元数据 |

### 为什么 list 独立且默认开启

浏览目录（看 id/name/size）不涉及实际文件实体的传输，不应和下载权限绑定。用户不开下载权限也应该能看见文件列表。

---

## ① 上传文件

```
POST /api/files/:object/:foldername
Content-Type: multipart/form-data
```

| multipart 字段 | 说明 |
|---------------|------|
| `file`（可多次） | 要上传的文件。字段名固定 `file`，传多次即多文件 |

### curl 示例

```bash
curl -X POST http://localhost:8858/api/files/sqlite_demo/docs-images \
  -H "Authorization: Bearer <token>" \
  -H "X-Client-Id: <uuid>" \
  -F "file=@photo1.png" \
  -F "file=@photo2.jpg"
```

### 请求参数

| 参数 | 位置 | 说明 |
|------|------|------|
| `object` | path | 项目名 |
| `foldername` | path | 文件夹路径。多层用 `-` 分隔，最多 3 层，如 `docs-images-2024` |

### 返回

```json
{
  "ok": true,
  "count": 2,
  "files": [
    {
      "id": 7,
      "original_name": "photo1.png",
      "stored_name": "a1b2c3d4-e5f6-7890-abcd-ef1234567890.png",
      "file_path": "uploads/sqlite_demo/docs-images/a1b2c3...png",
      "file_size": 102400,
      "mime_type": "image/png",
      "file_ext": "png"
    },
    {
      "id": 8,
      "original_name": "photo2.jpg",
      "stored_name": "b2c3d4e5-f6a7-8901-bcde-f12345678901.jpg",
      "file_path": "uploads/sqlite_demo/docs-images/b2c3d4...jpg",
      "file_size": 204800,
      "mime_type": "image/jpeg",
      "file_ext": "jpg"
    }
  ]
}
```

### 校验项

| 校验 | 规则 | 错误响应 |
|------|------|---------|
| 文件类型白名单 | `.env` 的 `UPLOAD_FILES_TYPE` | 400 `文件 "xxx.png" 的类型 ".png" 不在允许列表中` |
| 文件大小 | `UPLOAD_FILE_SIZE` KB | 413 |
| 单次数量 | `UPLOAD_FILES_COUNT` | 超过后忽略剩余文件（不报错，静默丢弃） |
| foldername 深度 | 最多 3 层 | 400 |
| foldername 安全 | 禁止 `.` `..` `/` `\` | 400 |

---

## ② 获取文件元数据 + 下载 URL

```
GET /api/files/:object/info/:file_id
```

权限：`allow_list_file`

### curl 示例

```bash
curl http://localhost:8858/api/files/sqlite_demo/info/7
```

### 返回

```json
{
  "id": 7,
  "original_name": "photo1.png",
  "stored_name": "a1b2c3...png",
  "file_path": "uploads/sqlite_demo/docs-images/a1b2c3...png",
  "file_size": 102400,
  "mime_type": "image/png",
  "file_ext": "png",
  "foldername": "docs-images",
  "uploaded_by": "admin",
  "uploaded_ip": "::1",
  "created_at": 1728000000000
}
```

> 响应结构**没有 envelope**（直接是对象），和通用 CRUD API 的 `{ data: ... }` 不同。

---

## ③ 下载文件

```
GET /api/files/:object/:file_id
```

权限：`allow_download_file`

### 支持 Range 请求

```http
Range: bytes=0-1023
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1023/102400
```

### 返回

```http
Content-Type: image/png
Content-Length: 102400
Content-Disposition: attachment; filename="photo1.png"

<<二进制文件流>>
```

### SDK 正确处理

`responseType: "blob"`。⚠️ 下载 403 时后端返回 JSON 错误体（而非二进制），SDK **已加 Blob 预解析**：拦截器读取 `Blob.text()` 再 JSON.parse，确保中文错误信息不丢失。

---

## ④ 删除文件

```
DELETE /api/files/:object/:foldername/:file_id
```

权限：`allow_delete_file`

### file_id 支持批量

```
DELETE /api/files/sqlite_demo/docs-images/7,8,9
```

### 返回

```json
{
  "ok": true,
  "count": 3,
  "results": [
    { "id": 7, "ok": true },
    { "id": 8, "ok": true },
    { "id": 9, "ok": true, "error": "文件不存在或已被删除" }
  ]
}
```

---

## ⑤ 文件列表（分页）

```
GET /api/files/:object/:foldername/:page
```

权限：`allow_list_file`

### 示例

```
GET /api/files/sqlite_demo/docs-images/1
GET /api/files/sqlite_demo/docs-images/2
```

`FILES_PAGE_SIZE` 控制每页条数（默认 20）。

### 返回

```json
{
  "data": [
    {
      "id": 7,
      "original_name": "photo1.png",
      "file_size": 102400,
      "mime_type": "image/png",
      "created_at": 1728000000000
    }
  ],
  "meta": {
    "total": 45,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

---

## 文件权限校验链

```
请求到达
  │
  ├─ 1. resolveFileAccess(objectName, fileOp, auth)
  │     ├─ object 存在？ → 404
  │     ├─ object.enabled=1？ → 403
  │     └─ allow_*_file=1？ → 403（这里 * 根据路由匹配 upload/download/delete/list）
  │
  ├─ 2. auth_required=1 → 校验 JWT + 客户端指纹 → 401
  │
  └─ 3. 用户绑定校验（可选）→ 403
```

### fileOp 到权限字段的映射

| fileOp | 路由示例 | 权限字段 |
|--------|---------|---------|
| `upload` | POST `/api/files/...` | `allow_upload_file` |
| `download` | GET `/api/files/:object/:file_id` | `allow_download_file` |
| `delete` | DELETE `/api/files/...` | `allow_delete_file` |
| `list` | GET `/api/files/:object/info/:file_id` | `allow_list_file` |
| `list` | GET `/api/files/:object/:foldername/:page` | `allow_list_file` |

---

## 存储结构

```
api-fastify/
├── uploads/                          ← 文件物理存储根目录
│   └── sqlite_demo/                  ← object name
│       └── docs-images/              ← foldername 转磁盘路径
│           └── a1b2c3d4-...png       ← UUID + 原扩展名
└── data/
    └── app.db
        └── object_files 表            ← 元数据索引
```

### object_files 表字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK | |
| `object_id` | INTEGER FK → object | |
| `object_name` | TEXT | 冗余存储项目名 |
| `foldername` | TEXT | 原始传入的 foldername |
| `original_name` | TEXT | 用户上传时的原始文件名 |
| `stored_name` | TEXT | UUID 随机名 |
| `file_path` | TEXT | 相对路径 `uploads/...` |
| `file_size` | INTEGER | 字节 |
| `mime_type` | TEXT | |
| `file_ext` | TEXT | 小写扩展名（无点） |
| `uploaded_by` | TEXT | 用户名（auth 启用时） |
| `uploaded_ip` | TEXT | |
| `created_at` | INTEGER | Unix 毫秒时间戳 |

---

## 安全设计

| 机制 | 说明 |
|------|------|
| UUID 重命名 | 后端生成随机名存储，不保留原文件名做文件名 |
| 路径遍历防护 | foldername 校验禁止 `.` `..` `/` `\` |
| 扩展名白名单 | `.env` 的 `UPLOAD_FILES_TYPE` 控制 |
| 大小限制 | `.env` 的 `UPLOAD_FILE_SIZE` 控制单文件 KB |
| 数量限制 | 上传/下载/删除各有独立上限 |
| object_files 受保护 | `CONFIG_GUARDED_TABLES`，禁止通过通用 CRUD API 访问 |
| 自动忽略 | uploads/ 目录在 .gitignore 中 |

---

## 常见 403 错误提示

| 禁用字段 | 操作 | 中文提示 |
|---------|------|---------|
| `allow_upload_file=0` | 上传 | `项目 "xxx" 未开启文件上传权限` |
| `allow_download_file=0` | 下载 | `项目 "xxx" 未开启文件下载权限` |
| `allow_delete_file=0` | 删除 | `项目 "xxx" 未开启文件删除权限` |
| `allow_list_file=0` | 列表 / 元数据查询 | `项目 "xxx" 未开启文件列表权限` |

> SDK 已修复 Blob 错误体解析 — 下载 403 时也能正确显示中文错误（不会再 fallback 到 `请求失败 (403)`）。
