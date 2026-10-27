# pi-jev-lazy-load

A Pi extension that keeps most tool declarations and skill descriptions out of the first model request. It replaces them with a short index and loads them when the prompt names them, when the model asks for them, or, if you opt in, when Jev decides the request needs them.

Built against Pi 1.4.0 extension APIs: `before_agent_start` prompt options, `setActiveTools()`, tool `exposure`, and `ctx.modelRegistry.classify()`.

## Installation

Requires Pi 1.4.0-compatible extension APIs and Node.js 22.19.0 or newer. Install from GitHub:

```sh
pi install git:github.com/dantetekanem/pi-jev-lazy-load
```

Run `/reload` in an existing Pi session, or start Pi again. Start a fresh session to measure startup savings without carrying an older, larger prompt history.

The default is `local` mode: lazy loading works without a classifier or API key. To enable Jev, follow [Configuration](#configuration). Pi supplies the host dependencies; you do not need to run `pnpm install` in the package directory.

To update or remove the package:

```sh
pi update git:github.com/dantetekanem/pi-jev-lazy-load
pi remove git:github.com/dantetekanem/pi-jev-lazy-load
```

Reload Pi after either command. Removal does not delete your separate `jev-lazy-load.json` configuration.

For a local checkout, use `pi -e ./pi-jev-lazy-load` for one invocation instead of installing it.

## What the model sees

Before the first model request on a session branch, these stay declared:

- Pi's built-in tools that are active (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell`), plus `codemode` and `tool_search` when they are active
- `load_capabilities`, the loader this extension adds
- tools and skills that your instructions (AGENTS.md, CLAUDE.md, APPEND_SYSTEM.md) write in backticks, such as `spawn_agent` or `humanizer`, so rules that name a tool can be followed without an extra step
- names in the `keep` setting
- names the prompt asks for: a backticked name, `/skill:name`, or a name with `_` or `-` written as a whole word, such as `chrome_navigate`

Every other active tool and listed skill moves into a `<lazy_capabilities>` section of the system prompt, grouped by the package that registered it:

```text
<lazy_capabilities>
These installed tools and skills are not loaded yet. Before using one, call `load_capabilities` directly as a tool call, never through `codemode`: `tools.load_capabilities` does not exist there. Pass its name, the group name from its `---` line, or a short description of the need. Wait for loading to finish before calling the loaded tools. Calling an unloaded tool directly fails.
--- pi-solid-tasks tools
task_wait, task_create, task_append, task_prepend, tasks_create_in_batch, task_list, ...
--- pi-memory tools
memory_write, scratchpad, memory_read, memory_forget, memory_restore, memory_search, memory_status
--- skills
2advanced-design, agentic-search, animate, animate-expo, ...
</lazy_capabilities>
```

Deferred skills leave `<available_skills>`. Skills marked `disable-model-invocation` never appear in the index. The index and the skill list come from the branch's first plan and do not change while the session runs, so the system prompt stays the same from prompt to prompt.

The extension only defers tools that were active. It never activates a tool that your settings, `--tools`, or another extension left inactive. If `load_capabilities` itself is not declared, for example because `--tools` leaves it out, nothing is deferred.

## Loading

- The model calls `load_capabilities` directly, never through `codemode`. It is a model-only tool; `tools.load_capabilities` does not exist in scripts. Call it with `names` (tool names, a group name from a `---` line, or skill names) or with `need`, a short description of the task. Loaded tools are declared from the next model call. For a skill, the result gives its description and SKILL.md path. Without Jev, `need` matches by keywords.
- A later prompt that names a deferred tool or skill loads it before that prompt's first request.
- In `jev` mode, Jev decides loads before each prompt. See the next section.
- `/lazy` shows what is deferred. `/lazy off` restores every deferred tool and the full skill list for the rest of the session.

A call to a tool that is not loaded fails with Pi's unknown tool error, and the tool does not run. Loading changes only what is declared. Every call still passes through Pi's `tool_call` handlers and permission gates. Neither Jev nor the extension approves or blocks a call.

Loaded tools stay declared on that branch. After resume, reload, or `/tree`, Pi reactivates tools the branch never declared, and the extension defers them again before the first request. Tools the branch already loaded stay.

## Jev decisions

In `jev` mode the extension calls the configured classifier, `typesafe/jev-latest` by default, through Pi's `ctx.modelRegistry.classify()`. Before each prompt it asks one yes/no question (TypeSafe's Noul, `bool` in Pi) for each tool group and skill that is still deferred. The state is the prompt text. A long prompt keeps its first 4,000 and last 2,000 characters. Each question carries the group's tool names with the first sentence of each description, or the skill's description.

| Probability | Result |
|---|---|
| 0.7 or more | Loaded before the request |
| 0.3 or more, below 0.7 | Not loaded. A hidden note after the prompt lists it as possibly relevant, with its description |
| Below 0.3 | Stays in the index |

These are the starting thresholds from TypeSafe's Noul documentation. They are not tuned on your sessions. A `need` sent to `load_capabilities` loads at 0.5.

The questions are split into parallel requests that stay under 48,000 estimated tokens, below TypeSafe's default limits of 64k tokens per request and 32k per question. If the classifier is missing, fails, is aborted, or takes longer than `timeoutMs` (1,500 ms by default), the prompt continues without a decision. The index and the loader stay available. The extension does not add a footer status.

`jev` mode sends the prompt text and the deferred tool and skill descriptions to the classifier's provider. It stays off until you turn it on.

## Configuration

To opt into Jev, provide `TYPESAFE_API_KEY` through your environment or secret manager before starting Pi. Do not put credentials in this repository or in the configuration below.

Create `~/.pi/agent/jev-lazy-load.json` (or the same filename under a custom `PI_CODING_AGENT_DIR`):

```json
{
  "mode": "jev",
  "classifier": "typesafe/jev-latest",
  "timeoutMs": 1500,
  "keep": []
}
```

Reload Pi after changing this file. `mode` accepts `local`, `jev`, or `off`; it defaults to `local`. `PI_JEV_LAZY_LOAD=off|local|jev` overrides the file. `classifier` selects a registered Pi classifier as `provider/model`. `timeoutMs` bounds the wait for each decision. `keep` lists tool or skill names that must remain visible.

For native agents managed by `pi-extended-teams`, select this extension in `/agents-extensions` or add its entrypoint to that extension's existing `extensions.allow` list. Keep mandatory agent lifecycle tools visible with `keep`. External Claude harnesses do not run this Pi extension.

## Privacy

`local` and `off` modes do not call a classifier. In `jev` mode, the configured provider receives the current prompt text (or a loader call's `need` text) and candidate tool/skill descriptions. These may contain private information. The extension does not separately read repository files or conversation history for classification, but material already included in the prompt can be sent.

Classifier requests may incur charges. Credentials are resolved by Pi's model runtime, not stored by this extension. The checked-in test credentials are synthetic fixtures.

The measurement script reads a local session file and installed package sources. It runs offline, but its optional `--json` report includes local paths and capability names. Keep session files, reports, credentials, and local configuration out of public commits.

## Measurement

`scripts/measure-payload.ts` rebuilds a persisted session's first request offline. It takes the real tool declarations, skill catalog, instructions, and rules from the session's first system message, runs them through the installed Pi runtime with and without this extension, and serializes each request with Pi's real `openai-codex-responses` serializer for `gpt-6-astra`. The serializer is stopped inside `onPayload`, so nothing is sent.

```sh
node --import ./test/host.ts scripts/measure-payload.ts --session ~/.pi/agent/sessions/<project>/<session>.jsonl
```

An offline replay of one session snapshot (68 tools, 64 skills), using the prompt "Summarize what this project does.", produced:

| Request | Tools | Tool JSON chars | Instructions chars | Body chars | Body vs persisted |
|---|---:|---:|---:|---:|---:|
| Persisted first request | 68 | 125,110 | 78,746 | 206,125 | 0.0% |
| Rebuilt, without the extension | 68 | 124,485 | 78,799 | 204,389 | -0.8% |
| Local mode | 12 | 16,960 | 30,010 | 47,768 | -76.8% |
| Jev loads `pi-auto-review` (mocked classifier) | 20 | 38,280 | 30,208 | 69,873 | -66.1% |
| Next request after `load_capabilities(pi-solid-tasks)` | 24 | 48,692 | 30,010 | 93,866 | -54.5% |

Against the rebuilt request with the same prompt, local mode cuts the body by 76.6%, the tool declarations by 86.4%, and the instructions by 61.9%. The skills section falls from 41,750 to 3,240 characters, the rules section from 17,547 to 7,031, and the tool list from 3,377 to 972. The index adds 2,640.

Every rebuilt prompt section matches the persisted one except the working directory, whose temporary path adds 53 characters. The rebuilt body is 0.8% smaller overall: its prompt is shorter than the real session's prompt and companion note (1,164 characters), and the reconstructed tool schemas serialize 625 characters smaller.

These are character counts of the serialized body. The provider reported 44,764 input tokens for the persisted request. Token savings after the change have not been measured with a provider.

## Tests

```sh
node --import ./test/host.ts --test test/*.test.ts
```

Run the tests and the measurement with `node` directly. `pnpm run` can verify dependencies first and install the declared peer packages into this directory.

The tests run against the installed Pi, found through the `pi` shim on `PATH` or `PI_PACKAGE_ROOT`, with an offline scripted model and a fixture classifier registered through `pi.registerProvider()`. `test/host.ts` blocks global `fetch` and Node socket connections before these checks run, and also removes `*_API_KEY`, `*_TOKEN`, and `*_ACCOUNT_ID` variables. This guards the provider network paths used here; it is not a sandbox for hostile code or subprocesses.

## Limits

- Loading a tool in the middle of a session adds its declaration and re-sends the changed `tools` and `rules` prompt sections. Both are appended. Pi says providers that cannot represent tool changes get a full transcript checkpoint instead, which can miss the prompt cache.
- Another extension that calls `setActiveTools()` in its own `before_agent_start` handler after this one can declare tools again.
- With `codemode` active, a deferred tool is not callable from scripts until it is loaded.
- A skill loaded after the first prompt is announced in the loader result or the hidden note. It is not added back to `<available_skills>`, which keeps the system prompt unchanged.
- Jev latency, cost, and selection accuracy have not been benchmarked. Classifier output is a relevance estimate, not a guarantee.
