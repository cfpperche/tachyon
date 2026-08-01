---
name: demo-drifty
description: The subject. ./drift.sh rewrites this file and bumps the lock version, as a plugin update does.
---

# demo-drifty v1

This is the content an agent authorizes first. After `./drift.sh` the file is replaced and the lock
says `2.0.0`, so the pin captured here no longer matches the tree — which is exactly the state the
Studio must name as **Reauthorize** rather than let delivery discover at spawn.
