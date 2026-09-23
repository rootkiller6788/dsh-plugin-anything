# Authoring and mounting a skill

A skill is an on-demand document the model can load by name. It is how a generated plugin teaches the model
*when* and *how* to use its tools, rather than relying on each tool's one-line description.

## Frontmatter

The parser is the contract — `packages/skill/skill-filesystem/src/index.ts`. A file whose frontmatter is
invalid is logged and skipped, **never fatal**, so a broken skill fails silently. Check it explicitly.

| Rule | Detail |
|---|---|
| Delimiters | The file opens with a line that is **exactly** `---`, closed by another `---` line. No BOM, no leading blank line. |
| `name` | **Required.** Must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` |
| `description` | **Required**, non-empty |
| `whenToUse` | Optional string |
| `metadata` | Optional opaque object |
| `disable-model-invocation` | Optional boolean |
| `user-invocable` | Optional boolean |
| Legacy camelCase | `disableModelInvocation`, `modelInvocable`, `userInvocable` **throw**. Use the kebab-case forms. |
| Booleans | Accept `true`/`false`, `1`/`0`, `true\|yes\|on` / `false\|no\|off` |

Two accepted shapes: a directory bundle `<name>/SKILL.md`, or a flat `<name>.md`. **Recursive
`**/SKILL.md` is not supported.**

```markdown
---
name: dsh-plugin-widget
description: Drive the widget toolchain: build, inspect, and export widgets.
whenToUse: The user asks to build or inspect a widget.
---

# Widget

Body: prerequisites, the tools, the workflow.
```

## Discovery roots

Six ranked roots, nearest-wins for a duplicate name (rank only breaks ties):

| Rank | Root |
|---|---|
| 100 | `<projectRoot>/.dsh/skills` |
| 200 | `<projectRoot>/.agents/skills` |
| 300 | `Config.customSkillDirs` |
| 400 | `<dshHome>/skills` |
| 500 | `<agentsHome>/skills` |
| 600 | `Config.bundledSkillDir` |

`<projectRoot>` is the nearest ancestor containing `.git`. Chokidar watches the roots live, and a
model-facing `write`/`edit` invalidates synchronously.

The model's only skill tool is `skill({name})`. Available skills are advertised through a durable
`<available_skills>` catalog injected at each `agent/pre-step`; a loaded skill is wrapped into
`<skill_content>` / `<skill_resources>` / `<skill_instructions>`.

## Mounting your skill — the part that bites

**Do not assume the host provides skill discovery.** The wiring in `dsh` is:

1. `dsh-base` inserts `skill-filesystem` + `tool-skill`.
2. `dsh-web-app/cordis.patch.yml` **disables both**, so presets own local discovery.
3. `standard` / `code` re-mount `skill-filesystem`; **only `cordis` mounts `tool-skill`** — so only a
   `cordis` agent gets the catalog and loader at all. `minimal` mounts neither.

A plugin that ships a skill must therefore **mount its own discovery row** in its bundle patch.

### The path resolution trap

The agent-preset idiom looks like this:

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

That works **in a preset**, because the preset file itself lives beside its `skills/` directory.

**It does not transfer to a bundle patch.** `!!js` evaluates as
`new Function('ctx', 'expr', 'with (ctx) { … }')` (`vendor/loader/src/config/utils.ts`), so a bare name
resolves to a property of the evaluation context. `baseUrl` is set by app-boot to
`dirname(absoluteConfigPath)` — and for a bundle patch that is the **profile directory**, not your package.
Copied verbatim into a patch, `new URL('skills/', baseUrl)` resolves to `<profile>/skills/`, which does not
exist, and your skill silently never loads.

Resolve through the package instead. The profile's `node_modules` is exactly where your bundle was
installed, so `createRequire` from the profile directory lands in the right place:

```yaml
    - id: {{TARGET}}-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        customSkillDirs:
          - !!js "process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('dsh-plugin-{{TARGET}}/package.json')) + '/skills'"
```

`process.getBuiltinModule` is available on the engines `dsh` supports (Node 22.19+).

## Shipping the skill in the package

The skill must be in `files`, or the published tarball omits it:

```json
"files": ["lib/index.js", "lib/types/**/*.d.ts", "cordis.patch.yml", "skills", "README.md"]
```

Emit the skill **once**, inside the plugin package, at `skills/dsh-plugin-<target>/SKILL.md` — the copy
that ships and is mounted. CLI-Anything also mirrors its skill to a repo-root `skills/` so its own
`npx skills add` distribution can find it; §9 gives that convention to repositories that are themselves
skill-distribution points, and a generated bundle is not one. Mirroring it here would be a second file to
keep in step with the packaged copy.

## No in-repo precedent

No package in the `dsh` repo ships a skill in its bundle: `find packages apps -type d -name skills` returns
exactly one directory, the `cordis` preset's. The mechanism supports it (add to `files`, mount a
`skill-filesystem` row) but it is untrodden ground. Verify it end to end with
`dsh --profile <p> --dump-config` plus a live `skill({name})` call before claiming it works — see
`verification.md`.
