# COre 12.0.0

COre becomes a desktop operator: it sees what is on your screen, remembers your projects through your Cortex
knowledge vault, notices what needs you, and works your apps one approved step at a time. Everything new is off
or asks first.

## Install

- **Windows:** download `COre-Setup-12.0.0.exe` and run it. Windows may warn that the installer is unsigned:
  choose *More info* → *Run anyway*.
- Checksums are in `SHA256SUMS.txt`.

## What's new

- **Long-term memory with Cortex:** connect your Cortex vault (Settings → Privacy). Decisions, lessons and
  research go there; preferences stay in COre. If Cortex is offline, notes wait and are delivered later.
- **Set up for you:** on first start COre creates your knowledge vault and adds it to Obsidian automatically (no
  account or key). No Obsidian yet? Type `/vault obsidian`. Share it with other devices for free using Syncthing.
- **Open in Obsidian:** your vault is plain Markdown. `/obsidian` opens it, `/obsidian Projects/X.md` opens a note.
- **Knows what you're working on:** "what am I working on?" reads your open windows and dialogs, recalls the
  project from both memories, and says where each fact came from. It won't invent windows it can't see.
- **Smarter desktop agent:** reads real controls through Windows UI Automation, plans first, checks the result,
  and knows how common apps (Excel, Word, LibreOffice Calc, Explorer, browsers, VS Code, Archicad) work best.
- **Suggestions:** `/suggest` lists unfinished tasks, overdue to-dos from Cortex and automations that failed.
  Nothing runs until you choose.
- **Safer commands:** on Windows, commands run in a locked-down sandbox that can only touch folders you allow.
- **Free AI that works out of the box:** Gemini, Groq and OpenRouter keys are enough; COre picks a current model by
  itself and switches if one is retired or busy. `/diagnostics` shows how each brain is doing.

## Known limits

- The installer is unsigned.
- Some apps (LibreOffice on a machine without accessibility tools) show COre no controls; it then uses the
  keyboard and checks the saved file.
- Injection detection is a warning only; the real protection is that every action needs your approval.
