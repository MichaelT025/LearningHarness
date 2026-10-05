# LearningHarness handoff for Claude

## Start here

LearningHarness is a local, chat-focused fork of Dispatch-WebUI. It now has a working **tutor**: a topic chat runs an intake conversation, proposes a plan, writes `roadmap.md` once the learner accepts it, then teaches one concept at a time and saves a note per concept. That is Slice A of [`plan.md`](plan.md). The knowledge graph, quiz/answer cards, sources, subagents and the learner profile do **not** exist yet; `plan.md` is a plan, not an inventory.

Key commits, newest first (the `tutor-slice` branch, fast-forwarded into `master`):

- `340ccef` — new topic chats default to a per-role model from `config/agents.json`.
- `5e8fa6e` — Start session button in empty topic chats.
- `941ffec` — `note_write` calls render as note cards.
- `e076c64` — the tutor: prompt, topic context, `note_write`, topic guard, curated tool set.
- `1425cac` — mermaid diagrams render in chat.
- `94ca711` — topics as slug folders under a chosen learning root (protocol v22).
- `fa506af` / `6bf3ef1` / `e854e23` — topic persistence, the stripped chat shell, the raw Dispatch-WebUI import.

Upstream MIT attribution remains in `LICENSE`.

## What works

- **Learning root.** A first-run dialog asks where learning data lives (default `~/Documents/Learning`), saved in `<dataDir>/config.json`; `LEARN_ROOT` pins it. The sidebar's folder button next to **New Topic** reopens the dialog to change it. Folders already in the root that are not topics are ignored.
- **Topics** are plain folders `<root>/<slug>/` holding `topic.json` (v2: id, slug, title, goal, createdAt), `roadmap.md`, `notes/<slug>.md` and `sessions/` (pi transcripts). The topic folder is the agent's cwd. Name clashes get `-2`, `-3`. Old v1 UUID topics in `~/.learning-harness/topics` are not migrated.
- **Tutor.** In a topic chat the system prompt is `engine/prompts/tutor.md` (re-read every run, edit freely) followed by tools/skills and a volatile `<topic>` block: goal, stage (intake vs learning, from whether `roadmap.md` exists), the inlined roadmap and the list of notes. Other chats keep pi's stock prompt or the settings-panel template.
- **Notes.** `note_write` saves `notes/<slug>.md`; the web UI renders the call as a note card (markdown, KaTeX, mermaid) and the tutor does not repeat it in chat.
- **Guard and tool set (topic runtimes only).** `write`/`edit` must stay inside the topic folder, cannot touch `topic.json` or `sessions/`, and cannot write `notes/` (forces `note_write`). `read`/`grep`/`find`/`ls` cannot read `sessions/`. Before every run the active tools are reset to the tutor's set (file tools, `ask_user_question`, `note_write`, web search/fetch if present, terminal tools if enabled): the user's global pi extensions add tools like `write_note`, `delegate`, `todo` that confused cheap models. `bash` is **not** fenced.
- **Models.** `config/agents.json` maps roles to `provider/model` (Dispatch's shape). Only `tutor` exists, set to `opencode-go/deepseek-v4.1-flash`. A new topic chat starts on it; resumed transcripts keep their model; a model picked in the UI wins. The user's global pi default (`gpt-6-astra`) is untouched. **Test with the cheap model.**
- **Mermaid** fences render as diagrams (lazy-loaded chunk).
- The `learn:*` event bridge stays; its per-run demo card is off unless `LEARN_DEMO_EVENTS=1`.

## Run and verify

Requires Node.js >=22.19 and a pi credential for the tutor model (opencode-go here). Pi SDK pinned to `0.87.1`.

```bash
npm ci
npm run dev                 # browser http://localhost:5173; backend 127.0.0.1:8788
npm run typecheck
npm run check:protocol
npm test
npm run build
npm start                   # built app http://127.0.0.1:8788
```

`LEARN_PORT` changes the backend port, `LEARN_CWD` the launch workspace, `LEARN_DATA_DIR` the app data dir (default `~/.learning-harness`: settings, UI state, `config.json`, general sessions), `LEARN_ROOT` the learning root. For a throwaway smoke test, point `LEARN_DATA_DIR` at a scratch folder and pick a scratch learning root in the first-run dialog.

Verification at the end of Slice A: typecheck, protocol check, 152 unit tests in 16 files and the build pass. A live smoke in the built-in browser (isolated data) covered: first-run dialog, topic creation, Start session, intake to accepted plan with rendered mermaid, `roadmap.md`, a `note_write` card on DeepSeek, restart and resume, and a returning-session greeting. There is still **no automated browser test**.

On Windows, shell calls use Git Bash; give long commands a timeout and never leave servers running. pi only activates `read/bash/edit/write` by default: custom tools must be switched on explicitly (`activateRegisteredTool`, `tutorToolSet`).

## Architecture and seams

- `server/topics.ts`: `TopicStore` (slug folders, trust rules, atomic writes) and `LearnRootConfig`. The cwd is derived from the folder, never stored, so a root can move.
- `server/tutor.ts`: tutor prompt loading and rendering, `<topic>` context, `topicWriteViolation` / `topicReadViolation`, the guard extension, `note_write`, `tutorToolSet`.
- `server/agents-config.ts`: role model parsing. `ClientSession.applyRoleModel` seeds empty topic sessions; `hasRoleDefault` stops the previous chat's model from being carried over.
- `server/agent-service.ts`: runtime factory wires the tutor for topic cwds (guard extension, `note_write`, tutor prompt and tool set in the persona extension's `before_agent_start`). `setLearnRoot` handles root changes.
- `server/protocol.ts` is type-only (re-exported by `web/src/types.ts`); protocol **v22** on both sides.
- Web: `LearnRootModal`, `NoteCard` + `note-card.ts`, `MermaidBlock`, the topic starter in `MessageList`.
- Tests: `topics`, `tutor`, `agents-config`, `note-card`, `learn-events`, plus the inherited suites.

## Known gaps

- `bash` can still write anywhere; only tool-level writes are guarded.
- Sidebar conversation labels for topic chats show the folder slug.
- Legacy non-topic workspace chats still exist; the plan is for a "Scratch" topic to replace them.
- Changing the root while a topic chat is open: see `setLearnRoot` for how the orphaned chat is handled.
- The tutor's checks are plain chat questions; nothing records results yet.

## What to do next

1. **Dogfood before building more.** Run the tutor on two or three real topics of different kinds (a language or framework, a theory/math topic, something non-code) with the cheap model. Note where it drifts: skipping notes, over-long intake, weak plans, ignoring "move on". Fix those in `tutor.md` (or with guards, when a rule must hold). This is the plan's generality check, and it is cheaper than discovering prompt problems after the graph exists.
2. **Slice B: the knowledge graph.** `graph.json` (concept nodes with status and detail lists; `requires` / `part_of` / `similar_to` edges), graph tools that update it deterministically, `graph.log.jsonl` with undo, and a Map/Roadmap view in the right panel. Generate `roadmap.md` from the graph so the tutor prompt's contract (and existing topics) keep working; migrate an existing `roadmap.md` into a graph on first load.
3. **Slice C: checks.** `quiz` and `answer` cards with deck files, `checks.jsonl`, and confidence updated by code, not the model; then the review queue.
4. After that, in plan order: sources, subagents (researcher first: it is what makes "accuracy first" real), the code pack, the watcher.

Agree on the slice's scope with the user before implementing. Preserve existing topic folders and the v22 protocol boundary; version any storage change.
