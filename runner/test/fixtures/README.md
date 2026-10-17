# Runtime fixtures

Real responses captured on 2026-10-11 from loopback servers on macOS (Darwin 25.5.0, arm64).
Directory names carry the runtime version. Do not edit by hand; re-capture and add a new version directory.

| Directory | Runtime | Notes |
|---|---|---|
| `ollama/0.35.1/` | Ollama 0.35.1 (`/api/version`) | Model `qwen2.5:1.5b`. `tags.json` is filtered to two models; `show-*.json` has the license text and tokenizer arrays replaced with `[omitted from fixture]`. |
| `lmstudio/` | LM Studio app 0.4.20+1, `lms` CLI commit 71bd99c, engines `llama.cpp-mac-arm64-apple-metal-advsimd@2.51.0` and `mlx-llm-mac-arm64-apple-metal-advsimd@1.11.0` | Model `google/gemma-3-1b` (MLX 4bit). Server bound to 127.0.0.1 only. |

LM Studio has no HTTP version endpoint (`/api/v1/version`, `/api/v0/version`, `/version` all return an
"Unexpected endpoint" error). App, CLI and engine versions come from `Info.plist`, `lms version` and `lms runtime ls`.

Observed behaviour the adapters must handle:

- LM Studio `/v1/chat/completions` answers HTTP 200 with the loaded model when the requested model does not exist
  (`lmstudio/chat-unknown-model-substituted.txt`). The adapter must compare `response.model` to the request. The native
  `/api/v1/chat` returns 404 `model_not_found` instead.
- LM Studio `/v1/chat/completions` returns an empty `stats` object. Timing and token rate are in the native `/api/v1/chat` stats.
- Ollama durations are nanoseconds. A missing model is HTTP 404 with an `error` string.

Cloud-model and untrusted-locality cases need synthetic fixtures (none could be captured: no cloud model installed). Label them
as synthetic when added.

## LM Studio text fixtures (added for the M4 adapter)

Captured offline on 2026-10-11 with read-only commands (no server started, no model loaded), ANSI escapes stripped:

- `lmstudio/lms-version.txt`: `lms version` (CLI commit 71bd99c).
- `lmstudio/lms-runtime-ls.txt`: `lms runtime ls` (selected llama.cpp 2.51.0 for GGUF, mlx-llm 1.11.0 for MLX).
- `lmstudio/lms-ls.txt`: `lms ls` (installed models).
- `lmstudio/app-info-plist-excerpt.txt`: `plutil -p` of LM Studio.app `Info.plist`, filtered to the name and version keys.

## Synthetic LM Studio data

Not captured from a real runtime; defined in `test/support/fake-lmstudio.ts` and labelled synthetic there:

- `acme/remote-linked-7b`: a native listing entry with an invented `remote_link` marker, to exercise the remote-linked rejection. LM Studio's real marker for a remote-linked model was not observed, so the adapter treats any `remote`/`proxy`/`link`/`cloud`/`upstream`-named field with a truthy value, or a non-`mlx`/`gguf` format, as remote.
- `mystery/model`: a native entry with no format or size, to exercise the unknown-origin rejection.

Synthetic Ollama fixtures (NOT captured from a real server): `ollama/synthetic/models.json` hand-writes a cloud-routed model
(`remote_host`/`remote_model`, as Ollama reports cloud models), a model with no locality signal, and a thinking-capable local model.
No cloud model was installed when the real fixtures were captured. Replace them with captures when one is available.
