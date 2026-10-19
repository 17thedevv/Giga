# Demo integration branch exception

The user requested the hosted demo, a warm UI and a server Gemini key pool in the same session. Source changes remain separately reviewable in the deployment, UI and key-pool PRs, each against main with its own issue. Main is not changed or merged.

To verify them together without merging unreviewed PRs into main, chore/17t-12-demo-integration is a temporary demo-only branch rooted at the deployment candidate. It includes the reviewed-by-tests source commits from the UI and pool branches as explicit integration dependencies. This documents an exception to the single deployment-branch convention, not an additional deployment task or release approval. No independent integration PR is opened to duplicate the source PRs. Human peer approval and complete acceptance remain pending.

Deployment is reversible to d676288090d3c3b5ecb63516f797cf3928885769 and single-key configuration. No destructive migrations, paid plan changes or extra resources are needed. Credentials are configured only in Render backend environment, never this branch.
