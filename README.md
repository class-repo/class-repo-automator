**[← Return to ClassRepo setup](https://classrepo.org/dashboard?tab=setup)**

# ClassRepo bot (your copy)

This is the small repository that creates your students' assignment repositories. The [ClassRepo](https://github.com/class-repo/class-repo-site) server starts
it when a student joins one of your assignments. You normally never touch it after setup.

It contains almost nothing on purpose: one workflow, [`provision.yml`](.github/workflows/provision.yml), which runs the
[ClassRepo bot action](https://github.com/class-repo/class-repo-bot-action) pinned to an exact commit. All the logic, and the rules it enforces, live
in that action's repository, where you can read them.

## Setup

Use the setup page on the ClassRepo dashboard. It creates this repository from the template, installs the GitHub App, and stores the secrets the workflow
needs (`CLASSREPO_APP_ID`, `CLASSREPO_APP_PRIVATE_KEY`, `CLASSREPO_ROSTER_PRIVATE_KEY`).

## Updating

Dependabot opens a pull request when a new version of the action is released. Read what changed, then merge it. The dashboard's check step shows which
version your bot is running, and tells students to wait if it is too old to understand the server.

## Privacy

This repository can be public. Workflow runs and logs show only a random batch id; student names, emails and handles are fetched encrypted and are
opened only with a private key that exists here as a secret.
