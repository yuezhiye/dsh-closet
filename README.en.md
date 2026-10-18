# dsh-closet

> Temporary script & log manager for DSH (DeepSeek Harness): **register scripts per workspace, scan leftovers read-only, sweep them into a restorable trash.**

[中文](./README.md) | English

DSH sessions leave a trail of one-off scripts and logs — `fix-xxx.ps1`, `upgrade-xxx.ps1`, `restart-dsh.log`, `*.bak`. Nobody remembers which ones still matter. Closet gives them **one drawer**: registered entries are on the ledger, unregistered ones get scanned and reported, and anything swept goes to trash first — always restorable.

## Three rules

1. **Per workspace** — data lives in `<workspace>/.dsh-fix/`, never in your home directory.
2. **Scan never deletes** — `closet_scan` only reports, with reasons.
3. **Clean only moves** — swept files go to `.dsh-fix/trash/<batch>/` with a `manifest.json` holding their original paths. Real deletion has exactly one entry point: expiry, default 30 days, dry-run by default.

## Layout

```
<workspace>/
└── .dsh-fix/
    ├── registry.json          # path / language / purpose / status / run count
    ├── logs/<script-name>/     # full output per run, one file per timestamp
    └── trash/<batch>/          # manifest.json + the moved files
```

## Tools

| Tool | What it does | Writes? |
| --- | --- | --- |
| `closet_register` | Register a script: path, purpose, language, status | ledger only |
| `closet_list` | List the ledger, flag entries whose file is gone | no |
| `closet_scan` | Scan the workspace for leftovers with reasons | **no** |
| `closet_run` | Execute a registered script, capture output to a log | log only |
| `closet_clean` | Move listed files into trash (restorable) | moves |
| `closet_trash` | Inspect batches; `expire: true` prunes old ones (dry-run first) | only on expiry |
| `closet_logs` | List a script's logs, or tail one | no |

There is also a GUI panel under **Settings → Scripts & Logs**.

## Languages

`powershell` (`.ps1 .psm1 .psd1`), `node` (`.js .mjs .cjs .ts`), `python` (`.py`), `batch` (`.bat .cmd`), `shell` (`.sh .bash .zsh`). Interpreters are configurable.

## Configuration

```yaml
dsh-closet:
  enabled: true
  dataDir: .dsh-fix
  trashRetentionDays: 30
  ignore: []                 # extra names or globs, e.g. ['*.bak', 'build']
  maxScanFiles: 5000
  maxScanDepth: 64
  runTimeoutMs: 120000
  maxLogBytes: 2097152
  maxCleanBatch: 200
  maxCleanBytes: 209715200
  interpreters: {}           # { python: ['C:\\Python312\\python.exe'] }
```

An `ignore` entry that cannot be parsed is dropped rather than treated as "ignore everything", so a bad config can only make scans noisier, never silently empty.

## Safety

- **No accidental deletion** — clean only moves; the single deletion path is expiry, which defaults to dry-run.
- **No escapes** — only files inside the workspace are touched; `..` traversal, case variants and symlink/junction indirection are all rejected (literal *and* real-path checks).
- **No runaway scans** — `node_modules` / `.git` are skipped, symlinks are not followed, depth and file counts are capped.
- **No corrupt ledger** — `registry.json` is written atomically; a damaged file is renamed aside before rebuilding.
- **No hung scripts** — timeouts kill the whole process tree (`taskkill /T` on Windows, process group on POSIX).

## Development

```bash
npm test           # 85 unit cases + 16 end-to-end smoke checks + docs consistency; zero dependencies
npm run test:unit
npm run lint:syntax
```

`store` / `scan` / `run` / `trash` do not depend on DSH and can be used and tested standalone. `lib/client.js` is a hand-written `window.__ModuleLoader__` CJS factory — no bundler needed, and edits hot-reload. Changes to `lib/index.js`, `package.json` or `cordis.patch.yml` require a DSH restart.

## License

MIT
