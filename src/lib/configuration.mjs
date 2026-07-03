// Configuration-worker integration. Registers openwiki's config schema so the
// default model and page-writer concurrency are editable in the console and
// hot-reload on change. Env vars seed the defaults on first registration.
const CONFIG_ID = 'openwiki';
const CONFIG_FN_ID = 'openwiki::on-config-change';

const DEFAULTS = {
  model: process.env.OPENWIKI_MODEL || 'claude-sonnet-4-6',
  max_parallel: Math.max(1, parseInt(process.env.OPENWIKI_MAX_PARALLEL || '3', 10)),
};

function schema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      model: {
        type: 'string',
        description: 'Default generation model id, routed via llm-router (e.g. claude-sonnet-4-6).',
        default: DEFAULTS.model,
      },
      max_parallel: {
        type: 'integer',
        minimum: 1,
        maximum: 16,
        description: 'Concurrent page writers per generation.',
        default: DEFAULTS.max_parallel,
      },
    },
  };
}

export function defaults() { return { ...DEFAULTS }; }

export async function registerConfig(iii) {
  await iii.trigger({
    function_id: 'configuration::register',
    payload: {
      id: CONFIG_ID,
      name: 'OpenWiki',
      description: 'OpenWiki worker: default model and page-writer concurrency.',
      schema: schema(),
      initial_value: DEFAULTS,
    },
  });
}

export async function fetchConfig(iii) {
  try {
    const res = await iii.trigger({ function_id: 'configuration::get', payload: { id: CONFIG_ID, raw: false } });
    const v = res && typeof res === 'object' && 'value' in res ? res.value : res;
    return { ...DEFAULTS, ...(v || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function bindConfigTrigger(iii, onChange) {
  iii.registerFunction(
    CONFIG_FN_ID,
    async () => { await onChange(); return null; },
    { description: 'Reload runtime config when the openwiki configuration entry changes.' },
  );
  try {
    iii.registerTrigger({
      type: 'configuration',
      function_id: CONFIG_FN_ID,
      config: { configuration_id: CONFIG_ID, event_types: ['configuration:updated'] },
    });
  } catch { /* configuration worker may be absent; env defaults apply */ }
}
