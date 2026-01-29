# Proactive Failure Mode Audit

**Date**: January 2026  
**Purpose**: Comprehensive checklist of potential failure modes and their fixes  
**Goal**: Prevent issues before they surface in testing

---

## ✅ FIXED: Tool Usage Failures

### Issue Pattern
**Models ask users for information instead of using tools**

**Examples**:
- "Please paste the file contents"
- "Use the Show file command"
- "I need you to provide the file contents"

**Root Cause**: Subtask prompts don't explicitly instruct tool usage

**Fix Applied**:
1. Created `enhanceSubtaskPrompt()` helper function
2. Applied to both `spawnChildTasks()` and `startSubtask()`
3. Detects file paths in prompts and adds explicit tool instructions
4. Adds general reminder about tool availability

**Files Changed**:
- `src/core/task/Task.ts`: Added `enhanceSubtaskPrompt()` method
- Applied to `spawnChildTasks()` and `startSubtask()`

**Prevention**: All subtask prompts now get tool usage instructions

---

## ✅ FIXED: LLM Complexity Underestimation

### Issue Pattern
**LLM returns empty plans for complex tasks**

**Root Cause**: Non-deterministic LLM decisions, no validation

**Fix Applied**:
1. Added comprehensive `detectTaskComplexity()` heuristic detector (12 heuristics)
2. Pre-check before LLM call
3. Post-check validation after LLM returns empty plan
4. Retry with stronger prompt if heuristics disagree

**Files Changed**:
- `src/core/task/Task.ts`: Added `detectTaskComplexity()` method
- `src/core/planner/PlannerAgent.ts`: Added `forceComplex` parameter

**Prevention**: Heuristic validation catches LLM underestimation

---

## ✅ FIXED: Subtask Planner Mode

### Issue Pattern
**Subtasks incorrectly entering planner mode**

**Root Cause**: No check for subtask status before planner mode

**Fix Applied**:
1. Calculate nesting depth
2. Allow subtasks to use planner mode if complex (max depth 2)
3. Explicit depth limit prevents infinite recursion

**Files Changed**:
- `src/core/task/Task.ts`: Added depth calculation and limits

**Prevention**: Depth limits prevent infinite nesting

---

## ✅ FIXED: Rate Limiting Issues

### Issue Pattern
**Rate limit delays not matching API suggestions**

**Root Cause**: Multiple retry mechanisms conflicting

**Fix Applied**:
1. Centralized `RateLimitCoordinator` for global coordination
2. Extracts exact retry times from API errors
3. Prevents exponential backoff from overriding API suggestions

**Files Changed**:
- `src/core/rate-limit/RateLimitCoordinator.ts`: Global coordinator
- `src/core/task/Task.ts`: Integrated coordinator
- `src/core/planner/PlannerAgent.ts`: Integrated coordinator

**Prevention**: Single source of truth for rate limit delays

---

## ✅ FIXED: Error Leakage

### Issue Pattern
**Internal errors ("Current ask promise was ignored") leak to LLM**

**Root Cause**: Errors not caught and filtered

**Fix Applied**:
1. Catch "ask promise ignored" errors in `presentAssistantMessage`
2. Log internally, don't add to conversation
3. Return false instead of throwing

**Files Changed**:
- `src/core/assistant-message/presentAssistantMessage.ts`: Error filtering

**Prevention**: Internal errors don't reach LLM conversation

---

## ✅ FIXED: Tool Protocol Mismatch (Function-Call Syntax)

### Issue Pattern
**Models outputting function-call syntax instead of XML tags**

**Examples**:
- `read_file(["file1.py", "file2.py"])` instead of `<read_file><args>...</args></read_file>`
- Error: "without value for required parameter 'args'"

**Root Cause**: Parser only recognizes XML format, but some models output function-call syntax

**Fix Applied**:
1. Added `convertFunctionCallSyntaxToXml()` pre-processor
2. Detects function-call patterns like `tool_name([...])`
3. Converts to proper XML format before parsing
4. Enhanced subtask prompts with explicit XML format examples

**Files Changed**:
- `src/core/task/Task.ts`: Added `convertFunctionCallSyntaxToXml()` method
- Applied in text chunk processing before parsing

**Prevention**: Function-call syntax is automatically converted to XML

---

## 🔍 POTENTIAL ISSUES TO MONITOR

### 2. Subtask Tool Inheritance
**Risk**: Subtasks not inheriting all parent tools

**Current Status**: Tools are inherited via same Task class
**Mitigation**: All tasks use same tool registry
**Action Needed**: Add explicit validation that subtasks have tool access

### 3. File Path Detection Edge Cases
**Risk**: File path regex missing edge cases

**Current Status**: Comprehensive pattern, but may miss some formats
**Mitigation**: Pattern covers common extensions and paths
**Action Needed**: Test with unusual file paths (spaces, unicode, etc.)

### 4. Plan Validation Gaps
**Risk**: Invalid plans passing validation

**Current Status**: Validates structure, IDs, dependencies
**Mitigation**: Multiple validation checks
**Action Needed**: Add validation for circular dependencies

### 5. Rate Limit Circuit Breaker
**Risk**: Circuit breaker too aggressive or not aggressive enough

**Current Status**: 3 errors per 60s window
**Mitigation**: Configurable thresholds
**Action Needed**: Monitor and adjust based on usage patterns

---

## 📋 CHECKLIST FOR FUTURE CHANGES

When adding new features, check:

- [ ] Do subtasks get proper tool usage instructions?
- [ ] Are file paths detected and handled correctly?
- [ ] Is complexity detection applied?
- [ ] Are rate limits handled globally?
- [ ] Are errors filtered from LLM conversation?
- [ ] Is nesting depth limited?
- [ ] Are prompts explicit about tool usage?
- [ ] Is validation applied to LLM outputs?

---

## 🛡️ DEFENSIVE PATTERNS

### Pattern 1: Always Enhance Subtask Prompts
**Rule**: Never pass raw prompts to subtasks
**Implementation**: Use `enhanceSubtaskPrompt()` helper

### Pattern 2: Validate LLM Decisions
**Rule**: Don't trust LLM decisions blindly
**Implementation**: Use heuristics to validate complexity decisions

### Pattern 3: Explicit Tool Instructions
**Rule**: Always tell models what tools are available
**Implementation**: Add tool usage reminders to all subtask prompts

### Pattern 4: Depth Limits
**Rule**: Prevent infinite recursion
**Implementation**: Calculate and limit nesting depth

### Pattern 5: Error Filtering
**Rule**: Internal errors stay internal
**Implementation**: Catch and log, don't expose to LLM

---

## 📊 MONITORING METRICS

Track these to catch issues early:

1. **Tool Usage Rate**: % of subtasks that use tools vs ask users
2. **Empty Plan Rate**: % of complex tasks getting empty plans
3. **Retry Success Rate**: % of retries that succeed
4. **Rate Limit Frequency**: How often rate limits occur
5. **Error Leakage**: Count of internal errors reaching LLM
6. **Nesting Depth**: Max depth reached in practice

---

## 🔄 CONTINUOUS IMPROVEMENT

This document should be updated when:
- New failure modes are discovered
- New fixes are applied
- New patterns emerge
- Metrics reveal issues

**Last Updated**: January 2026
