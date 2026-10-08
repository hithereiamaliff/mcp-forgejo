# Upgrading the self-hosted Forgejo instance

Runbook for upgrading **git.mynameisaliff.co.uk**. That's a Forgejo binary install with systemd and PostgreSQL:
- binary: `/usr/local/bin/forgejo`
- config: `/etc/forgejo/app.ini`
- data: `/var/lib/forgejo`
- runs as user `git`

The commands detect all of this, so they also work if paths differ. Every command is copy-paste ready; run them as `root` over SSH.

It's written as **two rounds**:
- **Round 1** changes nothing and causes no downtime. It detects the install and downloads and verifies the new release.
- **Round 2** is the upgrade itself: about 2–5 minutes of downtime, with a full backup first and a ready-made rollback.

Last used for **14.0.3 → 15.0.9** on 2026-10-08 (see [Record](#record-2026-10-08-1403--1509)).

## When to upgrade

- Watch https://forgejo.org/releases/ or the Codeberg release feed. Install patch releases (e.g. 15.0.9 → 15.0.10) promptly, because they're usually security fixes.
- **15.0 is a long-term-support release, supported until 2027-07-15.** The next LTS is 19.0, due 2027-04-15. Non-LTS majors (16, 17, 18) are supported for only about three months each.
- Before **any major upgrade** (e.g. 15 → 19), read the "Breaking" sections of each release note in between: https://codeberg.org/forgejo/forgejo/src/branch/forgejo/release-notes-published

## Round 1: detect, download, verify (no downtime)

**1. Detect the install and pick the target version.** By default this is the newest release in the series you're on (patch upgrade). It saves everything to `/root/forgejo-upgrade.env` so the later steps still work after a disconnect:

```bash
FJ_BIN=$(systemctl show -p ExecStart forgejo | grep -o 'path=[^ ;]*' | head -1 | cut -d= -f2); FJ_BIN=${FJ_BIN:-/usr/local/bin/forgejo}
FJ_CUR=$("$FJ_BIN" --version | sed -E 's/.*version ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
FJ_MAJOR=${FJ_MAJOR:-${FJ_CUR%%.*}}
FJ_NEW=$(curl -fsS "https://codeberg.org/api/v1/repos/forgejo/forgejo/releases?limit=50" | grep -oE '"tag_name":"v'"$FJ_MAJOR"'\.[0-9]+\.[0-9]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
cat > /root/forgejo-upgrade.env <<EOF
FJ_CUR=$FJ_CUR
FJ_NEW=$FJ_NEW
FJ_BIN=$FJ_BIN
FJ_CONF=$(systemctl show -p ExecStart forgejo | grep -o -- '--config [^ ;]*' | head -1 | cut -d' ' -f2)
FJ_WORK=$(systemctl show -p WorkingDirectory --value forgejo)
FJ_USER=$(systemctl show -p User --value forgejo)
FJ_ARCH=$(case "$(uname -m)" in x86_64) echo amd64;; aarch64) echo arm64;; *) echo unknown;; esac)
FJ_BACKUP=/root/forgejo-backup-$(date +%F)-$FJ_CUR
EOF
cat >> /root/forgejo-upgrade.env <<'EOF'
FJ_CONF=${FJ_CONF:-/etc/forgejo/app.ini}
FJ_WORK=${FJ_WORK:-/var/lib/forgejo}
FJ_USER=${FJ_USER:-git}
FJ_DBTYPE=$(awk -F= '/^\[database\]/{s=1;next} /^\[/{s=0} s && $1~/^[ \t]*DB_TYPE[ \t]*$/{gsub(/[ \t"`]/,"",$2);print $2}' "$FJ_CONF")
FJ_DB=$(awk -F= '/^\[database\]/{s=1;next} /^\[/{s=0} s && $1~/^[ \t]*NAME[ \t]*$/{gsub(/[ \t"`]/,"",$2);print $2}' "$FJ_CONF")
EOF
if [ -z "$FJ_NEW" ]; then echo "PROBLEM: could not find a $FJ_MAJOR.x release"; elif [ "$FJ_NEW" = "$FJ_CUR" ]; then echo "Already on the latest $FJ_MAJOR.x release ($FJ_CUR) - nothing to do"; else echo "installed $FJ_CUR -> target $FJ_NEW (settings saved to /root/forgejo-upgrade.env)"; fi
```

**Moving to a new major series** (e.g. LTS 15 → LTS 19): read its release notes first, then run this line before step 1, with the major number you want:

```bash
export FJ_MAJOR=19
```

**2. Show what was detected.** No passwords are printed. Check that there's enough free disk for the backup; you need a bit more than the data size:

```bash
. /root/forgejo-upgrade.env; echo "installed=$FJ_CUR target=$FJ_NEW | binary=$FJ_BIN | config=$FJ_CONF | data=$FJ_WORK | user=$FJ_USER | arch=$FJ_ARCH | db=$FJ_DBTYPE/$FJ_DB"; git --version; sudo -u postgres psql -tAc 'SHOW server_version' 2>/dev/null | sed 's/^/postgres /'; du -sh "$FJ_WORK"; df -h --output=avail,target "$FJ_WORK" /root | tail -n +2
```

**3. Download the new release and verify it.** This checks the SHA-256 checksum and Forgejo's GPG signature, using the release key `EB11 4F5E 6C0D C2BC DD18 3550 A4B6 1A2D C592 3710` from https://forgejo.org/download/:

```bash
. /root/forgejo-upgrade.env && cd /root && F="forgejo-$FJ_NEW-linux-$FJ_ARCH" && U="https://codeberg.org/forgejo/forgejo/releases/download/v$FJ_NEW/$F" && curl -fsSLO "$U" && curl -fsSLO "$U.asc" && curl -fsSLO "$U.sha256" && sha256sum -c "$F.sha256" && gpg --keyserver hkps://keys.openpgp.org --recv-keys EB114F5E6C0DC2BCDD183550A4B61A2DC5923710 && gpg --verify "$F.asc" "$F" && chmod 755 "$F" && "./$F" --version
```

Expect three things:
- `OK` from the checksum
- `Good signature from "Forgejo <contact@forgejo.org>"`. The "not certified with a trusted signature" warning that follows is normal.
- `forgejo version <target>` at the end

## Round 2: upgrade (about 2–5 minutes of downtime)

**4. Finish queued background jobs** while Forgejo is still running:

```bash
. /root/forgejo-upgrade.env && sudo -u "$FJ_USER" "$FJ_BIN" manager flush-queues --config "$FJ_CONF" --work-path "$FJ_WORK"; echo "flush-queues finished (exit code $?)"
```

**5. Stop Forgejo and back up everything**: the database, data directory, config and current binary. If any part fails, it restarts the old version unchanged:

```bash
. /root/forgejo-upgrade.env && systemctl stop forgejo && mkdir -p "$FJ_BACKUP" && sudo -u postgres pg_dump -Fc "$FJ_DB" > "$FJ_BACKUP/forgejo-db.dump" && tar -czf "$FJ_BACKUP/forgejo-data.tar.gz" -C / "${FJ_WORK#/}" && cp -a "$FJ_CONF" "$FJ_BACKUP/app.ini" && cp -a "$FJ_BIN" "$FJ_BACKUP/forgejo-$FJ_CUR" && ls -lh "$FJ_BACKUP" && echo "BACKUP OK - Forgejo is stopped, continue with step 6" || { echo "BACKUP FAILED - restarting the old Forgejo unchanged"; systemctl start forgejo; }
```

**6. Install the new binary and start it.** It only runs if the backup exists, and waits up to 3 minutes while the database migrations run:

```bash
. /root/forgejo-upgrade.env && [ -s "$FJ_BACKUP/forgejo-db.dump" ] && install -m 755 "/root/forgejo-$FJ_NEW-linux-$FJ_ARCH" "$FJ_BIN" && systemctl start forgejo && for i in $(seq 1 60); do v=$(curl -s -m 5 https://git.mynameisaliff.co.uk/api/v1/version); echo "$v" | grep -q "$FJ_NEW" && { echo "UPGRADED: $v"; break; }; sleep 3; done; echo "service: $(systemctl is-active forgejo)"; journalctl -u forgejo --since "-5min" --no-pager | grep -i -E "error|fatal|panic|migrat" | tail -15
```

The `Migration[...]` lines are normal schema updates. Error lines with a timestamp *before* the restart come from the old process.

**7. Run Forgejo's health check.** It's read-only and changes nothing:

```bash
. /root/forgejo-upgrade.env && sudo -u "$FJ_USER" "$FJ_BIN" doctor check --all --config "$FJ_CONF" --work-path "$FJ_WORK" --log-file /tmp/forgejo-doctor.log 2>&1 | tail -40
```

Then list any warnings from the full run:

```bash
grep -E '\[(W|E|C)\]' /tmp/forgejo-doctor.log || echo "no warnings or errors"
```

**8. Check from the outside.** Ask Claude to run `forgejo_hello` on the Forgejo MCP; it should show the new version. Or:

```bash
curl -s https://git.mynameisaliff.co.uk/api/v1/version
```

### Rollback (only if step 6 does NOT print `UPGRADED`)

This restores the old binary, and recreates the database exactly as it was before step 5:

```bash
. /root/forgejo-upgrade.env && systemctl stop forgejo && install -m 755 "$FJ_BACKUP/forgejo-$FJ_CUR" "$FJ_BIN" && sudo -u postgres pg_restore --clean --if-exists --create -d postgres "$FJ_BACKUP/forgejo-db.dump" && systemctl start forgejo && echo "ROLLED BACK to $FJ_CUR"
```

Migrations only change the database, so the data directory normally doesn't need restoring. Its archive is in the backup folder (`forgejo-data.tar.gz`) as a last resort.

### Clean up

Remove the downloaded files now:

```bash
. /root/forgejo-upgrade.env && rm -f "/root/forgejo-$FJ_NEW-linux-$FJ_ARCH" "/root/forgejo-$FJ_NEW-linux-$FJ_ARCH.asc" "/root/forgejo-$FJ_NEW-linux-$FJ_ARCH.sha256"
```

After a week or so without problems, delete the backup:

```bash
. /root/forgejo-upgrade.env && rm -rf "$FJ_BACKUP"
```

---

## Record: 2026-10-08, 14.0.3 → 15.0.9

**Why:** 14.0.3 had been end-of-life since 2026-04-30 and was missing security fixes. One of those, fixed in 14.0.5, closed an authorization bypass that let any logged-in user write to public repos they don't own. 15.0.9 is the current LTS.

| Item | Result |
|---|---|
| Install detected | `/usr/local/bin/forgejo`, `/etc/forgejo/app.ini`, `/var/lib/forgejo` (622 MB), user `git`, amd64, PostgreSQL 17.6 (db `forgejo`), git 2.39.5 |
| Verification | checksum OK; good signature from the Forgejo release key |
| Backup | `/root/forgejo-backup-2026-10-08` (db dump 1.2 MB, data 579 MB, app.ini, old binary). The 2026-10-08 run used the earlier folder name without the version suffix. |
| Upgrade | `UPGRADED: 15.0.9+gitea-1.22.0`, service active, 14 migrations with no errors |
| Doctor | all 28 checks done; 32 repositories checked |
| From outside | `/api/v1/version` reports 15.0.9; `forgejo_hello` on the Forgejo MCP shows 15.0.9 |

**What changed for users in 15** (from the 15.0.0 release notes):
- **Everyone had to log in again once.** Cookie names changed. `COOKIE_REMEMBER_NAME=gitea_incredible` would have avoided this.
- **API tokens:**
  - Deleting a repository or generating one from a template now needs `write:user` (or `write:organization` for org repos).
  - Public-only tokens now get 404 instead of 403 on private repos.
  - Repository-specific tokens lost admin powers.
- **One setting was removed:** `ADD_CO_COMMITTER_TRAILERS`. It wasn't set here.

**Found during the upgrade, not caused by it:** the pull mirror of `github.com/hithereiamaliff/penangbus-chatbot-backend` fails to sync because GitHub reports the repository as not found (deleted, renamed or now private). Either delete the mirror, or recreate it with a GitHub token.
