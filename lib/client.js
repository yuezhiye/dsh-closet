/**
 * dsh-closet 客户端插件（浏览器端）。
 *
 * 形态说明（改了会炸，先读完）：
 *  1. 这是**手写 CJS factory**，不是 ESM。宿主把 `exports["./client"]` 指向的文件当成
 *     「一段交给 window.__ModuleLoader__ 的脚本」，它本身不被 import，所以 package.json
 *     的 `type: "module"` 管不到它 —— 里面绝对不能用 import/export 语法。
 *  2. 入口只由 package.json 的 `exports["./client"]` 决定，**没有** dsh.client.entry 这种字段。
 *  3. `require()` 只能拿外壳基座模块表里的东西：`react` / `react/jsx-runtime` / `react-dom`
 *     / `react-dom/client`。三条真实插件（dsh-purge / dshmarket / billion-context）都只用了这些。
 *     拿不到 `@deepseek-ai/dsh-client-ui-primitives` —— 那是外壳内部模块，第三方入口不存在，
 *     所以样式一律内联 + 读 CSS 变量，跟着明暗主题走。
 *  4. 设置页用 `ctx.slots.inject("settings.section", cb)` 而不是直接 register：这个 slot 是
 *     ui-settings-general 在自己的 apply 里声明的，**谁先激活没有保证**。inject 的语义是
 *     「等该 slot 被声明后再执行 cb」，直接注册可能注册到一个还不存在的 slot 上，静默消失。
 *  5. 接口路径必须写成**文档相对**（不带前导斜杠）：GUI 的 HTML 带 `<base href="./">`，
 *     子路径部署时 `/dsh-closet/...` 会跳出部署前缀，请求根本到不了插件路由。
 *
 * 为什么不用 webserver/index-inject 塞 script：桌面版（Electron）的注入表只在宿主启动时
 * 收集一次，运行期开关插件不会重算；而且 `script-src` 行加载失败会 reject __DSH_BOOT_READY__，
 * 直接把整个应用拖垮。设置页有正规 slot，走 slot。
 */

window.__ModuleLoader__.load({
  id: 'yuezhiye-dsh-closet',

  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const react = require('react');
    const h = react.createElement;

    /** 文案命名空间，与 lib/client.js 里注册的字典键一致。 */
    const NS = 'dsh-closet';

    /**
     * 客户端依赖。
     *  - slots：settings.section 槽（由 ui-settings 提供）
     *  - locale：中文/英文字典
     * 两个都写进 package.json 的 dsh.client.inject，保证它们在模块图里先被物化。
     */
    const inject = ['slots', 'locale'];

    /**
     * 后端接口。全部**文档相对**（无前导斜杠）。
     * 与 lib/routes.js 的 API_BASE = '/dsh-closet/api' 对应：
     * 服务端匹配用的是根绝对路径，浏览器请求用的是文档相对路径，这是两回事。
     */
    const API = {
      status: 'dsh-closet/api/status',
      scripts: 'dsh-closet/api/scripts',
      scan: 'dsh-closet/api/scan',
      logs: 'dsh-closet/api/logs',
      trash: 'dsh-closet/api/trash',
      clean: 'dsh-closet/api/clean',
      restore: 'dsh-closet/api/trash/restore',
      expire: 'dsh-closet/api/trash/expire',
    };

    /* ---------------------------------------------------------------- *
     * 请求层
     * ---------------------------------------------------------------- */

    /** 带超时的请求：卡住的请求比失败的请求更烦人，20 秒还没回就当它挂了。 */
    async function call(path, options) {
      const opts = { cache: 'no-store', credentials: 'same-origin' };
      const init = options || {};
      if (init.body !== undefined) {
        opts.method = init.method || 'POST';
        opts.headers = { 'content-type': 'application/json' };
        opts.body = JSON.stringify(init.body);
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (controller) {
        opts.signal = controller.signal;
        timer = setTimeout(() => controller.abort(), 20000);
      }
      try {
        var response;
        try {
          response = await fetch(path, opts);
        } catch (err) {
          // 连接失败/超时和 HTTP 错误要分开报，否则用户看到的永远是「HTTP undefined」
          if (err && err.name === 'AbortError') throw new Error('请求超时（20 秒没有响应）');
          throw new Error('连不上收纳间接口，确认 DSH 还在运行后按 Ctrl+F5 刷新');
        }
        let payload;
        try {
          payload = await response.json();
        } catch (err) {
          payload = undefined;
        }
        if (!response.ok) {
          const message =
            payload && typeof payload.error === 'string'
              ? payload.error
              : 'HTTP ' + response.status;
          throw new Error(message);
        }
        return payload || {};
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function qs(params) {
      const parts = [];
      for (const key of Object.keys(params || {})) {
        const value = params[key];
        if (value === undefined || value === null || value === '') continue;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      }
      return parts.length ? '?' + parts.join('&') : '';
    }

    /* ---------------------------------------------------------------- *
     * 样式
     * ---------------------------------------------------------------- */

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '2px' },
      card: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,.26))',
        borderRadius: '10px',
        padding: '14px 16px',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        marginBottom: '10px',
      },
      h3: { margin: 0, fontSize: '13.5px', fontWeight: 600 },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' },
      th: { textAlign: 'left', padding: '6px 8px', opacity: 0.66, fontWeight: 500 },
      td: {
        padding: '6px 8px',
        borderTop: '1px solid rgba(127,127,127,.16)',
        verticalAlign: 'top',
      },
      btn: {
        padding: '5px 11px',
        borderRadius: '7px',
        border: '1px solid rgba(127,127,127,.34)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12.5px',
      },
      btnOff: { opacity: 0.5, cursor: 'default' },
      input: {
        padding: '5px 9px',
        borderRadius: '7px',
        border: '1px solid rgba(127,127,127,.34)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12.5px',
        minWidth: '150px',
      },
      mono: {
        fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
        fontSize: '12px',
      },
      pre: {
        margin: 0,
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.10)',
        fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
        fontSize: '11.5px',
        maxHeight: '260px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      muted: { opacity: 0.62, fontSize: '12px' },
      err: { color: '#e5484d', fontSize: '12.5px' },
      tags: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      tag: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,.3)',
        fontSize: '11.5px',
        opacity: 0.85,
        // 表格里空间紧张时「待确认」会被折成两行，标签一律强制单行
        whiteSpace: 'nowrap',
      },
      // 宽度 1% = 浏览器按内容挤到最小，剩余空间自动让给文件/理由这两列
      tdFit: { width: '1%', whiteSpace: 'nowrap' },
    };

    /* ---------------------------------------------------------------- *
     * 小工具
     * ---------------------------------------------------------------- */

    function fmtBytes(n) {
      const num = Number(n);
      if (!Number.isFinite(num) || num < 0) return '-';
      if (num < 1024) return num + ' B';
      const units = ['KB', 'MB', 'GB'];
      let value = num / 1024;
      let i = 0;
      while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i += 1;
      }
      return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
    }

    function fmtTime(iso) {
      if (!iso) return '-';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const pad = (x) => String(x).padStart(2, '0');
      return (
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        ' ' +
        pad(d.getHours()) +
        ':' +
        pad(d.getMinutes())
      );
    }

    /** 长路径中间省略，保留头尾 —— 面板宽度有限，全路径会把表格撑爆。 */
    function shortPath(p, keep) {
      const text = String(p || '');
      const limit = keep || 52;
      if (text.length <= limit) return text;
      const head = Math.ceil((limit - 3) / 2);
      const tail = Math.floor((limit - 3) / 2);
      return text.slice(0, head) + '…' + text.slice(text.length - tail);
    }

    const SUGGESTION_TEXT = {
      keep: '保留',
      archive: '可归档',
      review: '待确认',
    };

    const STATUS_TEXT = {
      active: '使用中',
      done: '已完成',
      obsolete: '已废弃',
    };

    function Btn(props) {
      const style = props.disabled ? { ...S.btn, ...S.btnOff } : S.btn;
      return h(
        'button',
        {
          type: 'button',
          style: style,
          disabled: props.disabled === true,
          title: props.title,
          onClick: props.onClick,
        },
        props.children,
      );
    }

    /* ---------------------------------------------------------------- *
     * 面板组件
     * ---------------------------------------------------------------- */

    /**
     * 设置页一节：脚本与日志。
     *
     * 设计取向（照用户的三条铁律）：
     *  - 扫描只**列清单**，不删任何东西；删除必须人工勾选 + 明确点按钮。
     *  - 清运 = 移进回收站，不真删；真删只有「清理过期」那条路，且默认是干跑。
     *  - 每一处危险动作旁边都写清后果，不靠用户记。
     */
    function ClosetPanel(props) {
      const [workspace, setWorkspace] = react.useState('');
      const [status, setStatus] = react.useState(null);
      const [scripts, setScripts] = react.useState([]);
      const [scan, setScan] = react.useState(null);
      const [batches, setBatches] = react.useState([]);
      const [logView, setLogView] = react.useState({ script: '', text: '', files: [] });
      const [error, setError] = react.useState('');
      const [notice, setNotice] = react.useState('');
      const [busy, setBusy] = react.useState('');
      const [picked, setPicked] = react.useState({});
      const [hideTracked, setHideTracked] = react.useState(false);

      /** 统一动作包装：串行防重入，异常转成一行错误，不吞不掉。 */
      const run = react.useCallback(async (label, task) => {
        setBusy(label);
        setError('');
        try {
          return await task();
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
          return undefined;
        } finally {
          setBusy('');
        }
      }, []);

      const ws = workspace.trim();

      const refreshScripts = react.useCallback(
        async (target) => {
          const data = await call(API.scripts + qs({ workspace: target }));
          setScripts(Array.isArray(data.scripts) ? data.scripts : []);
          if (data.registryError) setError('登记册读取告警：' + data.registryError);
        },
        [],
      );

      const refreshStatus = react.useCallback(async (target) => {
        const data = await call(API.status + qs({ workspace: target }));
        setStatus(data);
      }, []);

      const refreshTrash = react.useCallback(async (target) => {
        const data = await call(API.trash + qs({ workspace: target }));
        setBatches(Array.isArray(data.batches) ? data.batches : []);
      }, []);

      /** 扫一次并把结果落进状态；错误往外抛，由外层 run 统一收。 */
      const loadScan = react.useCallback(
        async (target, skipTracked) => {
          const data = await call(
            API.scan + qs({ workspace: target, skipTracked: skipTracked ? 'true' : '' }),
          );
          setScan(data);
          setPicked({});
          const tracked = (data.summary && data.summary.tracked) || 0;
          setNotice(
            data.total === 0
              ? '没扫到遗留物。'
              : '扫到 ' +
                  data.total +
                  ' 项，其中体积合计 ' +
                  fmtBytes((data.summary && data.summary.bytes) || 0) +
                  '。' +
                  (tracked ? '（' + tracked + ' 项已被 git 跟踪，默认不可清运）' : '') +
                  (data.git && data.git.available === false
                    ? ' 注意：当前工作区不是 git 仓库，跟踪保护未生效。'
                    : ''),
          );
          return data;
        },
        [],
      );

      /** 「连接」= 把工作区的全部信息取一遍（含扫描），一次点击就看得全貌。 */
      const connect = (target) =>
        run('connect', async () => {
          await refreshStatus(target);
          await refreshScripts(target);
          await refreshTrash(target);
          await loadScan(target, hideTracked);
        });

      // 首次进入：只在输入框已经有内容时才自动取一遍，避免空路径报一堆红字。
      // 之后改路径不再自动请求 —— 用户点「连接」才连，避免每敲一个字都打一次接口。
      const autoConnected = react.useRef('');
      react.useEffect(() => {
        if (!ws || autoConnected.current === ws) return;
        autoConnected.current = ws;
        connect(ws);
        // 只在工作区首次出现时跑一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ws]);

      const doScan = () => run('scan', () => loadScan(ws, hideTracked));

      const openLog = (script) =>
        run('logs', async () => {
          const data = await call(API.logs + qs({ workspace: ws, script: script }));
          const files = Array.isArray(data.logs) ? data.logs : [];
          setLogView({ script: script, files: files, text: '' });
          if (files.length) {
            const first = files[0].name;
            const tail = await call(API.logs + qs({ workspace: ws, script: script, log: first }));
            setLogView({ script: script, files: files, text: tail.tail || '（空日志）' });
          } else {
            setLogView({ script: script, files: [], text: '（这个脚本还没有日志）' });
          }
        });

      const readLogFile = (script, name) =>
        run('logs', async () => {
          const data = await call(API.logs + qs({ workspace: ws, script: script, log: name }));
          setLogView({ script: script, files: logView.files, text: data.tail || '（空日志）' });
        });

      const doClean = () =>
        run('clean', async () => {
          const paths = Object.keys(picked).filter((key) => picked[key]);
          if (!paths.length) throw new Error('先勾选要清运的文件');
          const data = await call(API.clean, {
            body: { workspace: ws, paths: paths, label: 'panel' },
          });
          const moved = (data.moved || []).length;
          const failed = (data.failed || []).length;
          setNotice(
            '已移入回收站 ' + moved + ' 项' + (failed ? '，' + failed + ' 项失败' : '') + '。',
          );
          await doScan();
          await refreshTrash(ws);
          await refreshScripts(ws);
        });

      const doRestore = (batch) =>
        run('restore', async () => {
          const data = await call(API.restore, { body: { workspace: ws, batch: batch } });
          setNotice('已还原 ' + (data.restored || []).length + ' 项。');
          await refreshTrash(ws);
          await doScan();
        });

      const doExpire = () =>
        run('expire', async () => {
          // 先干跑，让用户看见到底会删哪些，再问一次才真删
          const preview = await call(API.expire, { body: { workspace: ws, dryRun: true } });
          const list = Array.isArray(preview.expired) ? preview.expired : [];
          if (!list.length) {
            setNotice('没有超过保留期的回收站批次。');
            return;
          }
          const names = list.map((b) => b.batch).join('\n');
          const ok = window.confirm(
            '以下 ' + list.length + ' 个批次超过保留期，将被**永久删除**（不进回收站）：\n\n' + names,
          );
          if (!ok) {
            setNotice('已取消，什么都没删。');
            return;
          }
          const done = await call(API.expire, { body: { workspace: ws, dryRun: false } });
          setNotice('已永久删除 ' + (done.removed || []).length + ' 个批次。');
          await refreshTrash(ws);
        });

      const toggle = (path) => setPicked({ ...picked, [path]: !picked[path] });

      const pickedCount = Object.keys(picked).filter((k) => picked[k]).length;

      /* ---- 渲染 ---- */

      const head = h(
        'div',
        { style: S.head },
        h('h3', { style: S.h3 }, '脚本与日志'),
        h(
          'span',
          { style: S.muted },
          status && status.counts
            ? '登记 ' +
                status.counts.total +
                ' · 使用中 ' +
                status.counts.active +
                ' · 已完成 ' +
                status.counts.done +
                ' · 已废弃 ' +
                status.counts.obsolete
            : '',
        ),
      );

      const wsBar = h(
        'div',
        { style: S.row },
        h('input', {
          style: { ...S.input, minWidth: '320px', ...S.mono },
          placeholder: '工作区绝对路径，例如 E:\\项目\\xxx',
          value: workspace,
          spellCheck: false,
          onChange: (e) => setWorkspace(e.target.value),
        }),
        h(
          Btn,
          { disabled: !ws || busy !== '', onClick: () => connect(ws) },
          busy === 'connect' ? '连接中…' : '连接',
        ),
        status && status.layoutReady === false
          ? h('span', { style: S.muted }, '（这个工作区还没有收纳间，登记第一个脚本时会自动建）')
          : null,
      );

      if (!ws) {
        return h(
          'div',
          { style: S.root },
          head,
          h(
            'div',
            { style: S.muted },
            '收纳间跟着工作区走：每个工作区在 <工作区>/.dsh-fix/ 下有自己的登记册、日志和回收站。先填一个工作区路径。',
          ),
          wsBar,
          error ? h('div', { style: S.err }, error) : null,
        );
      }

      const scriptsCard = h(
        'section',
        { style: S.card },
        h(
          'div',
          { style: S.head },
          h('h3', { style: S.h3 }, '已登记的脚本'),
          h(Btn, { disabled: busy !== '', onClick: () => run('scripts', () => refreshScripts(ws)) }, '刷新'),
        ),
        scripts.length === 0
          ? h('div', { style: S.muted }, '还没有登记任何脚本。可以让 AI 用 closet_register 工具登记。')
          : h(
              'table',
              { style: S.table },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { style: S.th }, '脚本'),
                  h('th', { style: S.th }, '语言'),
                  h('th', { style: S.th }, '状态'),
                  h('th', { style: S.th }, '运行'),
                  h('th', { style: S.th }, '最近运行'),
                  h('th', { style: S.th }, '日志'),
                ),
              ),
              h(
                'tbody',
                null,
                scripts.map((item) =>
                  h(
                    'tr',
                    { key: item.id || item.path },
                    h(
                      'td',
                      { style: S.td },
                      h('div', null, item.purpose || '(未写用途)'),
                      h(
                        'div',
                        { style: { ...S.mono, opacity: 0.62, marginTop: '2px' }, title: item.path },
                        shortPath(item.path),
                      ),
                      item.exists === false
                        ? h('div', { style: { ...S.err, fontSize: '11.5px' } }, '文件已不存在')
                        : null,
                    ),
                    h('td', { style: S.td }, item.language || '-'),
                    h('td', { style: S.td }, STATUS_TEXT[item.status] || item.status || '-'),
                    h('td', { style: S.td }, String(item.runs || 0)),
                    h('td', { style: S.td }, fmtTime(item.lastRunAt)),
                    h(
                      'td',
                      { style: S.td },
                      h(Btn, { disabled: busy !== '', onClick: () => openLog(item.path) }, '查看'),
                    ),
                  ),
                ),
              ),
            ),
      );

      const scanCard = h(
        'section',
        { style: S.card },
        h(
          'div',
          { style: S.head },
          h('h3', { style: S.h3 }, '扫描遗留物'),
          h(
            Btn,
            { disabled: busy !== '', onClick: doScan },
            busy === 'scan' ? '扫描中…' : '扫描',
          ),
        ),
        h(
          'div',
          { style: { ...S.muted, marginBottom: scan && scan.items && scan.items.length ? '8px' : '0' } },
          '只列清单，不动任何文件。勾选后再点下面的按钮才会移进回收站。已被 git 跟踪的文件默认不可勾选。',
        ),
        h(
          'label',
          { style: { ...S.muted, display: 'flex', alignItems: 'center', gap: '6px', margin: '6px 0 8px' } },
          h('input', {
            type: 'checkbox',
            checked: hideTracked,
            onChange: () => {
              const next = !hideTracked;
              setHideTracked(next);
              run('scan', async () => {
                const data = await call(
                  API.scan + qs({ workspace: ws, skipTracked: next ? 'true' : '' }),
                );
                setScan(data);
                setPicked({});
              });
            },
          }),
          '隐藏已被 git 跟踪的文件',
        ),
        !scan
          ? null
          : scan.items && scan.items.length
            ? h(
                'table',
                { style: S.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: { ...S.th, ...S.tdFit } }, ''),
                    h('th', { style: S.th }, '文件'),
                    h('th', { style: { ...S.th, ...S.tdFit } }, '大小'),
                    h('th', { style: { ...S.th, ...S.tdFit } }, '判定'),
                    h('th', { style: S.th }, '理由'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  scan.items.map((item) =>
                    h(
                      'tr',
                      { key: item.path },
                      h(
                        'td',
                        { style: { ...S.td, ...S.tdFit } },
                        h('input', {
                          type: 'checkbox',
                          checked: picked[item.path] === true,
                          disabled: item.tracked === true,
                          title: item.tracked === true ? '已被 git 跟踪，默认不允许清运' : undefined,
                          onChange: () => toggle(item.path),
                        }),
                      ),
                      h(
                        'td',
                        { style: { ...S.td, wordBreak: 'break-all' }, title: item.path },
                        h('div', { style: S.mono }, shortPath(item.relative, 64)),
                        item.tracked === true
                          ? h(
                              'div',
                              { style: { ...S.tag, marginTop: '2px', opacity: 0.85 } },
                              'git 已跟踪',
                            )
                          : null,
                      ),
                      h('td', { style: { ...S.td, ...S.tdFit } }, fmtBytes(item.size)),
                      h(
                        'td',
                        { style: { ...S.td, ...S.tdFit } },
                        h(
                          'span',
                          { style: S.tag },
                          SUGGESTION_TEXT[item.suggestion] || item.suggestion,
                        ),
                      ),
                      h('td', { style: { ...S.td, opacity: 0.72 } }, item.reason || '-'),
                    ),
                  ),
                ),
              )
            : h('div', { style: S.muted }, '没扫到遗留物。'),
        scan && scan.truncated
          ? h(
              'div',
              { style: { ...S.muted, marginTop: '8px' } },
              '清单已截断（超过扫描上限），只展示了前 ' + scan.shown + ' 条。',
            )
          : null,
        scan && scan.items && scan.items.length
          ? h(
              'div',
              { style: { ...S.row, marginTop: '12px' } },
              h(
                Btn,
                { disabled: busy !== '' || pickedCount === 0, onClick: doClean },
                busy === 'clean' ? '清运中…' : '把勾选的 ' + pickedCount + ' 项移进回收站',
              ),
              h('span', { style: S.muted }, '移进回收站不等于删除，随时可以还原。'),
            )
          : null,
      );

      const trashCard = h(
        'section',
        { style: S.card },
        h(
          'div',
          { style: S.head },
          h('h3', { style: S.h3 }, '回收站'),
          h(
            'div',
            { style: S.row },
            h(Btn, { disabled: busy !== '', onClick: () => run('trash', () => refreshTrash(ws)) }, '刷新'),
            h(
              Btn,
              { disabled: busy !== '', onClick: doExpire },
              '清理过期（' + (status && status.config ? status.config.trashRetentionDays : 30) + ' 天）',
            ),
          ),
        ),
        batches.length === 0
          ? h('div', { style: S.muted }, '回收站是空的。')
          : h(
              'table',
              { style: S.table },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { style: S.th }, '批次'),
                  h('th', { style: S.th }, '时间'),
                  h('th', { style: { ...S.th, ...S.tdFit } }, '条目'),
                  h('th', { style: { ...S.th, ...S.tdFit } }, '体积'),
                  h('th', { style: { ...S.th, ...S.tdFit } }, ''),
                ),
              ),
              h(
                'tbody',
                null,
                batches.map((b) =>
                  h(
                    'tr',
                    { key: b.batch },
                    h('td', { style: { ...S.td, ...S.mono, wordBreak: 'break-all' } }, b.batch),
                    h('td', { style: S.td }, fmtTime(b.createdAt)),
                    h('td', { style: { ...S.td, ...S.tdFit } }, String(b.count || 0)),
                    h('td', { style: { ...S.td, ...S.tdFit } }, fmtBytes(b.bytes)),
                    h(
                      'td',
                      { style: { ...S.td, ...S.tdFit } },
                      h(
                        Btn,
                        { disabled: busy !== '', onClick: () => doRestore(b.batch) },
                        '还原',
                      ),
                    ),
                  ),
                ),
              ),
            ),
      );

      const logCard = h(
        'section',
        { style: S.card },
        h(
          'div',
          { style: S.head },
          h(
            'h3',
            { style: S.h3 },
            logView.script ? '运行日志 · ' + shortPath(logView.script, 40) : '运行日志',
          ),
          h(
            'div',
            { style: S.row },
            logView.files.map((f) =>
              h(
                Btn,
                { key: f.name, disabled: busy !== '', onClick: () => readLogFile(logView.script, f.name) },
                f.name + '（' + fmtBytes(f.size) + '）',
              ),
            ),
          ),
        ),
        h('pre', { style: S.pre }, logView.text || '（从上面某个脚本点「查看」）'),
      );

      return h(
        'div',
        { style: S.root },
        head,
        wsBar,
        error ? h('div', { style: S.err }, error) : null,
        notice ? h('div', { style: S.muted }, notice) : null,
        scriptsCard,
        scanCard,
        trashCard,
        logCard,
      );
    }

    /* ---------------------------------------------------------------- *
     * 客户端插件入口
     * ---------------------------------------------------------------- */

    function apply(ctx) {
      // 字典注册包在 effect 里，插件卸载时自动注销，不留脏数据
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: { nav: '脚本与日志' },
            en: { nav: 'Scripts & Logs' },
          }),
        'dsh-closet: dictionaries',
      );

      const t = ctx.locale.bind(NS);

      // 必须用 slots.inject：settings.section 是 ui-settings-general 声明的，
      // 谁先激活没有保证；直接 register 可能注册到还不存在的槽上，然后静默消失。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-closet',
            // dshmarket 是 40、billion-context 是 100，排在它们后面
            order: 120,
            label: () => t('nav'),
            locale: NS,
          },
          ClosetPanel,
        ),
      );
    }

    exports.name = 'dsh-closet';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
