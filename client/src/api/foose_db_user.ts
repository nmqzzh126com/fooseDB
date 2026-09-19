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

/**
 * 登录（对接 FoosDB /api/auth/login）
 *
 * 后端返回格式：{ data: { access_token, refresh_token, expires, refresh_expires } }
 * 前端适配为 pure-admin store 期望的：{ code: 0, data: { accessToken, expires, ... } }
 */
export const getLogin = (data: { username: string; password: string }) => {
  return http
    .request<{ data: any }>("post", "/api/auth/login", {
      data: { username: data.username, password: data.password }
    })
    .then(raw => {
      // raw = { data: { access_token, refresh_token, expires, refresh_expires } }
      const d = (raw as any).data;
      if (!d || !d.access_token) {
        throw new Error("登录响应缺少 access_token");
      }
      console.log("登录响应 login response:", d);

      // 解码 JWT payload 拿 scope / object_id / username / nickname 等
      // admin-panel JWT payload.nickname 已由后端 .env ADMIN_NICKNAME 正确设置，
      // 不再是 users 表 shadow 行的 "(shadow)"。
      const payload = decodeJwtPayload(d.access_token);
      const scope: string | undefined = payload?.scope;
      const objectId: number | undefined = payload?.object_id;
      const jwtUsername: string = payload?.username ?? data.username;
      const nickname: string = payload?.nickname ?? jwtUsername;
      // 解析用户信息
      const userRoles: Array<string> = (d.user.roles || "").split(",") || [];
      const userId: number = d.user.id || 0;
      const userAvatar: string = d.user.avatar || "";
      const userPermissions: string = d.user.permissions || "";
      const userExtended: string = d.user.extended || "";
      const userEmail: string = d.user.email || "";
      const userPhone: string = d.user.phone || "";
      const user_result = {
        code: 0,
        message: "ok",
        data: {
          accessToken: d.access_token,
          refreshToken: d.refresh_token,
          expires: new Date(d.expires * 1000).toISOString(),
          refreshExpires: new Date(d.refresh_expires * 1000).toISOString(),
          avatar: userAvatar,
          userId: userId,
          username: jwtUsername,
          nickname,
          extended: userExtended,
          email: userEmail,
          phone: userPhone,
          // admin-panel 用户角色 / 权限直接给全量
          roles: scope === "admin-panel" ? ["admin"] : userRoles,
          permissions: scope === "admin-panel" ? ["*:*:*"] : [userPermissions],
          scope,
          objectId
        }
      } as UserResult;
      console.log("登录响应 user_result:", user_result);
      return user_result;
    });
};

/**
 * 刷新 token（对接 FoosDB /api/auth/refresh）
 *
 * 后端请求体字段名是 snake_case（refresh_token），pure-admin store 传的是 camelCase，
 * 这里做转换。
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

/** 解码 JWT payload（base64url 解码） */
function decodeJwtPayload(token: string): any {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    // 添加 base64 padding
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "="
    );
    // 用 TextDecoder 解码，替代已弃用的 escape/decodeURIComponent
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
