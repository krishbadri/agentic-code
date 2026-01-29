# Root Cause Analysis: Why LLM Mistakes Happen

## The Core Problem

**LLMs are non-deterministic, training-biased systems that don't "know" what tools they have - they only know what we tell them in prompts.**

## Where Mistakes Come From

### 1. **Training Data Bias (PRIMARY CAUSE)**

**The Problem:**
- OpenAI models (gpt-4.1, codex mini, etc.) are trained on **millions of examples** where function-call syntax is standard:
  - `read_file(["path"])`
  - `search_files({path: ".", regex: ".*"})`
- This is what OpenAI's native function calling uses
- Even though we tell them "use XML", their training data **heavily favors** function-call syntax

**Evidence:**
- Models consistently output `read_file(["path"])` despite explicit XML instructions
- The `convertFunctionCallSyntaxToXml()` converter exists specifically because this happens so often

**Why It's Hard to Fix:**
- We can't retrain the model
- We can only work around it with:
  - Stronger prompts (which we've done)
  - Syntax converters (which we've added)
  - Error feedback loops (which we've implemented)

### 2. **System Prompt Length & Position**

**The Problem:**
- System prompt is **VERY long** (~2000+ lines):
  1. Role definition
  2. Markdown rules
  3. Tool use section (XML warning is here)
  4. Tool descriptions (read_file, search_files, etc.)
  5. Tool use guidelines
  6. MCP servers section
  7. Capabilities section
  8. Modes section
  9. Rules section
  10. System info
  11. Objective section
  12. Custom instructions

- The XML format warning appears **early** (line ~95 in system prompt)
- But there are **10+ more sections** after it
- Models have limited attention span - they might "forget" early instructions

**Why It's Hard to Fix:**
- We need all those sections for the system to work
- Can't shorten without losing functionality
- Can only repeat warnings (which we do in multiple places)

### 3. **Context Window Decay**

**The Problem:**
- As conversation gets longer, the system prompt (at the beginning) becomes less "active" in the model's attention
- Models prioritize **recent messages** over old ones
- After 20+ turns, the model might barely "see" the system prompt

**Why It's Hard to Fix:**
- This is fundamental to how transformers work
- We can't force the model to pay attention to old content
- We can only:
  - Remind via error messages (which we do)
  - Re-inject instructions in subtask prompts (which we do)

### 4. **Strict XML Parsing**

**The Problem:**
- Our parser (`parseAssistantMessage`) is **very strict**:
  - Only recognizes exact tool names: `read_file`, `search_files`, etc.
  - Requires perfect XML structure: `<read_file><args><file><path>...</path></file></args></read_file>`
  - If model outputs `<read_file>` without closing tag → parsed as **text**, not tool
  - If model outputs `<readFile>` (wrong case) → parsed as **text**, not tool
  - If model outputs `<read_file><path>...</path></read_file>` (missing `<args>` wrapper) → parsed as **text**

**Why It's Hard to Fix:**
- We need strict parsing to avoid false positives
- But strict parsing means **any small mistake** = no tool detected = error message

### 5. **Error Feedback Loop**

**The Problem:**
- When model makes a mistake:
  1. No tool detected → we send `formatResponse.noToolsUsed()`
  2. Model sees error → tries again
  3. If model is already confused → might make same mistake
  4. Loop continues until `consecutiveMistakeCount` limit

**Why It's Hard to Fix:**
- Error messages help, but if model is in a "failure state", they might not help
- We've added "giving up" detection to break loops, but it's reactive, not proactive

### 6. **Model Capability Limits**

**The Problem:**
- Some models (gpt-4.1, codex mini) are **not as good** at following complex instructions as others
- They might:
  - Miss subtle instructions
  - Get confused by conflicting signals
  - Give up when they encounter errors

**Why It's Hard to Fix:**
- We can't change the model's capabilities
- We can only:
  - Use better models (user's choice)
  - Simplify instructions (but we need complexity for the system to work)

### 7. **Subtask Prompt Inheritance Issues**

**The Problem:**
- Subtasks get enhanced prompts with "CRITICAL INSTRUCTIONS"
- But if the parent task already failed, the subtask might inherit confusion
- Subtask might not "see" the enhanced instructions if they're buried in a long prompt

**Why It's Hard to Fix:**
- We've made `enhanceSubtaskPrompt()` unconditional
- But if the model is already confused, more instructions might not help

### 8. **Non-Deterministic Behavior**

**The Problem:**
- LLMs are **stochastic** (random)
- Even with perfect prompts, they sometimes make mistakes
- Same prompt → different outputs on different runs

**Why It's Hard to Fix:**
- This is fundamental to how LLMs work
- We can only:
  - Retry with same prompt (which we do)
  - Retry with stronger prompt (which we do via `forceComplex`)
  - Accept that some mistakes are inevitable

## What We've Already Done

1. ✅ **Strong XML format warnings** in system prompt
2. ✅ **Tool-specific XML examples** in each tool description
3. ✅ **Function-call to XML converter** (`convertFunctionCallSyntaxToXml`)
4. ✅ **Enhanced subtask prompts** with unconditional tool instructions
5. ✅ **"Giving up" text detection** to break failure loops
6. ✅ **Tool-specific error messages** with detailed XML fix guidance
7. ✅ **Agent-specific prompts** reinforcing tool usage
8. ✅ **Error message improvements** with actionable feedback

## Why Mistakes Still Happen

**Despite all our fixes, mistakes happen because:**

1. **Training bias is too strong** - Models are fundamentally trained on function-call syntax
2. **System prompt is too long** - XML warning gets "lost" in 2000+ lines
3. **Context decay** - Long conversations make system prompt less "active"
4. **Strict parsing** - Any small mistake = no tool detected
5. **Non-deterministic** - Even perfect prompts sometimes fail
6. **Model limitations** - Some models just aren't good enough

## The Fundamental Issue

**We're fighting against the model's training data.**

- Models are trained to use function-call syntax
- We're asking them to use XML syntax instead
- This is a **mismatch** between training and requirements
- We can mitigate it, but we can't eliminate it

## What We Can Do (Future Improvements)

1. **Move XML warning to TOP of system prompt** (before role definition)
2. **Repeat XML warning in EVERY tool description** (we do this)
3. **Add XML examples to EVERY error message** (we do this)
4. **Make parser more lenient** (risky - might cause false positives)
5. **Use better models** (user's choice - we can't force this)
6. **Add "tool call validator"** that checks format before parsing
7. **Implement "tool call repair"** that fixes common mistakes automatically

## Conclusion

**Mistakes happen because:**
- Models are trained on function-call syntax (we use XML)
- System prompts are long (XML warning gets lost)
- Models are non-deterministic (sometimes they just fail)
- Parsing is strict (small mistakes = no tool detected)

**We've done a lot to mitigate this, but we can't eliminate it entirely because it's a fundamental mismatch between model training and our requirements.**
