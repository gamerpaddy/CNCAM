// Command-pattern undo stack. A command is { label, do(), undo() }.

export class UndoStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.done = [];
    this.undone = [];
    // While a group is open, commands are collected here instead of being
    // recorded one by one. See `group`.
    this.collecting = null;
  }

  // Bookkeeping happens *before* the command runs, because running it is what
  // notifies the rest of the app. Moving the entry between the stacks
  // afterwards meant every listener saw the state as it was one step ago — so
  // the Redo button stayed greyed out immediately after an undo, and only came
  // alive on the next unrelated edit.

  push(command) {
    if (this.collecting) { this.collecting.push(command); command.do(); return; }
    this.done.push(command);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
    command.do();
  }

  /**
   * Record everything `fn` does as one undoable step.
   *
   * One gesture is one undo. An action that writes two things — assigning a
   * cutter, which sets the tool and then moves the stepping that was the old
   * cutter's — pushed two commands, so Ctrl+Z left the operation holding the
   * new tool with the old tool's stepping: exactly the state the action exists
   * to prevent, reachable by undoing it once.
   *
   * The commands still run as they are pushed; what changes is only how they
   * are recorded, so nothing inside `fn` has to know it is in a group. A
   * group that ends up holding one command records that command, not a wrapper
   * around it, and one that collects nothing records nothing.
   */
  group(label, fn) {
    if (this.collecting) return fn();   // a nested group joins the outer one
    const batch = [];
    this.collecting = batch;
    try { fn(); } finally { this.collecting = null; }
    if (batch.length === 0) return undefined;
    const command = batch.length === 1 ? batch[0] : {
      label: label ?? batch[0].label,
      do: () => { for (const c of batch) c.do(); },
      undo: () => { for (let i = batch.length - 1; i >= 0; i--) batch[i].undo(); },
    };
    // already run, so it is recorded rather than pushed
    this.done.push(command);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
    return undefined;
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
