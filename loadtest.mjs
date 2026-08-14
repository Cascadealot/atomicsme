import { createJiti } from '/usr/local/lib/node_modules/@bastani/atomic/node_modules/jiti/lib/jiti.mjs';
const jiti = createJiti('/home/observatory/.atomic/agent/extensions/per-model-config', {});
try {
  const m = jiti('./index.ts');
  console.log('loaded ok, default =', typeof m.default);
  console.log('named exports:', Object.keys(m).filter(k=>k!=='default'));
  // exercise pure helpers
  const { applyForApi, effectiveCfg, findCfg } = m;
  const cfg = { temperature: 1, topP: 0.95 };
  const out = applyForApi('openai-completions', cfg, { max_tokens: 100 });
  console.log('applyForApi ->', JSON.stringify(out));
} catch (e) {
  console.error('LOAD ERROR:', e && (e.stack||e.message||e));
}
