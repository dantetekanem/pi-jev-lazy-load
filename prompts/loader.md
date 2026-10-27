Load tools and skills listed in <lazy_capabilities> so you can use them.

Call `load_capabilities` directly as a tool call, never through `codemode`. It is model-only: `tools.load_capabilities` does not exist in codemode. Wait for loading to finish before calling the loaded tools.

Pass `names` with tool names, group names from the `---` lines (for example `pi-chrome`), or skill names. Pass `need` with a short description of the task when you do not know the names. Loaded tools are available from your next call. For a loaded skill, read the SKILL.md path in the result before following it. Loading a tool does not approve any call to it.
