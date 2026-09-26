# LearningHarness

**Learn at your pace, not the pace of the slowest student.**

LearningHarness is a personal, local learning environment in development. Today it provides a pi-powered chat shell; the teaching workflow described below is the goal, **not yet implemented**. Eventually you'll tell it what you want to learn and what you already know. It will map the subject, skip what you've already got, and teach the rest one step at a time. You'll decide how deep to go.

The longer-term idea is NotebookLM with a model of *you*: what you know, where you've struggled, and how you like things explained. Building that model across subjects comes later.

## Why

Classrooms, courses and tutorials all move at one fixed pace. If you learn quickly, or already have related background, most of that time goes to material you don't need. You're also asked to prove understanding in ways that don't match what you actually know.

LearningHarness flips that:

- **What you know sets the pace, not a syllabus.** Short knowledge checks find the edge of what you know, and anything you already know is skipped.
- **Depth is your choice.** After each concept you can go deeper into what interests you or move on.
- **New ideas are anchored to old ones.** If you know C++, Rust ownership is taught as what's different from RAII, not from scratch.
- **Few roadblocks.** Checks steer where to slow down. They never stop you from getting help.

## Planned learning experience

A topic would be a notebook:

- **A knowledge graph.** The subject as concepts and how they connect: what each one requires, what it's part of, what it resembles. You see it as a **map** (the whole subject), a **roadmap** (your route to your goal, with what you already know skipped) and a **neighborhood** (where you are right now).
- **Notes.** Each concept gets a self-contained note, written as you learn. When you come back weeks later, you reread notes instead of scrolling through chat.
- **Sources.** Optionally add PDFs, docs sites or code repositories. The tutor grounds its explanations in them and cites them.
- **Visuals.** Diagrams and interactive visuals (step-throughs, animations, sliders), generated whenever a picture explains something better than words.
- **Checks.** Quizzes, free-form answers and, for code, hands-on labs with an editor, a terminal and a Run button. Every check is saved as a deck you can review later.

A session goes like this:

1. **Intake:** a short conversation about what you want to learn and what you already know.
2. **Placement:** a few quick checks, only where it's unclear what you know.
3. **Roadmap:** you review the proposed path and adjust it. Teaching starts when you accept it.
4. **Learning:** one concept at a time. Checks come in small batches, and a miss sends you back only to that concept.
5. **Coming back:** it picks up where you left off, with an optional warm-up on material that's due for review.

## Principles

- **General first.** It can teach any subject. Code, math and other domains get extra support through *domain packs* (skills, check types and tools) instead of being built into the core.
- **Understanding over recall.** Start from truths you can accept without caveats, show how an idea could have been discovered, give precise rules before analogies, and connect every new idea to what you already hold.
- **Accurate or silent.** When the tutor is unsure, it checks your sources or the web before answering, and cites what it used.
- **You own your model.** A watcher reviews each session and records what it learned about you: strengths, misconceptions, preferences. The profile is readable and editable. Check results always outweigh the watcher's guesses.
- **Local and plain.** Everything lives as plain files in a folder you choose. No accounts, no cloud, no gamification.

## How it's built

- **Engine:** [pi](https://github.com/earendil-works/pi-coding-agent), extended with learning tools, skills and subagents (researcher, visual maker, lab writer, watcher).
- **Interface:** a local web app, because learning deserves proper typesetting, math, diagrams and room to think, which a terminal can't provide.
- **Models:** assigned per role and freely swappable, so you can try different tutors.

## Inspirations

- [NotebookLM](https://notebooklm.google/): learning grounded in your own sources.
- [amosblomqvist/learn](https://github.com/amosblomqvist/learn): teaching principles, quiz design, and research and visual subagents on pi.
- [learn-anything](https://github.com/ChenChenyaqi/learn-anything): knowledge maps, choosing your own depth, per-concept notes, and reusable quiz decks.
- Hermes Agent / Honcho: an observer that models the user.
- Meridian and The Professor: an earlier attempt at a learning-first coding tutor. The assistance ladder and verification ideas come from there. The rigidity was left behind.

## Run the chat fork

Requires Node.js 22.19+ and a configured [pi](https://github.com/earendil-works/pi-coding-agent) model/credential (or use the in-app model setup). The pi SDK is pinned to `0.87.1`.

```bash
npm ci
npm run dev
```

Open `http://localhost:5173`. The local backend listens on `127.0.0.1:8788` and Vite proxies `/ws` to it. Set `LEARN_PORT` to change the backend port (Vite follows it), `LEARN_CWD` to choose the initial working directory, or `LEARN_DATA_DIR` for LearningHarness state (default `~/.learning-harness`, with pi session files under `sessions/`). The backend binds loopback only. The launcher ignores any unrelated Dispatch instance's `PI_WEB_*` port/token/workspace settings. Pi credentials still come from its agent directory (`PI_CODING_AGENT_DIR` or pi's normal default). If npm 10 reports a peer-resolution error, try `npm ci --legacy-peer-deps`.

For a production build: `npm run build && npm start`, then open `http://127.0.0.1:8788`. Run `npm run typecheck`, `npm run check:protocol`, and `npm test` for the project checks.

**What works now:** pi-powered streamed chat with persistent pi sessions, model/auth administration, tool cards, files/search, terminals and Markdown/math. The versioned `learn:demo` event is a visible proof of the pi-events → WebSocket → browser path, **not** stored learning data. Coding-specific SCM, worktree, worker, background-server and subscription screens/APIs are excluded. Topic persistence, knowledge graphs, teaching workflows, source curation, and the learner profile in [`docs/plan.md`](docs/plan.md) are future work—not available yet.

This app began as a fork of [Dispatch-WebUI](https://github.com/MichaelT025/DispatchWeb) at `8dc1df5`. Its MIT attribution is retained in [`LICENSE`](LICENSE).
