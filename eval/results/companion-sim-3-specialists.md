# Companion simulation: specialists (2026-11-14, groq first)

Tier **T2**: the real app on Linux (Xvfb) with a real model (Groq, falling back to Gemini/OpenRouter on free tiers), driven through ordinary companion use. Checks are automatic; every reply is also listed for reading.

**6 of 6 turns without a detected problem.** App errors: 1 main-process, 0 chat window.

| # | You said | Time to first reply | Problems |
|---|---|---|---|
| 1 | @Forge draft a short README.md for a tiny todo-list app | 0.4 s | — |
| 2 | @Sentinel review this function for bugs: function add(a, b) { return a - b; } | 0.4 s | — |
| 3 | @Scout compare Python and JavaScript for a complete beginner | 2.5 s | — |
| 4 | /stop @Scout | 0.3 s | — |
| 5 | hi COre, are you still with me? | 5.5 s | — |
| 6 | which specialists do you have? | 2.5 s | — |

## Replies

**1. @Forge draft a short README.md for a tiny todo-list app**

```
Forge

Forge (Builder) split off from COre.
Forge
Builder
Tiny Todo List App

A minimalistic todo list app that lets you add, complete, and delete tasks with a clean interface.

Features
Add tasks
Mark tasks as completed
Delete tasks
Persist tasks in local storage
Installation
git clone https://github.com/yourusername/tiny-todo.git
cd tiny-todo
npm install
npm start
Usage
Open http://localhost:3000 in a browser.
Type a task and press Enter to add it.
Click the checkbox to mark it as done.
Click the trash icon to remove it.
License

MIT © Your Name
```

**2. @Sentinel review this function for bugs: function add(a, b) { return a - b; }**

```
Sentinel

Sentinel (QA) split off from COre.
Sentinel
QA
Review: add function

The function as written is logically incorrect and fails to perform its namesake operation.

1. Logic Error

Problem: The function uses the subtraction operator (-) instead of the addition operator (+).
Reproduction: Calling add(5, 3) returns 2 instead of the expected 8.
Fix: Change the return statement to use the + operator.

2. Type Safety (Edge Case)

Problem: There is no validation for the inputs a and b. In JavaScript, passing strings or objects may lead to unexpected results, though standard addition will perform string concatenation if one operand is a string.
Fix: Consider type-checking or coercing inputs if this is used in a sensitive context.

Proposed Fix:

function add(a, b) {
  return a + b;
}

Verdict: fix first
```

**3. @Scout compare Python and JavaScript for a complete beginner**

```
Scout
compare Python and JavaScript for a complete beginner
Scout (Research) split off from COre.
```

**4. /stop @Scout**

```
Stopped Scout.
```

**5. hi COre, are you still with me?**

```
Right. I'm still here.

Forge drafted that README for your tiny todo app, and Sentinel caught the subtraction bug in your add function — bold choice for a calculator, indeed. Both pieces of work are waiting in the shared chat if you need them.

What's next?
```

**6. which specialists do you have?**

```
I have three specialist cores that can split off and work in parallel:

Scout — research and comparison. Finds information, compares options, digests docs, summarizes.

Forge — building and drafting. Writes code, drafts docs, creates specs, scaffolds projects.

Sentinel — review and problem-finding. Code review, bug hunting, security checks, logic audits.

You can ask me to delegate a task to one of them, or I'll pick the right one when the work fits. They drop their results in the shared chat for you to see.
```

## Main-process errors

```
[4965:1114/134243.760655:ERROR:net/socket/ssl_client_socket_impl.cc:949] handshake failed; returned -1, SSL error code 1, net_error -202
```
