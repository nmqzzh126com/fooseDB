/**
 * FoosDB → pure-admin 适配层
 * =================================
 * 从 foose_db.ts 的 Layer 5 剥离而来（2026-09-26）。
 * 依赖 @/utils/foose_db_http（pure-admin 生态），
 * 不应被外部 SDK 消费者 import。
 */
import { http } from "@/utils/foose_db_http";

export type UserResult = {
  code: number;
  message: string;
  data: {
    /** 头像 */
    avatar: string;
    /** 用户名 */
    username: string;
    /** 昵称 */
    nickname: string;
    /** 当前登录用户的角色 */
    roles: Array<string>;
    /** 按钮级别权限 */
    permissions: Array<string>;
    /** `token` */
    accessToken: string;
    /** 用于调用刷新`accessToken`的接口时所需的`token` */
    refreshToken: string;
    /** `accessToken`的过期时间（ISO 字符串） */
    expires: string;
    /** accessToken 过期时间（ISO 字符串，供 pure-admin setToken 使用） */
    refreshExpires?: string;
    /** admin-panel 识别标识（可选，admin 面板 JWT 带 scope） */
    scope?: string;
    /** JWT payload 中的 object_id（-1=admin，≥1=绑定项目） */
    objectId?: number;
    /** 用户ID */
    userId?: number;
    /** 扩展信息 */
    extended?: string;
    /** 邮箱 */
    email?: string;
    /** 联系电话 */
    phone?: string;
  };
};

export type RefreshTokenResult = {
  code: number;
  message: string;
  data: {
    /** `token` */
    accessToken: string;
    /** 用于调用刷新`accessToken`的接口时所需的`token` */
    refreshToken: string;
    /** `accessToken`的过期时间（ISO 字符串） */
    expires: string;
  };
};

export type UserInfo = {
  /** 头像 */
  avatar: string;
  /** 用户名 */
  username: string;
  /** 昵称 */
  nickname: string;
  /** 邮箱 */
  email: string;
  /** 联系电话 */
  phone: string;
  /** 简介 */
  description: string;
  /** 用户ID */
  id: number;
  /** 扩展信息 */
  extended: string;
  /** 按钮级别权限 */
  permissions: Array<string>;
  /** 角色 */
  roles: Array<string>;
};

export type UserInfoResult = {
  code: number;
  message: string;
  data: UserInfo;
};

type ResultTable = {
  code: number;
  message: string;
  data?: {
    /** 列表数据 */
    list: Array<any>;
    /** 总条目数 */
    total?: number;
    /** 每页显示条目个数 */
    pageSize?: number;
    /** 当前页数 */
    currentPage?: number;
  };
};

/** 解码 JWT payload（base64url 解码，纯函数） */
function decodeJwtPayload(token: string): any {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "="
    );
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * 登录（对接 FoosDB /api/auth/login）
 * 后端返回 { data: { access_token, refresh_token, expires, refresh_expires, user } }
 * 前端适配为 pure-admin store 期望的：{ code: 0, data: { accessToken, expires, ... } }
 *
 * roles 处理（2026-09-22）：
 *   后端 user.roles 返回 RoleBrief[] 对象数组（{id, role_name, flag}），
 *   admin-panel 分支 scope==="admin-panel" 时前端固定给 ["admin"]，
 *   否则转 role_name 字符串数组（匹配 UserResult.roles: Array<string>）。
 */
export const getLogin = (data: { username: string; password: string }) => {
  return http
    .request<{ data: any }>("post", "/api/auth/login", {
      data: { username: data.username, password: data.password }
    })
    .then(raw => {
      const d = (raw as any).data;
      if (!d || !d.access_token) {
        throw new Error("登录响应缺少 access_token");
      }

      const payload = decodeJwtPayload(d.access_token);
      const scope: string | undefined = payload?.scope;
      const objectId: number | undefined = payload?.object_id;
      const jwtUsername: string = payload?.username ?? data.username;
      const nickname: string = payload?.nickname ?? jwtUsername;

      const rawRoles = d.user.roles;
      let roleDetails: Array<{ id: number; role_name: string; flag: number }> =
        [];
      let userRoles: Array<string> = [];
      if (Array.isArray(rawRoles)) {
        roleDetails = rawRoles
          .filter((r: any) => typeof r === "object")
          .map((r: any) => ({
            id: r.id ?? 0,
            role_name: r.role_name ?? String(r.id ?? r),
            flag: Number(r.flag ?? 0)
          }));
        userRoles = roleDetails.map(r => r.role_name);
        if (scope === "admin-panel") {
          userRoles = ["admin"];
        }
      } else if (typeof rawRoles === "string" && rawRoles.length > 0) {
        userRoles = rawRoles.split(",").filter(Boolean);
      }

      const user_result = {
        code: 0,
        message: "ok",
        data: {
          accessToken: d.access_token,
          refreshToken: d.refresh_token,
          expires: new Date(d.expires * 1000).toISOString(),
          refreshExpires: new Date(d.refresh_expires * 1000).toISOString(),
          avatar: d.user.avatar || "",
          userId: d.user.id || 0,
          username: jwtUsername,
          nickname,
          extended: d.user.extended || "",
          email: d.user.email || "",
          phone: d.user.phone || "",
          roles: userRoles,
          permissions:
            scope === "admin-panel" ? ["*:*:*"] : [d.user.permissions || ""],
          roleDetails,
          scope,
          objectId
        }
      } as UserResult & { data: { roleDetails: typeof roleDetails } };
      return user_result;
    });
};

/**
 * 刷新 token（对接 FoosDB /api/auth/refresh）
 * 后端请求体 snake_case（refresh_token），pure-admin store 传 camelCase — 这里做转换。
 */
export const refreshTokenApi = (data?: { refreshToken?: string }) => {
  return http
    .request<{ data: any }>("post", "/api/auth/refresh", {
      data: { refresh_token: data?.refreshToken }
    })
    .then(raw => {
      const d = (raw as any).data;
      if (!d || !d.access_token) {
        throw new Error("刷新响应缺少 access_token");
      }
      return {
        code: 0,
        message: "ok",
        data: {
          accessToken: d.access_token,
          refreshToken: d.refresh_token,
          expires: new Date(d.expires * 1000).toISOString()
        }
      } as RefreshTokenResult;
    });
};

/** 账户设置-个人信息（暂未对接，返回空壳） */
export const getMine = (_data?: object): Promise<UserInfoResult> => {
  return Promise.resolve({
    code: 0,
    message: "ok",
    data: {
      avatar: "",
      username: "",
      nickname: "",
      email: "",
      phone: "",
      description: "",
      id: 0,
      extended: "",
      permissions: [],
      roles: []
    }
  });
};

/** 账户设置-个人安全日志（暂未对接） */
export const getMineLogs = (_data?: object): Promise<ResultTable> => {
  return Promise.resolve({
    code: 0,
    message: "ok",
    data: { list: [], total: 0 }
  });
};
