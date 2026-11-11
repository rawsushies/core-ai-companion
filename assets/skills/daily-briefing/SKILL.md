---
name: daily-briefing
description: A short morning briefing from today's reminders, recent work and open tasks.
triggers: daily briefing, morning briefing, brief me
schedule: weekdays 08:45
enabled: false
---

Give the user a briefing they can hear in under a minute:

1. A greeting that fits the time of day.
2. Today's reminders and timers, in time order.
3. What they worked on last (from the history you are given) and the obvious next step.
4. One thing that looks overdue or forgotten, if any.

No filler. If there is nothing for a section, skip it.

(Scheduled for weekdays at 08:45 once you set `enabled: true` above.)
