<script setup lang="ts">
/**
 * ReQrcode — 二维码渲染组件
 *
 * 依赖 qrcode 库（package.json 已声明 "qrcode": "^1.5.4"）。
 * 把任意文本（URL / 测试链接等）渲染为 canvas 二维码。
 *
 * Props:
 *   text       — 二维码承载的文本（必填）
 *   width      — 画布宽度（默认 200）
 *   margin     — 外边距（默认 1）
 *   errorLevel — 纠错级别 L/M/Q/H（默认 M）
 */
import QRCode from "qrcode";
import { onMounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    text: string;
    width?: number;
    margin?: number;
    errorLevel?: "L" | "M" | "Q" | "H";
  }>(),
  {
    width: 200,
    margin: 1,
    errorLevel: "M"
  }
);

const canvasRef = ref<HTMLCanvasElement | null>(null);

async function render() {
  if (!canvasRef.value || !props.text) return;
  try {
    await QRCode.toCanvas(
      canvasRef.value,
      props.text,
      {
        width: props.width,
        margin: props.margin,
        errorCorrectionLevel: props.errorLevel
      }
    );
  } catch (err) {
    console.error("[ReQrcode] 渲染失败:", err);
  }
}

onMounted(render);
watch(() => [props.text, props.width, props.margin, props.errorLevel], render);
</script>

<template>
  <div class="re-qrcode inline-block">
    <canvas ref="canvasRef" />
  </div>
</template>
