const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Validate choices before they become durable goal intent or command arguments. */
export function validateInferenceOptions(value = {}) {
  const result = {};
  if (value.model !== undefined) {
    if (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value.model)) {
      throw new Error('Choose a valid model.');
    }
    result.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!efforts.has(value.reasoningEffort)) throw new Error('Choose a supported reasoning effort.');
    if (value.model === 'gpt-6-luna' && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.reasoningEffort)) {
      throw new Error('This model does not support that reasoning effort.');
    }
    result.reasoningEffort = value.reasoningEffort;
  }
  return result;
}
