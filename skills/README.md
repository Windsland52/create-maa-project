# create-maa-project Skills

This directory contains the installable agent skills bundled with create-maa-project. Each skill is
kept in its own folder and has a `SKILL.md` plus optional agent metadata and references.

## Installation

Install the create-maa-project CLI separately because installing a skill does not install npm packages:

```bash
npm install --global create-maa-project@latest
create-maa-project --cli-version
```

Install the skill with the [skills CLI](https://github.com/vercel-labs/skills):

```bash
# List skills available in this repository
npx skills add https://github.com/Windsland52/create-maa-project --list

# Install the create-maa-project skill
npx skills add https://github.com/Windsland52/create-maa-project --skill create-maa-project --global
```

Omit `--agent` for interactive agent detection and selection. Keep the default symlink method so
the skills CLI can maintain one canonical copy across the selected agents.

When developing from a local checkout, use the checkout path instead of the GitHub URL:

```bash
npx skills add . --skill create-maa-project
```

Local-path development installs are not remotely updateable; rerun the command after changing the
Skill.

## Available Skills

### `create-maa-project`

Scaffold and maintain MaaFW (MaaFramework) application projects with the create-maa-project CLI.
Use when creating a new MaaFW pipeline or Python agent project, adding add-ons, syncing project
metadata, updating runtimes or dependencies, diagnosing a project with doctor, or inspecting and
restoring backups.
