Prepare installed tool declarations and complete skill instructions when automatic selection misses a capability you need. A skill description or catalog entry is not its full instructions; instructions already supplied by Jev do not need another load.

Call `load_capabilities` directly as a tool call, never through `codemode`. It is model-only: `tools.load_capabilities` does not exist in scripts. Wait for the result before using newly declared tools.

Pass `names` with tool names, group names from the catalog's `---` lines, or skill names. Pass `need` with a short description when you do not know the names. Successfully prepared skill bodies are included in the next model request, with paths for resolving references. Failures and already-prepared capabilities are reported explicitly. Loading does not authorize execution or expand the user's request.
