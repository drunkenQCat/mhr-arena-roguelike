<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ modelValue: number; label: string; hint?: string; min?: number; max?: number; step?: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();
const invalid = computed(() => !Number.isFinite(props.modelValue) || props.modelValue < (props.min ?? 0) || (props.max !== undefined && props.modelValue > props.max));
</script>
<template>
  <label class="number-field"><span>{{ label }}</span>
    <input type="number" :aria-label="label" :value="Number.isFinite(modelValue) ? modelValue : ''" :min="min ?? 0" :max="max" :step="step ?? 1" :aria-invalid="invalid"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).valueAsNumber)" />
    <small v-if="hint">{{ hint }}</small>
    <small v-if="invalid" class="warning">请输入 {{ min ?? 0 }}{{ max === undefined ? ' 以上的有效数值' : ` 至 ${max} 之间的数值` }}</small>
  </label>
</template>
