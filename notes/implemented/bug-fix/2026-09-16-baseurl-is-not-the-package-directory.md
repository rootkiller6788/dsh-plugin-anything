# Agent Note: `baseUrl` in a bundle patch is the profile directory, not the package directory

Status: implemented

## Problem

To ship a skill inside a bundle, the bundle's patch must mount a `skill-filesystem` row pointing at the
package's own `skills/` directory. The established idiom in the `dsh` repo is an agent preset's row:

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

The first version of this project's patch template copied that verbatim. It is wrong for a bundle patch and
it fails **silently**: the skill simply never loads, with no error at boot or at load.

## Decision

Resolve the skill directory through the package instead of through `baseUrl`:

```yaml
- id: {{TARGET}}-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('dsh-plugin-{{TARGET}}/package.json')) + '/skills'"
```

This works because `baseUrl` **is** correct for the profile directory, and the profile's `node_modules` is
exactly where the bundle was installed — so `createRequire(profileDir)` resolves the package and `dirname`
gives a path that is independent of how the profile was laid out.

## Why the original was wrong

`!!js` expressions are evaluated by the loader as
`new Function('ctx', 'expr', 'with (ctx) { … }')` (`vendor/loader/src/config/utils.ts`), so a bare name
resolves to a property of the **evaluation context**. `baseUrl` is set by app-boot to
`dirname(absoluteConfigPath)` (`packages/boot/app-boot/src/index.ts`).

For an agent preset, that path is the preset's own directory, which is why `new URL('skills/', baseUrl)`
finds the preset's sibling `skills/`. For a bundle patch, the absolute config path is the **profile
directory**, so the same expression resolves to `<profile>/skills/` — a directory that does not exist.

The idiom was correct in its original context and wrong in the new one. Nothing about copying it looked
wrong, which is precisely why it needed verifying rather than assuming.

## Alternatives considered

- **`import.meta.url`.** Not available in a YAML patch; `!!js` is evaluated as a function body with `ctx`
  in scope, not as a module.
- **An absolute path via `dshHomePath(...)`.** Points into the dsh home, not into the installed package, so
  the skill files would have to be copied out of the package at install time — strictly more moving parts.
- **Have the plugin register its skill directory from `apply`.** Conceivable, but it moves a static
  configuration fact into runtime code and depends on the skill provider's registration API, which was not
  verified. The `skill-filesystem` config row is the documented mechanism.
- **Copy the preset idiom and add a note to fix it later.** Rejected: a silently-missing skill is exactly
  the class of failure this project exists to prevent.

## Consequences

- The template carries a comment block explaining the evaluation semantics, so the next person to touch it
  does not "simplify" it back to the broken form.
- `guides/skill-authoring.md` documents the trap with both the wrong and right forms.
- **This remains unverified against a live `dsh`.** No in-repo package ships a skill inside a bundle —
  `find packages apps -type d -name skills` returns only the `cordis` preset's — so the mechanism is
  untrodden. The reasoning is sound and the semantics are read from the loader source, but a live
  `skill({name})` call has not been observed working. `guides/skill-authoring.md` and
  `guides/verification.md` both say so rather than implying it works.
