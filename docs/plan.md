# LearningHarness — plan

## Context

School moves at the pace of the slowest student. LearningHarness goes at yours. It finds out what you
already know, skips it, and only goes deeper where you choose to or where you have gaps.

- **What it is:** a personal, local learning environment in the spirit of NotebookLM. It can teach **any
  subject**, with extra support for code (and some math) added through domain packs.
- **Built general first:** the core is domain-agnostic. Specializations are added later as pi skills and
  extensions ("domain packs"), not built into the core one subject at a time.
- **Light by design:** checks decide what to skip. They never block you from getting help.

**References**

- `docs/references/braindump.md`
- `docs/references/TheProfessor.md`
- **Meridian** (`Personal/Meridian/docs/*prd*.md`, `Personal/Prototype/docs/decisions.md`):
  - kinds of verification, the tutor choosing the check type, query-aware help levels;
  - also the cautionary tale: the Roo Code fork spent its effort maintaining the fork itself.
- **[amos/learn](https://github.com/amosblomqvist/learn):** teach principles, quiz design rules, and the
  researcher and visual agents.
- **[learn-anything](https://github.com/ChenChenyaqi/learn-anything):**
  - the full topic map (domains → concepts → details);
  - going deeper by choice;
  - a note per concept;
  - saved quiz decks with typed grading;
  - a review-priority formula;
  - "accuracy first, analogies second."
- **Hermes/Honcho:** an observer that builds a model of the learner.
- **`Personal/Dispatch` and `Personal/Dispatch-WebUI`:** the base for the fork.

## Architecture

```
LearningHarness/
  engine/        pi package: core extensions (tools + learn:* events), skills/teach, agent prompts, watcher
  packs/code/    first domain pack: code skill + lab check type + Code canvas tab + run tool
  server/        forked from Dispatch-WebUI/server — pi SDK embed, sessions, terminals + topic/graph/source APIs
  web/           forked from Dispatch-WebUI/web — new layout, check cards, graph views, canvas
  config/        agents.json — swappable model + reasoning per role (tutor, researcher, visual, grader, watcher, writer)
  bin/           `learn` launcher (setup wizard: data root, editor, models; then opens browser)
```

1. **pi is the engine.** Pin `@earendil-works/pi-coding-agent` to an exact version, as Dispatch does. Do
   not fork pi. If an extension point turns out to be missing, record it.
2. **Fork Dispatch-WebUI.**
   - **Keep:**
     - the SDK embed (`server/agent-service.ts`)
     - streaming and sessions
     - model and auth administration
     - tool cards
     - `terminals.ts` + `patch-node-pty.ts`
   - **Remove:** SCM/git review, worktrees, the workers UI, usage/subscriptions, background servers.
   - **Replace:** the layout.
3. **Event bridge.** The engine emits versioned events on `pi.events` under `learn:*`:
   - `graph.changed`
   - `check.posed` / `check.result`
   - `note.updated`
   - `visual.created`
   - `source.added`
   - `subagent.*`
   - `profile.updated`

   Packs add their own events, e.g. `code:run.result`. The server mirrors events into UI state, following
   the pattern in `Dispatch/extensions/piastra/worker-bridge.mjs`. Interactive tools wait until the
   browser answers.
4. **Domain packs.** A pack is a pi package that can contribute:
   - a skill (how to teach that domain);
   - check types (a schema, a card renderer and a grader);
   - canvas tabs;
   - tools.

   The core defines a small registry for check types and canvas tabs. The code pack is the first pack and
   is built only through that registry.
5. **Models.**
   - `config/agents.json` maps each role to a model, in the same shape as
     `Dispatch/config/agents.json`. Models are chosen in Settings (mostly subscription models).
   - Every lesson turn, grade and note records which model produced it.
   - Prompts are laid out for caching: the stable parts go first (teach skill, pack skill, topic goal).
     The parts that change go last (graph status, recent checks, profile slice).

## Knowledge graph (the center of each topic)

- **Nodes are concepts.** Each topic has roughly 20–60 of them. Fine-grained details are stored as a list
  inside the node and never become nodes themselves.
- **Each node has:**
  - a label and a domain;
  - a detail list;
  - a status (`unknown | known | learning | solid | review`);
  - confidence, derived from checks;
  - a note;
  - source links;
  - decks.
- **Edges are typed:**
  - `requires` (prerequisite): drives the roadmap and placement.
  - `part_of` (domain hierarchy): drives the map.
  - `similar_to` / `contrasts_with`: supports teaching something as a difference from what you already
    know.
  - `same_as`: links concepts across topics.
- **Views** (all purpose-built, no hairball graph):
  - **Map:** the full hierarchy, colored by status.
  - **Roadmap:** a layered DAG leading to your goal, with known nodes skipped.
  - **Neighborhood:** the current node, what it needs and what it unlocks.
- **Editing happens only through the tutor,** via chat plus quick actions on nodes (mark known, focus
  here, go deeper, drop). Every change is appended to `graph.log.jsonl`. The UI has **undo last change**.
- **Cross-topic links are in v1.**
  - They live in `<root>/links.jsonl`.
  - The watcher proposes `same_as` / `similar_to` links. They are applied when confidence is high or when
    you confirm them.
  - Mastery then carries over between topics.
- **Your profile is the status layer across all graphs,** plus the watcher's soft signals.

## Storage

The data root is `Documents/Learning` by default and is set during setup. It is separate from the Obsidian
vault. The web UI renders everything.

```
<root>/
  profile.json            # soft signals: preferences, pace, background (user-editable); mastery derived from graphs
  observations.jsonl      # watcher observations with evidence refs
  links.jsonl             # cross-topic edges
  <topic>/
    topic.json            # goal, created, active packs
    graph.json            # nodes + edges
    graph.log.jsonl       # change history (undo)
    notes/<node>.md       # per-concept note: positioning, mechanism, example, misconceptions, summary
    decks/<node>/*.json   # saved checks with answers + grading type (replayable without a model)
    sources/<id>/         # original or reference, extracted .md, meta.json
    visuals/*.html
    checks.jsonl          # every check result (+ model, help level)
    sessions/             # pi session files for this topic
    <pack data>           # e.g. labs/, runs.jsonl for the code pack
```

## Flow

1. **Intake.** A short conversation about what you want to learn and what you already know. Adding
   sources is optional. The tutor also looks up related strengths in the profile and cross-topic links.
2. **Map and placement.**
   - The tutor builds the full map for the topic.
   - It runs a few adaptive checks, only where your self-report or profile is unclear.
   - Nodes you already know are marked `known`.
3. **Roadmap.** It proposes a path to your goal. You adjust it in chat, then **accept** it. Teaching starts
   only after you accept.
4. **Teaching loop** (`engine/skills/teach`):
   - Each node: why it matters, then establish it, then connect it. This combines amos's two principles
     with learn-anything's "accuracy first, analogies second."
   - When a `similar_to` edge links to something you know, teach the node as a **difference** from that.
   - The node's note is written first and then shown exactly as written, so the chat and the note never
     drift apart. The note is updated as you go.
   - Each node ends with **go deeper into X / Y, or move on**. Depth is your choice.
   - Checks come in **small batches** every 1–3 nodes, not after every single step. A miss sends you back
     to that node only.
   - **Soft help ladder:**
     - quick answers whenever you ask;
     - graduated hints only on nodes you're actively learning;
     - after you're given a full solution, a variation check is queued.
   - **Accuracy:** anything uncertain goes to the researcher (your sources first, then the web), with
     citations.
5. **Coming back.** It opens with a one-line "where we left off" and an optional two-question warm-up from
   due decks. You can skip the warm-up, and it never blocks you.
6. **Review.** Due decks are ranked by `(1 − confidence) × (days_since + 1)` and can be replayed in the UI
   without calling a model.

## Checks

**Core check types** (work for any subject):

| Type | Covers | Grading |
|---|---|---|
| `quiz` | single- or multi-select, true/false, "I don't know"; placement; predict-the-output | `exact` |
| `answer` | fill-in-the-blank, explain-back, why-questions, worked problems (KaTeX), trace | `accepted` (a list of accepted variants), or `ai` (a rubric written *before* the question is asked, graded by the grader model) |

- The deck schema follows learn-anything's v1 format (`gradeable: exact | accepted | ai`).
- Grading results update node confidence **deterministically in the tools**. The model never does
  arithmetic on the JSON.

**Pack check types.** The code pack adds `lab`. Other packs add their own types later.

## Code pack (`packs/code`), the first specialization

- **Skill:** how to teach programming topics (TheProfessor-style labs, `TODO(learn)`, predict and trace).
- **`lab` check type.** A lab is a folder in `<topic>/labs/<id>/` containing a README, starter files,
  tests, and a `lab.json` that holds the run command.
- **Code canvas tab:**
  - Monaco editor with syntax highlighting only. No language server, no AI completion.
  - A terminal (xterm + node-pty, taken from Dispatch-WebUI).
  - A **Run** button: runs the command with a timeout and shows results per test. Each run is appended to
    `runs.jsonl` with a snapshot of the files, and emits `code:run.result`.
  - An **Open in Editor** button: setup detects `code`/`cursor`/`windsurf` on the PATH and lets you pick
    one. It uses the Windows CLI-shim fix from `Prototype/scripts/install-vsix.js` and falls back to the
    OS default.
- **Watcher input:** compiler and test output from each run (the same error repeated across runs is a
  signal). No language server is needed.
- The **lab writer** runs on a cheap model and must produce a lab that runs, with TODOs that fail its
  tests.

## Sources (v1: PDF, web, repos)

- **PDF:** extract text page by page (e.g. with `unpdf`). Citations look like `[src:id p.12]`.
- **Web:** Readability, then convert to markdown with turndown. Optionally crawl a docs section to a set
  depth.
- **Repo:** store a reference plus a summary of the file tree, and search the live checkout.
- **Tools:** `source_search` (ripgrep/BM25) and `source_read`. Nodes link to the source spans that
  support them.

## Subagents: a small custom runner

- **Context comes from the engine, not the tutor.** The extension assembles the context pack
  deterministically:
  - the current node and its neighborhood, and your status on each;
  - the last N turns, verbatim;
  - the goal;
  - relevant source excerpts;
  - a slice of your profile.

  The tutor model adds only the task.
- **Output contracts:**
  - The researcher returns `{claims[], verdict, citations[]}`.
  - A visual must load in the sandbox without errors.
  - A pack's writer must pass that pack's validator.
- The tutor reviews what comes back.
- **Fork mode** (a copy of the main session) is used when fidelity matters.
- The Subagents panel shows each task, its context pack and its output.
- **Visuals:**
  - Agent-written HTML, rendered in a sandboxed iframe (scripts allowed, no network) and saved as
    `visuals/*.html`.
  - A house kit supplies CSS tokens for light and dark themes plus a few primitives (box, arrow,
    step-through, slider).
  - Mermaid is used when a static diagram is enough.

## Watcher (Hermes/Honcho-style)

- **When:** at the end of each session, asynchronously, using its own model from `agents.json`.
- **Input:** the transcript, new checks, pack signals (e.g. `runs.jsonl`), the profile, and the graphs.
- **Output:** observations appended to `observations.jsonl`, each with evidence refs and a confidence:
  - misconception
  - strength
  - preference
  - pace
  - background

  It also proposes cross-topic links.
- **Hard signals win.** Check results outweigh inferences.
- **The profile view** lists every claim with its evidence. You can edit or delete any of them. Your edits
  are recorded as observations, so the watcher doesn't bring a deleted claim back.
- **Where it's used:**
  - A profile slice is injected into the tutor at `before_agent_start`.
  - The tutor can call `profile_query` for more.
  - Placement uses the profile as a starting point, but never skips anything without a check.

## UI layout

- **Left:** topics and sources.
- **Center:** the lesson (markdown, KaTeX, code), with check cards inline.
- **Right, tabbed canvas:**
  - Map
  - Roadmap
  - Note
  - Visual
  - pack tabs (e.g. Code)
- **Drawers:**
  - `/btw` side chat (on a forked pi session)
  - Subagents
  - Profile
  - Review

## Phases

0. **Fork and spike.**
   - Fork Dispatch-WebUI into `server/` and `web/`, and strip it down.
   - Create the engine package with pinned pi, `agents.json`, and the setup wizard (data root, models).
   - Prove the round trip: browser → pi → streamed reply → a `learn:*` event rendered in the UI.
1. **Core learning loop.**
   - Topics.
   - Intake, map and placement, roadmap with accept.
   - Graph tools with the change log and undo; Map, Roadmap and Neighborhood views.
   - The teach skill, with notes per node and "go deeper or move on."
   - `quiz` and `answer` cards, decks, batched checks, and `checks.jsonl`.
   - Resume with warm-up.
   - Cache-friendly prompt layout.
2. **Sources.** Ingest PDFs, web pages and repos; `source_search` and `source_read`; cited answers; the
   Sources panel; links from nodes to sources.
3. **Subagents and visuals.** The runner, the researcher, HTML visuals with the house kit, and the
   Subagents panel.
4. **Pack mechanism and code pack.** Registries for check types and canvas tabs, then `packs/code` built
   entirely on them.
5. **Watcher, profile and cross-topic links.** Observations, the profile view, `links.jsonl`
   proposals and confirmations, the review queue, and the `/btw` drawer.

## Later (tracked backlog)

- **Scripted-learner tests:** simulated personas replayed against the tutor to score placement and
  skipping, and to compare models and prompts.
- Video/YouTube sources (transcripts with timestamp citations).
- A language-server hub for the code pack's editor, shared with the agent's diagnostics.
- An in-browser debugger (DAP).
- More domain packs: math (symbolic answer checking), natural languages, and others.
- Packaging for friends (`npm i -g`, a polished setup flow).

## Verification

- **Unit tests:**
  - graph operations and undo;
  - deck schema validation and grading (exact / accepted / ai-rubric storage);
  - confidence derivation;
  - review priority;
  - source extraction and search;
  - context-pack assembly;
  - output validators;
  - the pack registry;
  - profile derivation (hard signals win, user edits persist);
  - event payload versions.
- **Integration:** the server embeds pi with a scripted model and asserts that `learn:*` events reach the
  websocket. This follows Dispatch's `test:integration`.
- **Browser smoke test (built-in browser):**
  - Run the intake, then accept the roadmap.
  - Answer quiz and answer cards.
  - Choose "go deeper."
  - Undo a graph change.
  - Open a note and a visual.
  - Follow a PDF citation.
  - Edit a claim in the profile.
  - Code pack: edit a lab and Run it, once failing and once passing.
- **Generality check:** dogfood the core on a spread of different subjects, e.g. a language, a framework,
  and a math or theory topic, without subject-specific tuning. Success means:
  - known material is skipped within minutes;
  - notes are worth rereading;
  - the profile makes claims you agree with.
