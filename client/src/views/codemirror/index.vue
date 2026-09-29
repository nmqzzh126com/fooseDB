<script setup lang="ts">
import "codemirror/theme/material-darker.css";
import "codemirror/addon/hint/show-hint.css";
import "codemirror/addon/hint/show-hint";
import "codemirror/addon/hint/javascript-hint.js";
import "codemirror/mode/javascript/javascript.js";
import "codemirror/addon/lint/lint.css";
import "codemirror/addon/lint/lint.js";
// CodeMirror v5 的 javascript mode 已内建 typescript 识别
// 设 mode: "text/typescript" 或 mode: "javascript" + typescript: true 都能触发 TS 高亮

import { useDark } from "@pureadmin/utils";
import Codemirror from "codemirror-editor-vue3";
import { ref, reactive, watch, nextTick, computed } from "vue";
import type { Editor, EditorConfiguration } from "codemirror";

const { isDark } = useDark();
const cminstance = ref<Editor | null>(null);

type LangMode = "javascript" | "typescript";
const currentLang = ref<LangMode>("typescript");

// 语言 → demo 代码映射（TS 版带 interface / type / 泛型 / 类型注解）
const codeByLang: Record<LangMode, string> = {
  javascript: `// JavaScript demo (mode: "javascript")
function sayHello(name) {
  console.log("Hello, " + name + "!");
}

const users = [
  { id: 1, name: "Alice", active: true },
  { id: 2, name: "Bob", active: false }
];

const activeNames = users
  .filter(u => u.active)
  .map(u => u.name);

sayHello(activeNames.join(", "));`,

  typescript: `// TypeScript demo (mode: "text/typescript")
interface User {
  id: number;
  name: string;
  active: boolean;
  email?: string;
}

type UserMap = Map<number, User>;

function sayHello(name: string): void {
  console.log("Hello, " + name + "!");
}

const users: User[] = [
  { id: 1, name: "Alice", active: true, email: "a@example.com" },
  { id: 2, name: "Bob",   active: false }
];

// 泛型 + 类型守卫
function pickActive<T extends { active: boolean }>(list: T[]): T[] {
  return list.filter((item): item is T => item.active);
}

const activeNames: string[] = pickActive(users).map(u => u.name);
sayHello(activeNames.join(", "));

// enum + as const（v5 能高亮关键字，类型推断靠 TS 编译器）
enum Role { Admin, Editor, Viewer }
const roles = [Role.Admin, Role.Viewer] as const;`
};

const code = ref(codeByLang.typescript);

// mode 选项实时随语言切换
const cmOptions = computed<EditorConfiguration>(() => ({
  mode: currentLang.value === "typescript" ? "text/typescript" : "javascript",
  theme: isDark.value ? "material-darker" : "default",
  tabSize: 2,
  readOnly: false,
  autofocus: true,
  autoRefresh: true,
  lineNumbers: true,
  lineWiseCopyCut: true,
  gutters: ["CodeMirror-lint-markers"],
  lint: true,
  extraKeys: {
    Ctrl: "autocomplete",
    Tab: "autocomplete"
  },
  hintOptions: {
    completeSingle: false
  }
}));

// 切语言 → 换 demo + 同步更新 mode
watch(currentLang, lang => {
  code.value = codeByLang[lang];
  cminstance.value?.setOption(
    "mode",
    lang === "typescript" ? "text/typescript" : "javascript"
  );
});

const onReady = (cm: Editor) => {
  cminstance.value = cm;
  cm.on("keypress", () => cm.showHint());
};

watch(
  () => isDark.value,
  async newVal => {
    await nextTick();
    newVal
      ? cminstance.value?.setOption("theme", "material-darker")
      : cminstance.value?.setOption("theme", "default");
  }
);
</script>

<template>
  <el-card shadow="never">
    <template #header>
      <div class="card-header flex items-center justify-between">
        <div>
          <span class="font-medium">
            代码编辑器组件，采用开源的
            <el-link
              href="https://rennzhang.github.io/codemirror-editor-vue3/zh-CN/guide/getting-started"
              target="_blank"
              style="margin: 0 4px 5px; font-size: 16px"
            >
              codemirror-editor-vue3
            </el-link>
          </span>
          <span class="text-xs text-muted ml-2">
            当前 mode:
            <code>{{
              currentLang === "typescript" ? "text/typescript" : "javascript"
            }}</code>
          </span>
        </div>
        <el-radio-group v-model="currentLang" size="small">
          <el-radio-button value="typescript">TypeScript</el-radio-button>
          <el-radio-button value="javascript">JavaScript</el-radio-button>
        </el-radio-group>
      </div>
    </template>
    <Codemirror
      v-model:value="code"
      width="100%"
      height="420px"
      :options="cmOptions"
      :border="true"
      @ready="onReady"
    />
  </el-card>
</template>

<style lang="scss" scoped>
.codemirror-container.bordered {
  border: 1px solid var(--pure-border-color);
}
</style>
