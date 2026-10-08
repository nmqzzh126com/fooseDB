<script setup lang="ts">
// CodeMirror v5 全量 import（主题 / hint / lint / 7 种 mode）
import "codemirror/theme/material-darker.css";
import "codemirror/addon/hint/show-hint.css";
import "codemirror/addon/hint/show-hint";
import "codemirror/addon/hint/javascript-hint.js";
import "codemirror/addon/lint/lint.css";
import "codemirror/addon/lint/lint.js";
import "codemirror/addon/mode/overlay.js";
import "codemirror/mode/htmlmixed/htmlmixed.js";
import "codemirror/mode/xml/xml.js";
import "codemirror/mode/javascript/javascript.js";
import "codemirror/mode/css/css.js";
import "codemirror/mode/sass/sass.js";
import "codemirror/mode/vue/vue.js";

import { useDark } from "@pureadmin/utils";
import Codemirror from "codemirror-editor-vue3";
import { computed, reactive, ref, watch } from "vue";
import type { Editor, EditorConfiguration } from "codemirror";

defineOptions({ name: "WelcomeCodeMirror" });

interface Props {
  /** 初始代码内容 */
  modelValue?: string;
  /** 编辑器高度（默认 400px） */
  height?: string;
  /** 是否只读（默认 false） */
  readOnly?: boolean;
  /**
   * 语言 mode。不传默认 Vue SFC 混合高亮（htmlmixed + ts + vue-template + css）。
   * 可传："application/json" | "javascript" | "text/typescript" | "css" | "htmlmixed" | 自定义对象
   */
  mode?: string | Record<string, unknown>;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: "",
  height: "400px",
  readOnly: false,
  mode: ""
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "ready", cm: Editor): void;
  (e: "change", value: string): void;
}>();

// —— 默认 demo（Vue SFC + TS 混合高亮） ——
// 三个闭合标签拆成常量，避免 HTML parser 误伤（SFC 坑）
const _L = "<";
const _SCRIPT_END = _L + "/script>";
const _TEMPLATE_END = _L + "/template>";
const _STYLE_END = _L + "/style>";

const DEFAULT_CODE = `
<script setup lang="ts">
import { ref, computed } from "vue";

interface FooseRow {
  id: number;
  name: string;
  flag?: number;
}

const props = defineProps<{
  title: string;
  rows: FooseRow[];
}>();

const keyword = ref("");

const filtered = computed<FooseRow[]>(() =>
  props.rows.filter(r => r.name.includes(keyword.value))
);

enum RoleType { Admin = 1, User = 2 }
const current: RoleType = RoleType.Admin;
${_SCRIPT_END}

<template>
  <div class="welcome">
    <h2>{{ props.title }} · {{ current }}</h2>
    <input v-model="keyword" placeholder="搜索..." />
    <ul>
      <li v-for="row in filtered" :key="row.id">
        #{{ row.id }} · <strong>{{ row.name }}</strong>
        <span v-if="row.flag">🚫</span>
      </li>
    </ul>
    <p v-if="!filtered.length" class="empty">暂无数据</p>
  </div>
${_TEMPLATE_END}

<style scoped>
.welcome {
  padding: 16px;
  border-radius: 8px;
  background: #1e1e1e;
  color: #d4d4d4;
}
.welcome h2 { color: #4ec9b0; }
.empty { color: #6c6c6c; font-style: italic; }
${_STYLE_END}`;

//const { isDark } = useDark();
const cminstance = ref<Editor | null>(null);
const code = ref(props.modelValue || DEFAULT_CODE);

// —— Vue SFC 混合高亮 mode ——
// htmlmixed + 自定义 tags：script[lang=ts]→text/typescript, template→vue-template, style→css/scss
const vueSfcMode = {
  name: "htmlmixed",
  tags: {
    script: [
      ["lang", /^ts$/i, "text/typescript"],
      ["type", /typescript/i, "text/typescript"],
      ["lang", /coffee(script)?/i, "coffeescript"],
      ["type", /(?:x-)?coffee(?:script)?$/i, "coffeescript"],
      ["lang", /^babel$/i, "javascript"],
      ["type", /^text\/babel$/i, "javascript"],
      ["type", /^text\/ecmascript-\d+$/i, "javascript"],
      [null, null, "javascript"]
    ],
    style: [
      ["lang", /^scss$/i, "text/x-scss"],
      ["lang", /^sass$/i, "sass"],
      ["lang", /^less$/i, "text/x-less"],
      ["lang", /^stylus$/i, "stylus"],
      ["type", /^(text\/)?(x-)?scss$/i, "text/x-scss"],
      ["type", /^(text\/)?(x-)?sass$/i, "sass"],
      [null, null, "css"]
    ],
    template: [
      ["lang", /^pug$/i, "pug"],
      ["lang", /^handlebars$/i, "handlebars"],
      [null, null, "vue-template"]
    ]
  }
} as const;

const cmOptions = computed<EditorConfiguration>(() => ({
  mode: (props.mode
    ? typeof props.mode === "string"
      ? props.mode
      : props.mode
    : (vueSfcMode as unknown as EditorConfiguration["mode"])) as EditorConfiguration["mode"],
  theme: "material-darker", //isDark.value ? "material-darker" : "default",
  tabSize: 2,
  readOnly: props.readOnly,
  autofocus: false,
  autoRefresh: true,
  lineNumbers: true,
  lineWiseCopyCut: true,
  gutters: ["CodeMirror-lint-markers"],
  lint: true,
  extraKeys: {
    Ctrl: "autocomplete",
    Tab: "autocomplete"
  },
  hintOptions: { completeSingle: false }
}));

const onReady = (cm: Editor) => {
  cminstance.value = cm;
  cm.on("keypress", () => cm.showHint());
  cm.on("change", () => {
    const val = cm.getValue();
    code.value = val;
    emit("update:modelValue", val);
    emit("change", val);
  });
  emit("ready", cm);
};

/** 让编辑器失焦（解决 el-tab-pane aria-hidden 可访问性告警） */
const blur = () => {
  const ta = cminstance.value?.getInputField();
  ta?.blur();
};

// 主题随深色模式切换
// watch(
//   () => isDark.value,
//   dark => {
//     dark
//       ? cminstance.value?.setOption("theme", "material-darker")
//       : cminstance.value?.setOption("theme", "default");
//   }
// );

// 外部 prop 变化同步到内部 code
watch(
  () => props.modelValue,
  val => {
    if (val !== undefined && val !== code.value) {
      code.value = val;
    }
  }
);

defineExpose({
  getValue: () => cminstance.value?.getValue() ?? code.value,
  setValue: (v: string) => {
    if (cminstance.value) cminstance.value.setValue(v);
    else code.value = v;
  },
  blur
});
</script>

<template>
  <Codemirror
    v-model:value="code"
    width="100%"
    :height="height"
    :options="cmOptions"
    :border="true"
    @ready="onReady"
  />
</template>

<style scoped>
/* 主题细节可按需覆盖，默认用 material-darker */
</style>
