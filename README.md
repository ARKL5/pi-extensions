# pi-extensions

Two local extensions for Pi. This repository is the source. Pi loads them through symlinks in `~/.pi/agent/extensions/`.

- `statusline.ts`: two-line footer for model, thinking level, context, cache share, catalog price, last TTFT, and utterance speed.
- `hide-bg-wait.ts`: keeps the pi-subagents declarations out of ordinary requests. `/subagent-on` adds `subagent` and `subagent_supervisor` together, and replaces the redundant tool descriptions.

`herdr-agent-state.ts` is installed by herdr and is not part of this repository.
