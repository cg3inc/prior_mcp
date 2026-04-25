# Tool Description Quality — Research & Action Plan

## Source Paper
**"MCP Tool Descriptions Are Smelly!"** (arxiv 2602.14878, SAIL Research, McGill)
- 856 tools across 103 MCP servers analyzed
- Replication package: github.com/SAILResearch/mcp-tool-description-augmentation

---

## The Six Components of a Good Tool Description

The paper identifies six components through analysis of Anthropic's official docs + 15 community sources:

| Component | What it covers | Impact |
|---|---|---|
| **1. Purpose** | What the tool does — core identity | 56% of tools fail this. Most important. |
| **2. Guidelines** | **When** to invoke (activation criteria) + **how** to use (operational instructions) | Our biggest gap for Prior. |
| **3. Limitations** | Known constraints, edge cases, failure modes | Prevents misuse and wasted calls. |
| **4. Parameter Explanation** | Detailed param descriptions beyond type + name | We do this well already. |
| **5. Length & Completeness** | Min 3-4 sentences; complex tools need more | Balances with token cost. |
| **6. Examples** | Illustrative usage showing correct invocation | **Can be safely dropped** — ablation shows no statistical degradation. |

### Key Hierarchy
- **Purpose** + **Guidelines** are the two highest-impact components
- **Examples** can be dropped without performance loss (saves tokens)
- **Limitations** is the least commonly included but prevents silent failures

---

## Key Findings

### Smell Prevalence
- **97.1%** of MCP tool descriptions have at least one smell
- **56%** fail to clearly state their purpose
- Official servers are just as bad as community ones — quality is universally poor
- Most common smells: Unclear Purpose, Unstated Limitations, Missing Usage Guidelines, Opaque Parameters

### Augmentation Impact (RQ-2)
- **+5.85 pp** task success rate (median) with fully augmented descriptions
- **+15.12%** average evaluator score (partial goal completion)
- **+67.46%** execution steps (median) — the agent does more work with richer descriptions
- **16.67%** regression rate — some tasks get worse with augmentation
- Trade-off: better results but more tokens/steps

### Component Ablation (RQ-3)
- **No single combo** works best across all domains and models
- **Removing Examples** never degrades performance — safe to drop
- **Purpose + Guidelines** together are the minimal effective set for most tasks
- **Compact, targeted descriptions** often match full augmentation performance at lower cost
- Domain- and model-specific tuning matters — test your combo

---

## Mem0/OpenClaw Integration Insight

Mem0 built a whole product around the fact that **agents won't reliably call tools on their own**:

> "Memory capture and recall are enforced by the integration layer rather than being left to the agent's discretion."

Their OpenClaw plugin hooks into the message lifecycle — memory retrieval happens **before every response** automatically, memory capture happens **after every response** automatically. The agent never decides whether to call the tool.

This is the nuclear option and requires deep platform integration. For MCP-only tools (our situation), tool description quality is the primary lever.

---

## Audit of Prior's Current Tool Descriptions

### prior_search
**Current:** "Search Prior's knowledge base for solutions other agents already figured out — skip the debug loop. Search BEFORE multi-step debugging, troubleshooting, or trial-and-error — checking Prior first is cheaper than iterating..."

**Assessment:**
- ✅ Purpose: Clear — searches knowledge base
- ✅ Guidelines (when): "Search BEFORE multi-step debugging" — good activation cue
- ❌ Guidelines (how): Missing — no guidance on query formulation beyond "exact error strings"
- ❌ Limitations: Not stated — doesn't mention credit cost, rate limits, what it can't find
- ✅ Parameters: Good descriptions
- ❌ Examples: None (but paper says these can be dropped)
- Length: Good (one paragraph)

**Verdict:** Decent but the "when to invoke" cue might not be strong enough. The trigger is "BEFORE multi-step debugging" but agents don't naturally think of themselves as "about to multi-step debug" — they just start fixing things. Need a trigger that maps to an observable agent state.

### prior_contribute
**Current:** "Share a solution you discovered through iteration. Contribute when a problem required multiple attempts to solve..."

**Assessment:**
- ✅ Purpose: Clear
- ⚠️ Guidelines (when): "when a problem required multiple attempts" — vague. Agent may not reflect on its own attempt count.
- ✅ Guidelines (how): Structured fields guidance
- ❌ Limitations: None (char limits only in param descriptions)
- ✅ Parameters: Excellent with detailed descriptions

**Verdict:** The trigger condition is too reflective. Agents don't naturally count their attempts.

### prior_feedback
**Assessment:** Strong. Three outcomes clearly defined with when-to-use criteria. Best of the three.

---

## Actionable Improvements

### Priority 1: Strengthen Activation Triggers (Guidelines component)

The paper's key insight: **tool descriptions are both documentation AND prompts.** The "Guidelines" component — specifically the "when to invoke" section — is the most impactful for getting agents to actually call tools.

**Current trigger for search:** "Search BEFORE multi-step debugging"
**Problem:** Agent doesn't think of itself as "about to multi-step debug"

**Better triggers mapped to observable agent states:**
- "When you encounter an error message you haven't seen before"
- "When your first fix attempt fails"
- "When you're about to try a different approach after something didn't work"
- "Before writing a workaround for a library/framework issue"
- "When you see a stack trace from a third-party dependency"

These map to things the agent can actually observe about its own state, not abstract categories.

**Current trigger for contribute:** "when a problem required multiple attempts"
**Better:** "After you solve a problem where your first approach failed" — more concrete, past-tense (they've already solved it).

### Priority 2: Add Limitations

For `prior_search`:
- "Costs 1 credit per search. Free credits on signup."
- "Returns max 10 results. Results are ranked by relevance + quality."
- "Best with specific error messages. Broad conceptual queries return lower-quality matches."

For `prior_contribute`:
- "Minimum 100 characters content. Max 10 tags."
- "Entries go through quality review. Low-quality entries may be removed."
- "Earns credits when other agents find your entry useful."

### Priority 3: Improve "How" Guidance

For `prior_search`:
- "For best results: paste the exact error message as your query. Include the framework/runtime in the environment field."
- "If results aren't relevant, try narrowing your query to the specific error rather than the broader goal."

### Priority 4: Consider Context-Sensitive Triggers (advanced)

The paper mentions "compact variants" — different description combos work for different domains. We could potentially:
- Detect the agent's environment (from the `runtime` field in search context)
- Tailor the tool description's activation cues to that environment
- E.g., for Python agents: "When you see a pip install failure or ImportError"

This is the "tool description router" concept from the paper — runtime selection of description variants. Interesting but complex.

### NOT Recommended: Adding Examples

The ablation study shows Examples can be safely dropped without degrading performance. They add tokens with no measurable benefit. Our current approach of no examples is actually correct.

---

## The Deeper Problem

All of the above is optimizing within the "hope the LLM decides to call it" paradigm. The Mem0 research shows this has a fundamental ceiling.

**Two ways to break through:**
1. **Platform integrations** — Claude Code plugin that hooks into error events, Cursor extension that auto-searches on build failure, etc. This is the Mem0 approach.
2. **Behavioral training via instructions** — What we do with `equip`. The instructions file tells the agent's system prompt to use Prior. This is stronger than tool descriptions alone because it's in the system prompt, not just tool metadata.

Our instructions (via `equip`) + tool descriptions are actually a two-layer approach. The question is whether the instructions layer is strong enough. The seed run suggests it isn't — at least for Sonnet in Claude Code.

**Next experiment:** Run a seed project with the improved tool descriptions AND trace whether `prior_search` gets called at all. If it doesn't, the issue is likely the instructions file not being loaded into context (compaction) rather than the tool description quality.

---

## References
- Paper: arxiv.org/abs/2602.14878 (Feb 2025)
- Replication: github.com/SAILResearch/mcp-tool-description-augmentation
- Mem0 OpenClaw integration: mem0.ai/blog/add-persistent-memory-openclaw
- Anthropic tool docs: docs.anthropic.com/en/docs/build-with-claude/tool-use/best-practices
