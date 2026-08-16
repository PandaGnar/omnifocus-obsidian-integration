# Benchmarks

Prefill and decode timings for the local model, measured on the machine that
runs the plugin. Regenerate this file with:

```
ollama serve          # in another terminal, if it is not already running
npm run bench
```

`npm run bench -- --help` lists the flags (base URL, model, sizes, `--no-write`).

## Why these numbers and not one number

The complaint this project started from is **prefill**: time-to-first-token on a
long prompt. Decode on a small local model is generally fine. A single blended
tokens/sec figure would average the problem away, so prefill and decode are
measured and reported separately, and time-to-first-token is taken from the
first streamed token rather than from the end of the call.

Two claims in `plan.md` are marked unverified and this file is what settles
them:

1. Whether the runtime actually trims the sliding-window part of the KV cache
   for this architecture — i.e. whether a large `num_ctx` is affordable. The
   memory table and the scaling verdict below answer it.
2. Whether KV cache quantisation is needed, and whether flash attention is
   active. The same slope bears on the first; the environment block records the
   second as far as a client can observe it.

Everything is measured through the plugin's own Ollama client — same
`/api/chat`, same explicit `num_ctx` — so these are the plugin's timings, not
a separate HTTP path's.

## Status

**Not yet run — no server was reachable when this landed.** No numbers below are real; the tables are empty on purpose rather than filled with placeholders.

## Prefill and decode

| num_ctx | prompt tokens (est.) | prompt_eval_count | TTFT (wall) | prefill (server) | prefill rate | decode rate | tokens generated | stop reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

`TTFT (wall)` is our stopwatch from request to first token and includes model load;
`prefill (server)` is Ollama's own `prompt_eval_duration`. They answer different
questions and are both here on purpose.

## Prompt cache reuse

| num_ctx | cold TTFT | warm TTFT | cold model load | warm model load | saved (load excluded) | cold prompt_eval_count | warm prompt_eval_count | prefix reused |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Each prompt is sent twice, byte-identically, and every run of the benchmark uses a
fresh prompt so a previous run's cache cannot make the cold column a lie. Ollama
reuses the KV cache by longest common prefix, so the second run should evaluate
almost no prompt tokens. `saved (load excluded)` is cold TTFT minus warm TTFT with
each side's `load_duration` taken out first — the benchmark changes `num_ctx`
between cases, which reloads the model before every cold run and before no warm
run, so the raw difference would bill a whole model load to the prompt cache. That
load is the `cold model load` column. The saving is what PR 4's stable-prefix
ordering is buying; `n/a` means the server did not report `load_duration`, and the
two are then not separable.

## Memory and processor

| num_ctx | resident size | in VRAM | PROCESSOR | bytes/context token vs 2k row |
| --- | --- | --- | --- | --- |

Resident size and processor come from `/api/ps`, the same data `ollama ps` prints.
The last column is the marginal cost of context, taken against the smallest row,
because weights and compute buffers do not grow with `num_ctx`.

## KV-cache scaling verdict

Unanswered until the benchmark runs. It needs resident-size readings at two
different context sizes (8192 and 32768 are the interesting pair) and the model
geometry from `/api/show`.

## Environment

Recorded when the benchmark runs.

