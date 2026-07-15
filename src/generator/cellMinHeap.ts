export type CellPriority = { index: number; priority: number };

export class CellMinHeap {
  private items: CellPriority[] = [];

  push(item: CellPriority): void {
    let cursor = this.items.length;
    this.items.push(item);
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.items[parent].priority <= item.priority) break;
      this.items[cursor] = this.items[parent];
      cursor = parent;
    }
    this.items[cursor] = item;
  }

  pop(): CellPriority | undefined {
    if (this.items.length === 0) return undefined;
    const root = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      let cursor = 0;
      while (true) {
        const left = cursor * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child =
          right < this.items.length &&
          this.items[right].priority < this.items[left].priority
            ? right
            : left;
        if (this.items[child].priority >= last.priority) break;
        this.items[cursor] = this.items[child];
        cursor = child;
      }
      this.items[cursor] = last;
    }
    return root;
  }

  get length(): number {
    return this.items.length;
  }
}
