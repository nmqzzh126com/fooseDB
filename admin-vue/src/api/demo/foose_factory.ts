/**
 * FooseDB 表级 API 工厂 —— 一行代码生成 useXxx composable + 纯函数 API
 *
 * 用法（新建 product_type_api.ts）：
 * ```ts
 * import { createUseFoose, createFooseApi } from "./foose_factory";
 * import type { FooseRow, FoosePatch } from "@/api/foose_db";
 *
 * export interface ProductTypeRow extends FooseRow {
 *   type_name: string;
 *   type_desc?: string;
 * }
 * export type ProductTypeInput = FoosePatch<ProductTypeRow>;
 *
 * // 响应式 composable（组件里用）—— prefix 替换所有 key 里的 "foose"
 * export const useProductType = createUseFoose<ProductTypeRow>({
 *   table: "product_type",
 *   prefix: "productType",
 *   defaultPageSize: 10,
 * });
 * // 返回 { productTypeDbDataList, productTypeDbLoading, productTypeDbList, ... }
 *
 * // 纯函数 API（store / router guard 里用）
 * export const productTypeApi = createFooseApi<ProductTypeRow>({
 *   table: "product_type",
 * });
 * ```
 *
 * 同组件多表不冲突：
 * ```ts
 * const product = useProduct();        // { productDbDataList, productDbList, ... }
 * const productType = useProductType(); // { productTypeDbDataList, productTypeDbList, ... }
 * ```
 */
import { ref, type Ref } from "vue";
import type {
  FooseRow,
  FoosePatch,
  FooseListParams,
  FooseComposable,
  FooseClient
} from "@/api/foose_db";
import { DEFAULT_OBJECT_NAME, importFooseClient } from "./foose_base";

/** 工厂配置 */
export interface FooseTableConfig {
  /** 后端表名（必填） */
  table: string;
  /** 后端 object/datasource 名（默认 DEFAULT_OBJECT_NAME） */
  object?: string;
  /** 默认分页大小（默认 10） */
  defaultPageSize?: number;
  /**
   * key 前缀 —— 替换所有返回 key 里的 "foose"
   *
   *   prefix: "product"      → productDbDataList, productDbList, ...
   *   prefix: "productType"  → productTypeDbDataList, productTypeDbList, ...
   *
   * 不传则保持原名（fooseDbDataList 等）
   */
  prefix?: string;
}

/** 类型层：把 FooseComposable 的所有 key 里的 "foose" 替换成 Prefix */
type ReplaceFoose<K extends string, Prefix extends string> = K extends `foose${infer Rest}`
  ? `${Prefix}${Rest}`
  : K;

export type PrefixedComposable<T extends FooseRow, Prefix extends string> = {
  [K in keyof FooseComposable<T> as ReplaceFoose<Extract<K, string>, Prefix>]: FooseComposable<T>[K];
};

/** 内部：懒加载 foose 单例 + 错误处理 */
function makeGetter(errorRef: Ref<string | null>) {
  let promise: Promise<FooseClient> | null = null;
  return function getFoose(): Promise<FooseClient> {
    if (!promise) {
      promise = importFooseClient().catch(err => {
        errorRef.value = err instanceof Error ? err.message : "FoosDB 连接失败";
        throw err;
      });
    }
    return promise;
  };
}

/** 运行时：把对象所有 key 里的 "foose" 替换成 prefix */
function renameKeys(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.startsWith("foose") ? prefix + k.slice(5) : k] = v;
  }
  return out;
}

/**
 * 创建响应式 composable（useProduct / useProductType ...）
 *
 * 默认返回 FooseComposable<T>（fooseDbDataList 等）
 * 传 prefix 后返回 PrefixedComposable<T, Prefix>（productDbDataList 等）
 */
export function createUseFoose<
  T extends FooseRow,
  Prefix extends string = "foose"
>(
  config: FooseTableConfig & { prefix?: string }
): () => PrefixedComposable<T, Prefix> {
  const OBJECT = config.object ?? DEFAULT_OBJECT_NAME;
  const TABLE = config.table;
  const DEFAULT_PAGE_SIZE = config.defaultPageSize ?? 10;
  const prefix: string = (config.prefix ?? "foose");
  const rename = prefix !== "foose";

  return function useFoose(): PrefixedComposable<T, Prefix> {
    // —— 响应式状态（必须在 setup 顶层同步创建）——
    const data: Ref<T[]> = ref([]);
    const current: Ref<T | null> = ref(null);
    const loading = ref(false);
    const error: Ref<string | null> = ref(null);
    const page = ref(1);
    const pageSize = ref(DEFAULT_PAGE_SIZE);
    const total = ref(0);

    const getFoose = makeGetter(error);

    async function fooseList(params?: FooseListParams) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const res = await foose.fooseList<T>(OBJECT, TABLE, params);
        data.value = (res?.data ?? []) as T[];
        page.value = res?.meta?.page ?? 1;
        pageSize.value = res?.meta?.pageSize ?? DEFAULT_PAGE_SIZE;
        total.value = res?.meta?.total ?? data.value.length;
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseGet(id: number | string, fields?: string, join?: string) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const row = await foose.fooseGet<T>(OBJECT, TABLE, id, { fields, join });
        current.value = row;
        return row;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseGetBy(params: FooseListParams) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const row = await foose.fooseGetBy<T>(OBJECT, TABLE, params);
        current.value = row;
        return row;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseCreate(payload: FoosePatch<T>) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const row = await foose.fooseCreate<T>(OBJECT, TABLE, payload);
        current.value = row;
        data.value.unshift(row);
        total.value += 1;
        return row;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseUpdate(id: number | string, payload: FoosePatch<T>) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const row = await foose.fooseUpdate<T>(OBJECT, TABLE, id, payload);
        current.value = row;
        const idx = data.value.findIndex(r => r.id === id);
        if (idx !== -1) data.value.splice(idx, 1, row);
        return row;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseCreates(payloads: FoosePatch<T>[], showSql = false) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const res = await foose.fooseCreates<T>(OBJECT, TABLE, payloads, showSql);
        // 同步到 dataList
        for (const row of res.rows) {
          data.value.unshift(row);
        }
        total.value += res.created;
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseUpdates(
      rows: Array<{ id: number | string } & FoosePatch<T>>,
      showSql = false
    ) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const res = await foose.fooseUpdates<T>(OBJECT, TABLE, rows, showSql);
        // 逐个替换 dataList 中的旧行
        for (const newRow of res.rows) {
          const r = newRow as Record<string, unknown>;
          const id = r.id ?? r.my_id;
          if (id !== undefined) {
            const idx = data.value.findIndex(d => (d as Record<string, unknown>).id === id || (d as Record<string, unknown>).my_id === id);
            if (idx !== -1) data.value.splice(idx, 1, newRow);
          }
        }
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseRemove(id: number | string) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const res = await foose.fooseRemove(OBJECT, TABLE, id);
        data.value = data.value.filter(r => r.id !== id);
        if (current.value?.id === id) current.value = null;
        total.value = Math.max(0, total.value - 1);
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseRemoves(ids: Array<number | string>, showSql = false) {
      loading.value = true;
      error.value = null;
      try {
        const foose = await getFoose();
        const res = await foose.fooseRemoves(OBJECT, TABLE, ids, showSql);
        const idSet = new Set(ids);
        data.value = data.value.filter(r => !idSet.has(r.id));
        if (current.value && idSet.has(current.value.id)) current.value = null;
        total.value = Math.max(0, total.value - (res?.deleted ?? ids.length));
        return res;
      } catch (e) {
        error.value = e instanceof Error ? e.message : "未知错误";
        throw e;
      } finally {
        loading.value = false;
      }
    }

    async function fooseRemovesByFilter(filter: Record<string, unknown>, showSql = false) {
      // 不走 loading 状态 —— filter 删的可能不是当前页数据
      const foose = await getFoose();
      return foose.fooseRemoveByFilter(OBJECT, TABLE, filter, showSql);
    }

    function fooseReset() {
      data.value = [];
      current.value = null;
      error.value = null;
      page.value = 1;
      pageSize.value = DEFAULT_PAGE_SIZE;
      total.value = 0;
    }

    const raw: FooseComposable<T> = {
      fooseDbDataList: data,
      fooseCurrentRow: current,
      fooseDbLoading: loading,
      fooseDbError: error,
      fooseDbPage: page,
      fooseDbPageSize: pageSize,
      fooseDbTotal: total,
      fooseDbList: fooseList,
      fooseDbGet: fooseGet,
      fooseDbGetBy: fooseGetBy,
      fooseDbCreate: fooseCreate,
      fooseDbCreates: fooseCreates,
      fooseDbUpdate: fooseUpdate,
      fooseDbUpdates: fooseUpdates,
      fooseDbRemove: fooseRemove,
      fooseDbRemoves: fooseRemoves,
      fooseDbRemovesByFilter: fooseRemovesByFilter,
      fooseDbReset: fooseReset
    };

    const result = rename ? renameKeys(raw as unknown as Record<string, unknown>, prefix) : raw;
    return result as PrefixedComposable<T, Prefix>;
  };
}

/** 纯函数 API 接口（不走响应式状态） */
export interface FooseApi<T extends FooseRow> {
  list: (params?: FooseListParams) => ReturnType<FooseClient["fooseList"]>;
  get: (id: number | string) => Promise<T | null>;
  getBy: (params: FooseListParams) => Promise<T | null>;
  create: (payload: FoosePatch<T>) => Promise<T>;
  creates: (rows: FoosePatch<T>[]) => Promise<{ ok: boolean; created: number; rows: T[] }>;
  update: (id: number | string, payload: FoosePatch<T>) => Promise<T>;
  updates: (rows: Array<{ id: number | string } & FoosePatch<T>>) => Promise<{ ok: boolean; updated: number; rows: T[] }>;
  remove: (id: number | string) => Promise<unknown>;
  removes: (ids: Array<string | number>) => Promise<{ ok: boolean; deleted: number }>;
  removeByFilter: (filter: Record<string, unknown>, showSql?: boolean) => Promise<{ ok: boolean; deleted: number; sql?: string; sqlParams?: unknown[] }>;
}

/**
 * 创建纯函数 API（store / router guard / 工具函数里用）
 *
 * 返回 FooseApi<T>：{ list, get, getBy, create, update, remove }
 */
export function createFooseApi<T extends FooseRow>(
  config: FooseTableConfig
): FooseApi<T> {
  const OBJECT = config.object ?? DEFAULT_OBJECT_NAME;
  const TABLE = config.table;

  async function list(params?: FooseListParams) {
    const foose = await importFooseClient();
    return foose.fooseList<T>(OBJECT, TABLE, params);
  }
  async function get(id: number | string) {
    const foose = await importFooseClient();
    return foose.fooseGet<T>(OBJECT, TABLE, id);
  }
  async function getBy(params: FooseListParams) {
    const foose = await importFooseClient();
    return foose.fooseGetBy<T>(OBJECT, TABLE, params);
  }
  async function create(payload: FoosePatch<T>) {
    const foose = await importFooseClient();
    return foose.fooseCreate<T>(OBJECT, TABLE, payload);
  }
  async function creates(rows: FoosePatch<T>[], showSql = false) {
    const foose = await importFooseClient();
    return foose.fooseCreates<T>(OBJECT, TABLE, rows, showSql);
  }
  async function update(id: number | string, payload: FoosePatch<T>) {
    const foose = await importFooseClient();
    return foose.fooseUpdate<T>(OBJECT, TABLE, id, payload);
  }
  async function updates(rows: Array<{ id: number | string } & FoosePatch<T>>, showSql = false) {
    const foose = await importFooseClient();
    return foose.fooseUpdates<T>(OBJECT, TABLE, rows, showSql);
  }
  async function remove(id: number | string) {
    const foose = await importFooseClient();
    return foose.fooseRemove(OBJECT, TABLE, id);
  }
  async function removes(ids: Array<string | number>, showSql = false) {
    const foose = await importFooseClient();
    return foose.fooseRemoves(OBJECT, TABLE, ids, showSql);
  }
  async function removeByFilter(filter: Record<string, unknown>, showSql = false) {
    const foose = await importFooseClient();
    return foose.fooseRemoveByFilter(OBJECT, TABLE, filter, showSql);
  }

  return { list, get, getBy, create, creates, update, updates, remove, removes, removeByFilter };
}
