/**
 * 测试用桩：把 DSH 宿主运行时里插件会 import 的那几个包替换掉。
 *
 * 为什么需要：lib/index.js 依赖 `@deepseek-ai/dsh-llm` 的 HarnessError。这个包只在
 * DSH 的 profile 里存在，项目目录里没有 node_modules —— 直接 `import('../lib/index.js')`
 * 会 ERR_MODULE_NOT_FOUND，于是「schema 契约自检」这类完全不需要真宿主的测试也跑不起来。
 *
 * 做法：用 Node 自带的 `module.register()` 挂一个 ESM loader，只重定向白名单里的包名，
 * 其余解析原样交给默认 loader（不改变任何文件系统解析规则）。
 *
 * 用法（放在 test 文件最顶部，且必须是 import 形式以便提升到其它 import 之前）：
 *   import { registerHostStubs } from './host-stubs.js';
 *   registerHostStubs();
 */

import { register } from 'node:module';

/** 被替换的包 → 生成的桩模块源码。 */
const STUBS = {
  // HarnessError：内核的带错误码异常。桩里保持同样的 (message, code) 签名与 name。
  '@deepseek-ai/dsh-llm': `
    export class HarnessError extends Error {
      constructor(message, code) {
        super(message);
        this.name = 'HarnessError';
        this.code = code;
      }
    }
    export default { HarnessError };
  `,
  // schemastery：lib/config.js 里用顶层 await 动态 import 它，拿不到就退回恒等 schema。
  '@deepseek-ai/schemastery': `
    const identity = (inner) => inner;
    export default { object: identity, string: () => ({ type: 'string' }), boolean: () => ({ type: 'boolean' }), number: () => ({ type: 'number' }), array: () => ({ type: 'array' }), any: () => ({}), union: () => ({}) };
  `,
};

/** loader 的 resolve/load 钩子源码。以 data: URL 注册，不落盘。 */
const HOOK_SOURCE = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) {
    return { url: 'stub:' + specifier, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('stub:')) {
    const source = STUBS[url.slice(5)];
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

let registered = false;

/** 幂等注册：多个测试文件各自调用也只会注册一次。 */
export function registerHostStubs() {
  if (registered) return;
  registered = true;
  register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE));
}
