# SME Agent / Cohort Design for Atomic Workflows

## Overview

This document describes a Subject Matter Expert (SME) agent system for Atomic that replaces human-in-the-loop blocks in workflows with an autonomous expert panel.

### Problem

Workflows often become `awaiting_input` because a stage needs human judgment. The goal is to substitute that human block with an SME or SME cohort that can research, reason, and synthesize an answer.

### Core Concepts

1. **Coordinator / Summation Agent**
   - Receives the blocked workflow context
   - Decides if a single SME or a cohort is required
   - Formulates precise SME questions
   - Inspects SME answers and synthesizes a final response for the workflow
   - Records decision reasoning

2. **SME Agents**
   - 1 agent for simple blocks, 3-6 agents for complex blocks
   - Each SME must use the internet to access latest ideas, thoughts, concepts, thinking and approaches relevant to its subject and context
   - SMEs can scan the SME DB at any time for prior related Q&A
   - Outputs: answer, reasoning, sources, optional feedback notes for future improvement

3. **Persistent SME Memory**
   All interactions are stored for learning and reuse:
   - SME requests/questions with originating metadata including context
   - SME responses with reasoning and feedback notes
   - Coordinator decisions with reasoning
   - Topic / subject tagging

   Storage: SQLite at `~/.atomic/sme/sme.db` with optional vector index later.

4. **Source Controlled Feature**
   - Developed, managed, maintained in a VM, versioned in git
   - Deployed as an Atomic package/workflow

## Architecture in Atomic

### Data Model

**sme.db schema:**
```
requests(id, workflow_run_id, stage_id, topic, subject, question, context_json, created_at)
sme_responses(id, request_id, sme_id, sme_role, answer, reasoning, feedback_notes, sources[], created_at)
coordinator_decisions(id, request_id, decision, reasoning, final_answer, created_at)
```

### Workflow Graph

`workflows/sme-orchestrator.ts`

Stages:
1. `classify-block` - Coordinator decides SME strategy
2. `sme-fanout` - Parallel SME agents, dynamic expand 3-6 agents
3. `coordinator-synthesize` - Fresh context synthesis
4. `persist` - Write to SQLite via ctx.tool

### Tools Required

- `web_search` / `fetch_content` - mandatory internet access for SMEs
- `search_sme_db` - custom tool for FTS5/vector search of prior SME Q&A
- `sme-persist` - ctx.tool that writes to SQLite

### Integration with Blocked Workflows

Option A: Human-fallback workflow
- Wrap stages with `classify-and-act`
- On low confidence, launch `sme-orchestrator` instead of awaiting human

Option B: Intercom rescue
- Extension hook on `workflow_stage_blocked`
- Auto-fork to SME orchestrator, return synthesized answer via Intercom

## Implementation Plan

1. Create package `atomic-sme`
2. Implement SQLite store with migrations
3. Implement `search_sme_db` extension tool
4. Author `sme-orchestrator` workflow with coordinator + fan-out
5. Define SME role profiles
6. Add compaction protection via `<keepContext>` for coordinator decisions
7. Deploy to VM at observatory, source controlled in BrubeckDev

## Benefits

- Durable, inspectable runs with artifacts per SME
- No workflow stalls on human availability
- Learning loop from stored reasoning and feedback
- Composable with existing Atomic workflows: fan-out-and-synthesize, adversarial-verification, loop-until-done

---
Created: 2026-08-12
