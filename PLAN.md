# Plan: Agent Builder (the framework, with a front end)

Goal: create, test, publish and version agents from the browser, without touching code.
Each agent is stored as a **spec** in SQLite; the server turns a spec into a real
`agents-framework` agent (`defineAgent`) at run time. Developers can still use the
framework directly in code. The builder is a UI over the same building blocks.

## Stages

Each stage is built, tested locally, committed, and deployed to the VPS through the
loop. Anything that restarts a container is explained first and left to the owner.

| # | Stage | Done when |
| --- | --- | --- |
| 1 | **Model providers**: Claude (Anthropic), OpenAI, OpenRouter, Ollama/any OpenAI-compatible, plus an offline Demo model | `/api/models` lists every provider with configured/not configured; a mock OpenAI-compatible server test passes a tool-calling round trip |
| 2 | **Agent store + factory**: SQLite tables for agents, versions and knowledge docs; spec (zod) → `defineAgent` | API tests: create → save draft → publish v1 → run → edit → publish v2 → rollback to v1; runs resume on the version they started with |
| 3 | **Tool catalog + approval rules**: knowledge search, HTTP API calls to allow-listed hosts, calculator, current time, demo order tools; per tool: approval never / always / when a number is over a limit | Tests: HTTP tool blocked for non-allowed hosts; threshold approval pauses only above the limit |
| 4 | **Builder UI**: New/Edit agent page (Basics, Model, Tools, Knowledge, Safety & limits), live test chat on the draft, Publish | Browser walkthrough: create an agent, test it, publish it, use it in Chat |
| 5 | **Knowledge upload**: .txt, .md, .pdf, or pasted text; cited answers | Test: upload → question answered with a citation of the uploaded document |
| 6 | **Versions & rollback**: version list with publish notes; one-click rollback | Test + UI: roll back and confirm the older behaviour |
| 7 | **Keys & deploy**: API keys stored on the server only (root-only env file); rebuild the console container; verify on https://agent-console.higher-institute.tech | Report from the VPS: providers configured, builder works end to end |

## Status

| # | Status | Evidence |
| --- | --- | --- |
| 1 | ✅ Done | `test/builder.test.ts` › stage 1 (mock OpenAI-compatible server, real HTTP round trip) |
| 2 | ✅ Done | stage 2 + 6 tests; draft runs isolated as `<id>.draft` |
| 3 | ✅ Done | stage 3 tests: threshold approval, v1 resumes after v2 publish, private address blocked |
| 4 | ✅ Done | Playwright walkthrough: create → validate → tools → knowledge → test chat → publish → v2 → rollback → Chat → Runs; phone width no overflow |
| 5 | ✅ Done | stage 5 test: pasted text + uploaded PDF, cited answer; PDF upload verified in the production container |
| 6 | ✅ Done | tests + walkthrough |
| 7 | ✅ Deployed | VPS report 2026-09-27: container healthy, builder API 200, public site 200; keys added with `deploy/set-key.sh` when wanted |

## Stage 8: providers and keys from the browser

| Done when | Status |
| --- | --- |
| Settings page: presets for 10 providers + custom OpenAI-compatible; keys encrypted at rest (AES-256-GCM), write-only, last 4 shown; applied without restart; Test lists models for builder suggestions | ✅ `test/settings.test.ts` (key not in DB file, real call uses saved key, wrong key rejected, custom provider, survives restart) + Playwright walkthrough + container check |

## Spec (what an agent is)

```jsonc
{
  "name": "Refund helper",
  "description": "…",
  "instructions": "You help customers …",
  "model": { "providerId": "anthropic", "modelId": "claude-sonnet-5" },
  "tools": [
    { "type": "http", "name": "get_order", "description": "…", "method": "GET",
      "url": "https://api.example.com/orders/{orderId}", "params": ["orderId"],
      "approval": { "mode": "never" } },
    { "type": "demo_refund", "approval": { "mode": "threshold", "field": "amount", "over": 100 } }
  ],
  "knowledge": { "enabled": true, "k": 3 },
  "guardrails": { "pii": true, "injection": true },
  "limits": { "maxSteps": 8, "maxToolCalls": 6, "maxCost": 0.25 },
  "examples": ["…"]
}
```

## Safety rules

- Only the signed-in admin can create or edit agents.
- Tools come only from the catalog; the model can never run arbitrary code. HTTP tools
  can only reach the hosts listed on that tool (egress policy, private addresses blocked).
- API keys live only in the server's environment and are never sent to the browser.
- Everything existing keeps working: approvals, audit log, cost, run history, live timeline.
