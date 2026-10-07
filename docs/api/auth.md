---
sidebar_position: 3
title: "认证 API"
slug: "/api/auth"
description: "登录 / 登出 / 刷新 Token / 当前用户，JWT 双 Token + 客户端指纹 + 代次强制注销"
---

# 认证 API

后端不硬编码用户表结构（每个 object 可以有自己的 users 表），认证端点操作的是 app.db 配置库的 users 表。

---

## ① 登录

```
POST /api/auth/login
Content-Type: application/json
```

### 请求

```json
{
  "username": "admin",
  "password": "admin123456"
}
```

### 返回

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 7200,
  "user": {
    "id": 1,
    "username": "admin",
    "nickname": "系统管理员",
    "object_id": -1,
    "flag": 1
  }
}
```

### Access Token Payload

```json
{
  "sub": 1,
  "username": "admin",
  "fp": "sha256(cid:8f3a...uuid...)",
  "v": 1,
  "iat": 1728000000,
  "exp": 1728007200
}
```

| 字段 | 说明                                                                  |
| ---- | --------------------------------------------------------------------- |
| `fp` | 客户端指纹（sha256("cid:" + X-Client-Id)）。换设备 → 指纹不匹配 → 401 |
| `v`  | token_version（代次）。改密码时自增，所有旧 token 立即失效            |

### 错误

| 场景                    | HTTP | message                        |
| ----------------------- | ---- | ------------------------------ |
| 用户名不存在            | 401  | `用户名或密码错误`             |
| 密码错误                | 401  | `用户名或密码错误`             |
| 账号被禁用              | 403  | `账号已被禁用`                 |
| IP 限流（Redis 开启时） | 429  | `登录尝试过于频繁，请稍后再试` |

---

## ② 当前用户信息

```
GET /api/auth/me
```

### 认证头

```http
Authorization: Bearer <access_token>
X-Client-Id: <客户端指纹 UUID>
```

### 返回

```json
{
  "id": 1,
  "username": "admin",
  "nickname": "系统管理员",
  "object_id": -1,
  "flag": 1
}
```

---

## ③ 刷新 Token

```
POST /api/auth/refresh
Content-Type: application/json
```

SDK 在收到 401 时**自动**调用，业务代码不需要手动管。

### 请求

```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

### 返回

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 7200
}
```

### 关键机制

- **refresh 自动轮换**：每次刷新返回新的 refresh_token，旧的立即作废
- **盗用检测**：同一 refresh family 被重复使用（旧 token 还在，有人抢先用了）→ 整 family 全部作废，所有已登录客户端被迫重新登录
- **客户端指纹绑定**：refresh token 也绑定 fp，跨设备拿 refresh token 刷新会失败

---

## ④ 登出

```
POST /api/auth/logout
Content-Type: application/json
```

### 请求

```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

### 返回

```json
{ "ok": true }
```

服务端删除 refresh_tokens 表中对应记录。SDK 同时清除 localStorage 中的 token 和 fingerprint。

---

## 客户端指纹机制

后端校验 JWT 时会比对 `JWT.fp` vs `sha256("cid:" + X-Client-Id header)`：

```
客户端启动
  │
  ├─ 生成随机 UUID → localStorage["foose::fp"]
  │
  ├─ 每次请求带 X-Client-Id: <uuid>
  │
  ├─ 登录时 JWT.fp = sha256("cid:" + uuid)
  │
  └─ 后端每次鉴权校验 sha256("cid:" + header) === JWT.fp
     ✅ 匹配 → 通过
     ❌ 不匹配 → 401 "token client mismatch"
```

### 效果

- 用户 A 在电脑上登录 → 拿到 fp=AAA 的 token
- 用户 A 又在手机上登录 → 拿到 fp=BBB 的 token
- 电脑上的 token 拿到手机上用 → fp 不匹配 → 401
- 防止 token 被盗后跨设备使用

---

## 代次强制注销

改密码时 users 表的 `token_version` 自增：

```
users.token_version = 1 → 2

JWT 里的 "v" 字段 = 1
                       ↓
所有带 v=1 的 access token → 401 "token revoked"
所有 refresh token → 失效
```

效果：**改密码后所有已登录客户端立即下线**，必须重新登录。

---

## 登录限流

基于 Redis（未启用时自动降级，限流失效）：

| 维度  | 默认阈值 | 周期  |
| ----- | -------- | ----- |
| 同 IP | 30 次    | 60 秒 |

超限后返回：

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "登录尝试过于频繁，请稍后再试"
}
```

---

## SDK 自动鉴权流程

```
发起业务 API 请求（fooseList / fooseCreate / ...）
  │
  ├─ HTTP 拦截器自动注入
  │   Authorization: Bearer <access_token>
  │   X-Client-Id: <本地存的 UUID>
  │
  ├─ 后端返回 401
  │
  ├─ SDK 拦截器捕获
  │   ├─ 检查是 token expired 还是 client mismatch？
  │   ├─ access_token 过期 → 触发 refresh
  │   ├─ refresh_token 也过期 → 清空 auth → 跳登录
  │   └─ 单飞：多个并发 401 只触发一次 refresh
  │
  ├─ refresh 成功 → 重试原请求
  │
  └─ refresh 失败 → 清空 auth → 返回 401 错误
```

业务代码完全不用管 Token 刷新、过期检测、并发竞态 — SDK 拦截器自动处理。
