/** 复现 product_label_index.vue 的 join 关联请求 */
import { createFooseClient } from "./dist/index.js";

const foose = await createFooseClient({
  baseURL: "http://127.0.0.1:8858",
  username: "demo",
  password: "admin123456!@#"
});

// 复刻 product_label_index.vue 第 58-78 行的参数
try {
  const page = await foose.fooseList("sqlite_demo", "foose_product_label", {
    showSql: true,
    page: 1,
    pageSize: 5,
    joins: [{
      table: "foose_product",
      joinType: "left",
      as: "pdt",
      type: "one",
      on: { local: "product_id", foreign: "id" }
    }]
  });
  console.log("OK:", JSON.stringify(page, null, 2).slice(0, 500));
} catch (e) {
  console.error("❌ SDK 捕获错误:", e.message);
  console.error(e.stack);
}
