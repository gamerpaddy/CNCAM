// Command-pattern undo stack. A command is { label, do(), undo() }.

export class UndoStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.done = [];
    this.undone = [];
  }

  // Bookkeeping happens *before* the command runs, because running it is what
  // notifies the rest of the app. Moving the entry between the stacks
  // afterwards meant every listener saw the state as it was one step ago — so
  // the Redo button stayed greyed out immediately after an undo, and only came
  // alive on the next unrelated edit.

  push(command) {
    this.done.push(command);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
    command.do();
  }

  undo() {
    const cmd = this.done.pop();
    if (!cmd) return false;
    this.undone.push(cmd);
    cmd.undo();
    return true;
  }

  redo() {
    const cmd = this.undone.pop();
    if (!cmd) return false;
    this.done.push(cmd);
    cmd.do();
    return true;
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  get undoLabel() { return this.done.at(-1)?.label ?? null; }
  get redoLabel() { return this.undone.at(-1)?.label ?? null; }
}
