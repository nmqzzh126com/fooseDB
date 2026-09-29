export interface FooseDbApiContent {
  content_key: string;
  content_title: string;
  content_desc: string;
  /** 用户可编辑 + 运行的代码（纯 JS，不含 import——SDK 函数由沙箱注入） */
  code_ts: string;
  code_vue: string;
  /** API 返回结果 mock（JSON 字符串，用于结果区 CodeMirror 展示） */
  code_result?: string;
}

export interface FooseDbApiDemoRow {
  key: string;
  desc: string;
  content_list: FooseDbApiContent[];
}

export const CodeConfig = {
  ts_head: '<script setup lang="ts">',
  ts_end: "</script>",
  vue_head: "<template>",
  vue_end: "</template>"
};

const _R = (rows: unknown[], total: number, page = 1, pageSize = 10) =>
  JSON.stringify(
    {
      code: 0,
      message: "ok",
      data: {
        list: rows,
        total,
        page,
        pageSize
      }
    },
    null,
    2
  );

const _row = (id: number) => ({
  id,
  username: `user_${id}`,
  nickname: `用户 ${id}`,
  email: `user${id}@example.com`,
  phone: `1380000${String(id).padStart(4, "0")}`,
  flag: 0
});

export const fooseDbApiDemo: FooseDbApiDemoRow[] = [
  {
    key: "list-page",
    desc: "分页查询",
    content_list: [
      {
        content_key: "list-page-1",
        content_title: "分页查询1",
        content_desc: "查询 foose_users 第一页 10 条",
        code_ts: [
          "// 可用: http, createFooseClient, getLogin, getMine, console",
          "// http 是 axios 实例，自动注入 Authorization + X-Client-Id",
          "// FoosDB 通用 CRUD 路由: /api/:object/:table",
          "const res = await http.get('/api/sqlite_demo/foose_users', {",
          "  params: { page: 1, pageSize: 5 }",
          "});",
          "return res;"
        ].join("\n"),
        code_vue: "vue1",
        code_result: _R(
          Array.from({ length: 10 }, (_, i) => _row(i + 1)),
          128,
          1,
          10
        )
      },
      {
        content_key: "list-page-2",
        content_title: "分页查询2",
        content_desc: "查询第二页 10 条",
        code_ts: [
          "const res = await http.get('/api/sqlite_demo/foose_users', {",
          "  params: { page: 2, pageSize: 10 }",
          "});",
          "return res;"
        ].join("\n"),
        code_vue: "vue2",
        code_result: _R(
          Array.from({ length: 10 }, (_, i) => _row(i + 11)),
          128,
          2,
          10
        )
      }
    ]
  },
  {
    key: "list-none-page",
    desc: "不分页查询",
    content_list: [
      {
        content_key: "list-none-page-1",
        content_title: "不分页查询",
        content_desc: "一次拉取全部匹配",
        code_ts: [
          "const res = await http.get('/api/sqlite_demo/foose_users', {",
          "  params: { pageSize: 999 }",
          "});",
          "return res;"
        ].join("\n"),
        code_vue: "vue1",
        code_result: JSON.stringify(
          {
            code: 0,
            message: "ok",
            data: Array.from({ length: 5 }, (_, i) => _row(i + 1))
          },
          null,
          2
        )
      }
    ]
  },
  {
    key: "list-condition",
    desc: "按条件查询",
    content_list: [
      {
        content_key: "list-condition-1",
        content_title: "按条件查询",
        content_desc: "where username like '%demo%'",
        code_ts: [
          "// GET /api/:object/:table 直接支持 filter query params（bracket 风格）",
          "// FoosDB filter 语法: field[_op]=value  支持 _like _eq _gt _lt 等",
          "const res = await http.get('/api/sqlite_demo/foose_users', {",
          "  params: {",
          "    page: 1,",
          "    pageSize: 20,",
          "    'username[_like]': 'demo%'",
          "  }",
          "});",
          "return res;"
        ].join("\n"),
        code_vue: "vue condition",
        code_result: _R(
          [
            _row(1),
            { ..._row(3), username: "demo_admin", nickname: "Demo 管理员" },
            { ..._row(7), username: "demo_user_7", nickname: "Demo 用户 7" }
          ],
          3,
          1,
          10
        )
      }
    ]
  }
];
