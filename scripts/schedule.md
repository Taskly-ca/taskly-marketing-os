# Scheduling a pass

`pnpm --filter @tmos/worker run:pass` is one pass and exits. It is not a daemon
and does not schedule itself — `cli.ts` made that call and it still holds: a
runner that also owned the cadence would be the second place the cadence is
configured, and the two would drift.

**pg_cron cannot do this.** It is installed on the database and it runs SQL;
every stage of a pass is Node. It stays useful for anything that is genuinely a
statement — retention sweeps, `predicate_def` promotion — and useless here.

The pass is safe to run more often than it needs to be. Collection is backed off
per source, the skim is cached by content hash, the digest is capped at three a
week and never re-sends, and every stage is independent — so a missed run costs
freshness and nothing else.

## macOS — launchd

The file is committed at `scripts/ca.taskly.tmos.plist`, paths already filled
in. Two commands:

```bash
cp scripts/ca.taskly.tmos.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ca.taskly.tmos.plist
```

Check it took: `launchctl list | grep tmos`. Run it once by hand without
waiting for 07:30: `launchctl start ca.taskly.tmos`, then `tail -f /tmp/tmos.log`.
To stop: `launchctl unload ~/Library/LaunchAgents/ca.taskly.tmos.plist`.

For reference, that file is:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ca.taskly.tmos</string>
  <key>WorkingDirectory</key><string>/Users/nishant/Documents/taskly-marketing-os</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>pnpm --filter @tmos/worker run:pass</string>
  </array>
  <!-- 07:30 daily. StartCalendarInterval, not StartInterval: a laptop that was
       asleep should run once on wake, not replay every missed tick. -->
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/tmp/tmos.log</string>
  <key>StandardErrorPath</key><string>/tmp/tmos.err</string>
</dict>
</plist>
```

## Linux — cron

```cron
30 7 * * * cd /srv/taskly-marketing-os && pnpm --filter @tmos/worker run:pass >> /var/log/tmos.log 2>&1
```

## A platform scheduler

Railway/Render cron, or a GitHub Actions `schedule:` — the command is the same.
The pass needs `.env`, outbound HTTPS and the database; nothing else.

## Cadence

Daily is right for the competitor watch: a services page changes on the order of
weeks, and reading it daily is what makes "when did that change" answerable to
the day rather than to the week.

Run `--free` if a budget question is open — it skips the two stages that spend
on a model (`watch`, `reason`) and still collects, digests and republishes the
page.

## Reading the result

The pass prints a summary table and **exits zero even when a stage failed**,
because a red exit on a flaky feed is one an operator learns to ignore. To alert
on failures, grep the log for `FAILED`; every failed stage prints its reason
there and the pass continues past it.
