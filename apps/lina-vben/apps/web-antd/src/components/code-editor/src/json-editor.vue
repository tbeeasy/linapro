<script setup lang="ts">
import type { Extension } from '@codemirror/state';

import { computed, ref, watch } from 'vue';
import { Codemirror } from 'vue-codemirror';

import { usePreferences } from '@vben/preferences';

import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { Button, message } from 'ant-design-vue';
import { basicSetup } from 'codemirror';

import { $t } from '#/locales';

import { formatJsonText } from './format';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    /** 编辑区高度；数字按 px 处理，字符串可用 clamp/vh 等任意 CSS 长度 */
    height?: number | string;
    modelValue?: string;
    placeholder?: string;
  }>(),
  {
    disabled: false,
    height: 360,
    modelValue: '',
    placeholder: '',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const { isDark } = usePreferences();

/**
 * 入库的是紧凑文本，展示前格式化一次，让管理员看到缩进后的结构。
 * 用本地状态承接而不是回写 props：回写会与父级设置值的时序竞争，
 * 编辑器可能先渲染出紧凑原文。非法 JSON 原样展示，交给 lint 标注。
 */
function prettyText(value: string) {
  return formatJsonText(value) ?? value;
}

const displayValue = ref(prettyText(props.modelValue));

watch(
  () => props.modelValue,
  (value) => {
    // 自己刚 emit 出去的值回流时不要再格式化一次，避免打断用户输入
    if (value === displayValue.value) {
      return;
    }
    displayValue.value = prettyText(value);
  },
);

// 扩展随主题重算，vue-codemirror 会就地重配，不重建编辑器、不丢撤销历史
const extensions = computed<Extension[]>(() => {
  const list: Extension[] = [
    basicSetup,
    json(),
    linter(jsonParseLinter()),
    lintGutter(),
  ];
  if (isDark.value) {
    list.push(oneDark);
  }
  return list;
});

const editorStyle = computed(() => ({
  height: typeof props.height === 'number' ? `${props.height}px` : props.height,
}));

function handleChange(value: string) {
  displayValue.value = value;
  emit('update:modelValue', value);
}

function handleFormat() {
  const formatted = formatJsonText(displayValue.value);
  if (formatted === null) {
    message.warning($t('pages.editor.json.formatInvalid'));
    return;
  }
  displayValue.value = formatted;
  emit('update:modelValue', formatted);
}
</script>

<template>
  <div
    class="json-editor"
    :class="[$attrs.class, { 'json-editor--disabled': disabled }]"
    data-testid="json-editor"
  >
    <div class="json-editor__toolbar">
      <Button
        data-testid="json-editor-format"
        :disabled="disabled"
        size="small"
        type="link"
        @click="handleFormat"
      >
        {{ $t('pages.editor.json.format') }}
      </Button>
    </div>
    <Codemirror
      :disabled="disabled"
      :extensions="extensions"
      :indent-with-tab="true"
      :model-value="displayValue"
      :placeholder="placeholder"
      :style="editorStyle"
      :tab-size="2"
      @update:model-value="handleChange"
    />
  </div>
</template>

<style scoped>
.json-editor {
  overflow: hidden;
  border: 1px solid hsl(var(--border));
  border-radius: 6px;
}

.json-editor:focus-within {
  border-color: hsl(var(--primary));
}

.json-editor__toolbar {
  display: flex;
  justify-content: flex-end;
  border-bottom: 1px solid hsl(var(--border));
}

.json-editor--disabled {
  cursor: not-allowed;
}

/* 编辑区高度固定，长内容在 CodeMirror 内部滚动 */
.json-editor :deep(.cm-editor.cm-focused) {
  outline: none;
}
</style>
