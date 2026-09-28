# LearningHarness handoff for Claude

## Start here

LearningHarness is a local, chat-focused fork of Dispatch-WebUI. The current app is **runnable**; it is not yet the learning tutor envisioned in [`plan.md`](plan.md). The immediate goal was to preserve browser → pi streamed chat, strip coding-specific UI/APIs, restore a versioned learning-event bridge, and add persistent topics with isolated chat histories. Those milestones are complete. Do not assume the knowledge graph, teaching loop, source ingestion, or learner profile exists.

The branch is `master`. Key commits, newest first:

- `fa506af` — persistent topics and per-topic pi sessions.
- `6bf3ef1` — stripped/renamed LearningHarness chat shell and `learn:demo` bridge.
- `e854e23` — unstripped Dispatch-WebUI import (upstream commit `8dc1df5`).
- `bf562d9` — recoverable pre-fork spike/connection baseline.

The worktree was clean before this handoff document was added. The earlier smoke-test servers were stopped; do not kill other Dispatch/pi processes just because they run Node. Upstream MIT attribution remains in `LICENSE`.

## What works

- Browser chat streams real pi responses; sessions persist; model/auth settings, tool cards, terminals, files/search, and Markdown/KaTeX remain.
- SCM, worktrees, workers UI/API, background-server management, and subscription UI/API were removed.
- `learn:demo` emits a `{version:1,type:"demo",message:string}` event from an inline pi extension, validates it, forwards it as `learn_event` with its **conversationId**, and renders a transient card in the active chat. It is a bridge demonstration, **not** persisted learning data.
- The sidebar can create a topic (title + optional goal), select it, open its sessions, and resume its latest session after a server restart. Existing workspace chats remain accessible without migration. The topic goal is currently metadata/tooltip **only**; it does not alter the tutor prompt.
- No topic rename/delete, graph, notes, placement, checks, review scheduler, or source ingestion yet.

## Run and verify

Requires Node.js >=22.19 and a configured pi model/credential (or configure one in the app). Pi SDK is pinned to `0.87.1`.

```bash
npm ci
npm run dev                 # browser http://localhost:5173; backend 127.0.0.1:8788
npm run typecheck
npm run check:protocol
npm test
npm run build
npm start                   # built app http://127.0.0.1:8788
```

`LEARN_PORT` changes the backend port (Vite follows it), `LEARN_CWD` sets the initial workspace, and `LEARN_DATA_DIR` changes the local data root (default `~/.learning-harness`). `scripts/learn-env.mjs` maps these to internal `PI_WEB_*` without inheriting another Dispatch instance's port, token, tab restriction, or workspace. Pi credentials still come from `PI_CODING_AGENT_DIR` or pi's default agent directory; do not accidentally test with production credentials/data if creating destructive fixtures.

Latest verification at `fa506af`: `typecheck`, `check:protocol`, all **113 tests in 13 files**, full web/server build, and `git diff --check` passed. A production WebSocket smoke created two topics, received a completed real model reply in each, then restarted the server and resumed each correct transcript using a new client ID. A separate rapid duplicate `select_topic` smoke saw one topic conversation ID and one transcript. Temporary smoke scripts and isolated data were removed. The baseline fork's browser→Vite→pi stream and `learn_event` were also smoked live. **No automated visual/browser UI test exists**; do not claim one passed. The build has a non-blocking large Markdown chunk warning.

On Windows, shell calls use Git Bash. Give long commands an explicit timeout; never leave dev servers running after smoke tests. Some legacy Chinese reference files are GBK, not UTF-8. Keep unrelated Dispatch processes alone.

## Architecture and persistence seams

- `server/index.ts`: HTTP/WebSocket entry and client-message dispatch. `server/agent-service.ts`: `AgentService`/`ClientSession`, pi runtime per conversation, session lifecycle, topic routing. `server/protocol.ts` is **type-only** and is re-exported through `web/src/types.ts`; `scripts/check-protocol-sync.mjs` enforces this. Both `server/protocol-version.ts` and `web/src/protocol-version.ts` are **v21**; bump both for breaking wire changes.
- `server/topics.ts`: `TopicStore`, shared by the server, loads valid topic records at startup, writes new metadata atomically, ignores invalid/corrupt records without blocking startup. Layout: `<dataDir>/topics/<UUID>/topic.json`, `workspace/` (pi cwd), `sessions/` (flat pi JSONL files). Metadata has `version:1`, `id`, `title`, `goal`, `createdAt`, `cwd`. The existing general/workspace sessions remain in the configured general root (`<dataDir>/sessions` by default); no old transcripts were moved.
- `ClientSession.sessionRootFor(cwd)` chooses a topic's `sessions/` for an exact topic workspace cwd, otherwise `piSessionsRoot()`. This resolver is used for create, continue-recent, reset, and list; `switch_session` opens an explicit transcript. Session delete/rename restricts paths to configured general or known topic session roots. Topic `create_topic` and `select_topic` navigation is serialized by a per-client FIFO queue to avoid duplicate in-flight runtime opens. Legacy `set_cwd` is not in this topic-only queue.
- `web/src/use-chat.ts`: socket reducer, snapshots/deltas, topic pushes, optimistic conversation switching. `web/src/components/LeftPanel.tsx` and `left-panel-nav.ts`: topic/sidebar groups alongside legacy project/workspace groups. Top **New Chat** stays within the active topic; for non-topic workspaces it preserves prior projectless behavior. Topics intentionally lack the legacy Remove Project action. The sidebar has no topic deletion action.
- `server/learn-events.ts`, `web/src/components/LearningEventCard.tsx`: transient versioned event round trip. Events must remain tied to their source conversation across pending switches.
- Key tests: `tests/unit/topics.test.ts` (metadata/recovery), `tests/unit/topic-session-isolation.test.ts` (pi session listing/resume after restart), `tests/unit/left-panel-new-chat.test.ts` (topic new-chat routing), `tests/unit/conversation-view.test.ts` (client reducer), `tests/unit/learn-events.test.ts` (bridge guard). `tests/server-chat.test.ts` exercises the server chat baseline.

## Next conversation / likely next slice

Read `README.md` for shipped features and `docs/plan.md` for the much larger intended learning product; the latter is a **plan, not an implementation inventory**. Agree on a narrow next vertical slice with the user before implementing it. A sensible candidate is topic-specific intake and a minimal teaching instruction/skill that uses the saved goal, with a real chat/returning-user test, **before** building the full concept graph. Preserve existing sessions and the v21 protocol boundary. If changing topic storage, design an explicit migration/version strategy rather than silently rewriting old `topic.json` files. A UI/browser smoke would close the main remaining verification gap.
