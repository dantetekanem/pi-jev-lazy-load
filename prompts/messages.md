## prepared-automatic
Prepared automatically
## prepared-manual
Prepared through the manual loader
## prepared-skill
Skill: {{name}} (~{{tokens}} instruction tokens; {{source}})
## prepared-tool
Tool: {{name}} ({{source}})
## source-named
requested by name
## source-jev
selected by Jev
## source-keyword
keyword match
## failed-skill
Unable to prepare {{name}}: its instructions are missing, unreadable, or empty. Do not assume this skill is loaded.
## loaded-tools
Loaded tools, available from your next call: {{names}}
## loaded-skills
Prepared complete skill instructions for the next model request:
{{items}}
## already-loaded
Already prepared or available: {{names}}
## not-deferred
Unknown or unavailable capabilities: {{names}}. Use the installed catalog names.
## keyword-match
Matched your need by keywords. If these are wrong, load by name from <lazy_capabilities>.
## nothing-loaded
Nothing was loaded. Use names from <lazy_capabilities>, or describe the need more specifically.
## run-maybe
Possibly relevant but not loaded. Load them with `load_capabilities` if the task needs them:
{{items}}
