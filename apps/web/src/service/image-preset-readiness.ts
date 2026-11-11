import type {Capability} from './model-catalog';
import {preflightError} from './preflight';
import groups from './catalog/published-image-preset-keys.json';

const registered = new Map<string, string>();
for (const [key, ids] of Object.entries(groups)) {
  for (const id of ids) registered.set(id, key);
}

export function unavailableImagePreset(data: any): string | undefined {
  const selections = data?.presetSelections ?? data?.promptSelection?.presetSelections;
  if (!Array.isArray(selections)) return;
  for (const [index, selected] of selections.entries()) {
    if (!selected) continue;
    const id = selected.presetId || selected.id || selected.promptCode;
    const knownKey = registered.get(id);
    const reserved = /^studio-(role|portrait)-/;
    if (!knownKey && !reserved.test(id || '') && !reserved.test(selected.promptCode || '')) continue;
    // An inline or account-owned custom prompt has no published promptCode.
    // The native clothing picker suffixes its key with a selected subcategory.
    const matchesKey = knownKey && (knownKey === selected.key || knownKey === 'clothing' && selected.key?.startsWith('clothing:'));
    if (!matchesKey || selected.promptHidden || selected.promptCode && (selected.promptCode !== id || !reserved.test(id))
      || selected.revision != null && selected.revision !== 1 || selected.schemaVersion != null && selected.schemaVersion !== '1'
      || selected.id && selected.presetId && selected.id !== selected.presetId) {
      return `第 ${index + 1} 项图片预设（${String(id || selected.key || '未命名').slice(0,100)}）不在当前可用目录中，请移除或重新选择。`;
    }
  }
}

export function validatePublishedImagePreset(node:any,cap?:Capability) {
  if (node.type !== 'rh-image') return;
  const issue = unavailableImagePreset(node.data);
  if (issue) throw preflightError('MODEL_INPUT_UNSUPPORTED',issue,cap,{issues:[{field:'parameters',reason:'PARAMETER_INVALID',component:'PRESETS',sourceNodeId:node.id}]});
}
