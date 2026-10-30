# pi-jev-lazy-load

A Pi extension that prepares tool declarations and complete skill instructions before the model needs them. It keeps a compact capability catalog, recognizes names in the request, and optionally lets Jev select relevant capabilities. `load_capabilities` is the manual fallback.

A listed skill is not a loaded skill. Its description can remain visible while its instructions wait until needed. Once selected, the extension reads its SKILL.md and supplies the instructions on model requests, including after reload and compaction.

Built against Pi 1.4.0 extension APIs: prompt options, request-context transforms, input/message lifecycle events, `setActiveTools()`, custom entry renderers, and `ctx.modelRegistry.classify()`.

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

The request can activate additional tools and prepare skill instructions before the first model call. Distinctive names accept unambiguous spaced aliases, such as `team leader` for `team-leader`. Plain names such as `docs` require backticks, a skill command, or semantic selection.

Every other active tool and listed skill moves into a `<lazy_capabilities>` section of the system prompt, grouped by the package that registered it. Each entry includes its name and up to 320 characters of its installed description, so the model can choose a capability even without a Jev suggestion. Descriptions keep multiple sentences, normalize whitespace, and truncate at a word boundary when possible. They are selection hints; full instructions and schemas remain behind the loader.

An abbreviated example:

```text
<lazy_capabilities>
Installed capability catalog. This index stays stable; it is not a list of what is currently unavailable. Jev prepares matching tool declarations and complete skill instructions automatically. If a needed capability is still unavailable, call `load_capabilities` directly, never through `codemode`. Loading never grants permission to act.
--- pi-solid-tasks tools
- task_create: Create one task for authorized work. Prefer tasks_create_in_batch for a known multi-task plan.
- task_list: Show the task list when a queue overview is needed or a completion handoff is stale.
--- pi-memory tools
- memory_write: Write durable facts to MEMORY.md or append notes to the daily log.
- memory_search: Search memory files by keyword, semantic similarity, or deep search.
--- skills
- agentic-search: Find definitions, references and tests, trace calls, or gather context before editing.
- animate-expo: Build React Native and Expo animations with Reanimated, Gesture Handler and haptics.
</lazy_capabilities>
```

Deferred skills leave `<available_skills>`. Skills marked `disable-model-invocation` never appear in the index. The names in the index and the visible skill list come from the branch's first plan. Descriptions come from the installed catalog, including when resuming sessions created before descriptive indexes. Loading a capability does not rewrite the index; its text stays stable while the catalog is unchanged.

The extension only defers tools that were active. It never activates a tool that your settings, `--tools`, or another extension left inactive. If `load_capabilities` itself is not declared, for example because `--tools` leaves it out, nothing is deferred.

## Loading

- Ordinary prompts automatically select named capabilities, including skills whose descriptions were already visible. In `jev` mode, the classifier can also select those skills.
- A selected skill is read from the installed catalog path. Its frontmatter is removed, and the full body and reference directory are supplied through Pi's request-context hook. Missing, unreadable, or empty files produce an error, not a successful activation.
- `load_capabilities` uses the same activation path. Call it directly, never through `codemode`, with `names` or a short `need`. Without a classifier decision, `need` uses keyword matching. Prepared instructions reach the next model request without a separate agent read.
- `/lazy` reports deferred tool declarations, prepared skills, and classifier status. `/lazy team-leader` distinguishes a visible description from prepared instructions. `/lazy stats` reports local usage. `/lazy off` stops automatic preparation and restores the tool and skill catalogs.

Each successful preparation batch creates a themed **Jev** card. It lists skills and tools, distinguishes automatic preparation from the manual loader, and records whether selection came from a name, Jev, or keywords. Skill token estimates count the instruction body at four characters per token, excluding the surrounding envelope. Repeating an unchanged preparation creates no new card. A card records prepared work, not provider receipt or model adherence.

Cards are durable display-only entries, outside model context. The full skill instructions are a separate, request-local context message. They are reapplied without accumulating copies in conversation history; an identical body already in that request is reused with its source-directory guidance. Referenced files remain the agent's responsibility. No footer change or extra model turn is needed.

Queued steering and follow-up inputs need earlier tool preparation because Pi snapshots tool declarations before delivering those messages. Tools for expanded user inputs and queued custom messages are prepared at native turn and settlement boundaries, before the next declaration snapshot. Selected skill instructions wait until delivery. Thus a queued request can show a tool card before its skill card. Removing a queued request does not unload tools already prepared for it.

Activation receipts follow the selected branch through reload, resume, tree navigation, and compaction. Legacy skill-load records count as metadata exposure, not proof that instructions were read. Their existing notices remain renderable. Selected files are read again for requests, so missing files are reported instead of silently treating an old receipt as current instructions.

Tool activation is not authorization. Pi's exposure rules still apply: inactive direct tools are unavailable, while registered `codemode` and `deferred` tools can remain callable through nested execution. Permission handlers remain responsible for every call. Tools not eligible in the original active catalog are not newly enabled by this extension.

## Jev decisions

In `jev` mode the extension calls the configured classifier, `typesafe/jev-latest` by default, through Pi's `ctx.modelRegistry.classify()`. For a request it asks one yes/no question (TypeSafe's Noul, `bool` in Pi) for each deferred tool group and each skill whose instructions have not been prepared. A skill can be a candidate even when its description is already visible. Queued inputs reuse their selection when delivered. The state is the prompt text. A long prompt keeps its first 4,000 and last 2,000 characters. Each question carries the group's tool names and up to 1,000 characters of each tool's description, or up to 1,000 characters of the skill's description. This gives Jev more context than the short agent-facing index, including later usage guidance within that limit. Neither view includes tool argument schemas.

| Probability | Result |
|---|---|
| 0.7 or more | Loaded before the request |
| 0.3 or more, below 0.7 | Not loaded. A hidden note after the prompt lists it as possibly relevant, with its description |
| Below 0.3 | Stays in the index |

These are the starting thresholds from TypeSafe's Noul documentation. They are not tuned on your sessions. A `need` sent to `load_capabilities` loads at 0.5.

The questions are split into parallel requests that stay under 48,000 estimated tokens, below TypeSafe's default limits of 64k tokens per request and 32k per question. Oversized questions are clipped to fit the per-question budget. A clipped tool group still loads as a whole if selected, though the classifier does not see every tool's description. If the classifier is missing, fails, is aborted, or takes longer than `timeoutMs` (1,500 ms by default), the prompt continues without a decision. The index and the loader stay available. The extension does not add a footer status.

`jev` mode sends the prompt text and the deferred tool and skill descriptions to the classifier's provider. It stays off until you turn it on.

## Usage statistics

```text
/lazy stats          # current session, including earlier runs and branches
/lazy stats today    # all sessions today, using the machine's local calendar
/lazy stats all      # all recorded usage in this agent directory
```

The report shows decision outcomes; classifier dispatch counts and success rate; observed HTTP attempts; average and p95 dispatch wait; the five most-loaded groups, tools, and skills; load sources (`jev`, `named`, `keyword`); and tool-call outcomes. One decision can dispatch several batches. A missing classifier counts as a failed decision with zero dispatches. `ok` means the classifier completed normally, not that its selection was useful.

HTTP counters observe each adapter fetch call, including TypeSafe's internal retries, through Pi's per-request `fetch` option. They show attempts started, HTTP-success responses, and HTTP/transport errors. Other classifiers must honor that option to be counted. Counts do not prove server receipt, billing, or redirect hops. Responses are counted when they arrive, so a day boundary or in-flight request can separate an attempt from its outcome.

Latency includes failed requests and the time spent waiting before a timeout or cancellation. Late responses do not rewrite the recorded outcome. A timed-out decision can contain successful batches, even though the extension discards that decision's selections.

Loads count successful preparation receipts: newly activated tools and newly read skill instructions. A visible skill description does not count as prepared instructions. Named loads include prompt names and explicit `load_capabilities` names. Keyword loads are the fallback for a loader's `need`; Jev selections count as `jev`. Repeating an unchanged preparation or resuming a session does not count another load. The loaded-versus-used figure matches actual tool invocations to loads by session and tool within the selected view, including invocations that fail. It is not a relevance score: a load yesterday and use today will not match in today's view. Successful call rankings include all tools observed while this extension runs, including nested calls through `codemode`. Calls that enter the tool's `execute` function count as executed, including failures; blocked, invalid, unknown, and pre-execution-cancelled calls count as not executed. Failed/blocked calls do not count toward successful-call rankings. Skill preparation records successful file reads; it does not prove the model followed the instructions.

Records start with this version; older activity is not reconstructed. Resuming preserves the session's totals; a fork with a new session ID has its own totals. The append-only log is `~/.pi/agent/jev-telemetry.jsonl`, or the same filename under `PI_CODING_AGENT_DIR`. Multiple Pi sessions append events rather than overwriting shared counters. The log grows with use and has no automatic retention or rotation. Tests and offline measurements use temporary agent directories.

Telemetry is local in both `local` and `jev` modes. It stores timestamps, session IDs, capability names, outcomes, durations, and load sources—not prompts, descriptions, tool arguments/results, credentials, or provider error text. New log files are owner-readable/writable only. Stats are display-only session entries, excluded from model context, and do not make provider calls. Storage failures never block loading; a report warns when this runtime detects failed storage or unreadable records. `/lazy off` stops deferral, not tool-use observation; configuration `mode: "off"` disables the extension and its commands entirely.

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

`local` and `off` modes do not call a classifier. In `jev` mode, the configured provider receives the current user request, an explicit custom request that starts an idle run, or a loader call's `need`, plus candidate tool/skill descriptions. These may contain private information. Supplemental custom context is not sent for classification. Queued custom messages use local name matching only, because Pi does not distinguish their request intent from supplemental context. The extension does not separately read repository files or conversation history for classification, but material already included in the request can be sent.

Classifier requests may incur charges. Credentials are resolved by Pi's model runtime, not stored by this extension. The checked-in test credentials are synthetic fixtures.

The measurement script reads a local session file and installed package sources. It runs offline, but its optional `--json` report includes local paths and capability names. Keep session files, reports, credentials, and local configuration out of public commits.

## Measurement

The numbers below are historical measurements of metadata-only loading. They have not been rerun for full instruction preparation. Prepared skill bodies now contribute to request size, so these figures are not current token-savings claims.

`scripts/measure-payload.ts` rebuilds a persisted session's first request offline. It takes the real tool declarations, skill catalog, instructions, and rules from the session's first system message, runs them through the installed Pi runtime with and without this extension, and serializes each request with Pi's real `openai-codex-responses` serializer for `gpt-6-astra`. The serializer is stopped inside `onPayload`, so nothing is sent.

```sh
node --import ./test/host.ts scripts/measure-payload.ts --session ~/.pi/agent/sessions/<project>/<session>.jsonl
```

An offline replay of one session snapshot (68 tools, 64 skills), using the prompt "Summarize what this project does.", produced:

| Request | Tools | Tool JSON chars | Instructions chars | Body chars | Body vs persisted |
|---|---:|---:|---:|---:|---:|
| Persisted first request | 68 | 125,110 | 78,746 | 206,125 | 0.0% |
| Rebuilt, without the extension | 68 | 124,485 | 78,799 | 204,389 | -0.8% |
| Local mode | 12 | 16,960 | 62,097 | 80,004 | -61.2% |
| Jev loads `pi-auto-review` (mocked classifier) | 20 | 38,280 | 59,753 | 99,560 | -51.7% |
| Next request after `load_capabilities(pi-solid-tasks)` | 24 | 48,692 | 62,097 | 126,102 | -38.8% |

Against the rebuilt request with the same prompt, local mode cuts the body by 60.9%, the tool declarations by 86.4%, and the instructions by 21.2%. The skills section falls from 41,750 to 3,240 characters, the rules section from 17,547 to 7,031, and the tool list from 3,377 to 972. The descriptive index adds 34,727 characters.

For comparison, the name-only index produced a 47,768-character body on this snapshot. Descriptions add 32,236 characters in exchange for giving the agent information to select deferred capabilities. Improved selection accuracy has not been measured.

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
- Tool reachability follows Pi's exposure rules, not just the declared tool list. Loading is not a security boundary.
- Prepared skill bodies are supplied per request, not added to `<available_skills>`. Preparing many skills increases request size; receipts do not evict skills automatically.
- Selection sees the current request, not conversation history. Short follow-ups can be ambiguous to the classifier; explicit names and the manual loader remain available.
- `/lazy stats` measures local request waits and usage, not cost or selection accuracy. Classifier output is a relevance estimate, not a guarantee.
