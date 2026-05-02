# Security Operations

## Collaboration Policy
- Only grant `Read` access by default for collaborators.
- Grant write access temporarily per task, then remove.
- Keep workflow and server changes owner-reviewed.

## Secret Management
- Never commit real secrets to Git.
- Store runtime secrets in Fly secrets and/or GitHub Actions secrets.
- Rotate operational secrets on a schedule and after collaborator changes.

## Rotation Targets
- `BOT_API_SECRET`
- `ADMIN_SECRET`
- `DISCORD_TOKEN`
- `DISCORD_BOT_TOKEN`
- `GITHUB_TOKEN`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SMTP_PASS`

## Fly Secret Rotation (example)
```powershell
flyctl secrets set -a zenith-license BOT_API_SECRET=<new> ADMIN_SECRET=<new>
flyctl secrets set -a zenith-discord-bot BOT_API_SECRET=<new> ADMIN_SECRET=<new>
```

## Verification
- `flyctl secrets list -a zenith-license`
- `flyctl secrets list -a zenith-discord-bot`
- Check app health endpoints after rotation.

## Note on Branch Protection
Private-repo branch protection and rulesets may require GitHub Pro/Team.
If unavailable, keep collaborators read-only and use owner-only merges.
